// Pure validation and spam-guard rules for a lead posted by the form.
// Included into the "Validate & spam guard" Code node and unit tested directly.

const LEAD_OPTIONS = {
  service: ['New website', 'Website redesign', 'SEO & content', 'Automation & integrations', 'Not sure yet'],
  budget: ['Under $2k', '$2k–5k', '$5k–15k', '$15k–50k', '$50k+'],
  timeline: ['As soon as possible', 'Within 1 month', '1–3 months', '3+ months', 'Just exploring'],
  simulate: ['none', 'crm_outage', 'ai_invalid'],
};

const DISPOSABLE_DOMAINS = [
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com',
  'temp-mail.org', 'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com',
  'maildrop.cc', 'throwawaymail.com', 'fakeinbox.com', 'mintemail.com',
];

const MIN_FILL_MS = 3000;
const URL_RE = /(https?:\/\/|www\.)\S+/gi;

function cleanText(v) {
  return typeof v === 'string' ? v.replace(/\u0000/g, '').trim() : '';
}

/**
 * Returns one of:
 *   { kind: 'spam', reason }
 *   { kind: 'invalid', fields: { field: message } }
 *   { kind: 'ok', lead }
 */
function validateLead(body, nowMs) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { kind: 'invalid', fields: { form: 'The request body must be a JSON object.' } };
  }

  // --- spam guard first: bots get a clear 422, people never see it
  if (cleanText(body.fax) !== '') return { kind: 'spam', reason: 'A hidden field that only bots fill in was filled in.' };
  const started = Number(body.started_at);
  if (!Number.isFinite(started) || started <= 0) {
    return { kind: 'spam', reason: 'The form timing token is missing. Please reload the page and try again.' };
  }
  const elapsed = nowMs - started;
  if (elapsed < MIN_FILL_MS) {
    const secs = Math.max(0, elapsed / 1000).toFixed(1);
    return { kind: 'spam', reason: `The form was sent ${secs} s after the page loaded. People need at least 3 s; that speed looks automated.` };
  }

  const fields = {};
  const name = cleanText(body.name).replace(/\s+/g, ' ');
  const email = cleanText(body.email).toLowerCase();
  const company = cleanText(body.company).replace(/\s+/g, ' ');
  const website = cleanText(body.website);
  const message = cleanText(body.message).replace(/\r\n/g, '\n');
  const pick = (k) => (LEAD_OPTIONS[k].includes(body[k]) ? body[k] : null);

  if (name.length < 2 || name.length > 80) fields.name = 'Please enter your name (2–80 characters).';
  else if (/[<>]|https?:|www\./i.test(name)) fields.name = 'Names cannot contain links or angle brackets.';

  if (email.length > 254 || !/^[^\s@<>,;:"'()]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(email)) {
    fields.email = 'Please enter a valid email address.';
  } else if (DISPOSABLE_DOMAINS.includes(email.split('@')[1])) {
    fields.email = 'Please use an email address you can check; disposable inboxes are blocked.';
  }

  if (company.length < 1 || company.length > 120) fields.company = 'Please enter your company (1–120 characters).';
  else if (/[<>]|https?:|www\./i.test(company)) fields.company = 'Company names cannot contain links or angle brackets.';

  if (website.length > 200) fields.website = 'Website must be at most 200 characters.';
  else if (website && !/^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(website)) {
    fields.website = 'That does not look like a website address (example: example.com).';
  }

  const service = pick('service');
  const budget = pick('budget');
  const timeline = pick('timeline');
  if (!service) fields.service = 'Please choose a service.';
  if (!budget) fields.budget = 'Please choose a budget range.';
  if (!timeline) fields.timeline = 'Please choose a timeline.';

  if (message.length < 20 || message.length > 1500) fields.message = 'Please describe the project in 20–1500 characters.';
  if (body.consent !== true) fields.consent = 'Please tick the box to agree to the demo terms.';

  const simulate = body.simulate === undefined || body.simulate === null || body.simulate === '' ? 'none' : body.simulate;
  if (!LEAD_OPTIONS.simulate.includes(simulate)) fields.simulate = 'Unknown simulation option.';

  if (Object.keys(fields).length) return { kind: 'invalid', fields };

  const links = (message.match(URL_RE) || []).length;
  if (links > 2) return { kind: 'spam', reason: `The message contains ${links} links. Lead forms that carry several links are almost always spam.` };

  const parts = name.split(' ');
  return {
    kind: 'ok',
    lead: {
      name,
      first_name: parts[0],
      last_name: parts.slice(1).join(' '),
      email,
      company,
      website,
      service,
      budget,
      timeline,
      message,
      simulate,
      fill_seconds: Math.round(elapsed / 100) / 10,
    },
  };
}

/** a.b@example.com -> a••@example.com */
function maskEmail(email) {
  const [local, domain] = String(email).split('@');
  if (!domain) return '';
  return `${local.slice(0, Math.min(2, local.length))}••@${domain}`;
}

/** UTC day key, e.g. 2026-11-08 */
function dayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Rate limits, from rows of the leads table that match this email hash or today's day key.
 * rows: [{ email_hash, day, createdAt }]
 */
function checkLimits(rows, { emailHash, nowMs, dailyCap }) {
  const today = dayKey(nowMs);
  const mine = rows.filter((r) => r && r.email_hash === emailHash);
  const recent = mine
    .map((r) => Date.parse(r.createdAt))
    .filter((t) => Number.isFinite(t) && nowMs - t < 24 * 3600e3)
    .sort((a, b) => b - a);
  const COOLDOWN_MS = 5 * 60e3;
  if (recent.length && nowMs - recent[0] < COOLDOWN_MS) {
    return { ok: false, error: 'rate_limited', retry_after_s: Math.ceil((COOLDOWN_MS - (nowMs - recent[0])) / 1000) };
  }
  if (recent.length >= 3) {
    return { ok: false, error: 'rate_limited', retry_after_s: Math.ceil((recent[2] + 24 * 3600e3 - nowMs) / 1000) };
  }
  const todayCount = rows.filter((r) => r && r.day === today).length;
  if (todayCount >= dailyCap) return { ok: false, error: 'daily_cap' };
  return { ok: true };
}
