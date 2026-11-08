// Turns the rows of the lead_events table into the public status shown on the status page.
// Only what is safe to show the submitter goes out: no full email, no message, no keys.

const STEPS = [
  ['received', 'Form received'],
  ['validated', 'Validation & spam guard'],
  ['qualified', 'AI qualification'],
  ['crm_contact', 'HubSpot contact'],
  ['crm_note', 'HubSpot note'],
  ['reply_email', 'Email reply to you'],
  ['team_alert', 'Team alert'],
  ['done', 'Done'],
];
const STALL_MS = 90_000;

function parseDetail(s) {
  if (s === null || s === undefined || s === '') return null;
  if (typeof s === 'object') return s;
  try {
    return JSON.parse(s);
  } catch {
    return { note: String(s).slice(0, 300) };
  }
}

function buildStatus(rows, nowMs) {
  const events = (rows || [])
    .filter((r) => r && r.step && r.createdAt)
    .map((r) => ({ ...r, t: Date.parse(r.createdAt) }))
    .sort((a, b) => a.t - b.t || (a.id ?? 0) - (b.id ?? 0));
  if (!events.length) return null;

  const first = events[0];
  const byStep = {};
  for (const e of events) (byStep[e.step] ??= []).push(e);

  const received = parseDetail((byStep.received || [first])[0].detail) || {};
  const doneEvent = (byStep.done || [])[0];
  const finished = Boolean(doneEvent);
  const last = events[events.length - 1];
  const stalled = !finished && nowMs - last.t > STALL_MS;

  let qualification = null;
  let runningAssigned = false;
  const steps = STEPS.map(([key, label]) => {
    const list = byStep[key] || [];
    const final = [...list].reverse().find((e) => e.state !== 'retrying');
    const retries = list.filter((e) => e.state === 'retrying');
    if (!final) {
      if (retries.length) {
        runningAssigned = true;
        const lastTry = retries[retries.length - 1];
        return {
          key, label, state: finished || stalled ? 'failed' : 'running', at: lastTry.createdAt,
          summary: `Attempt ${retries.length} failed (${lastTry.summary}). Retrying…`,
          detail: { attempts: retries.map((r, i) => ({ attempt: i + 1, at: r.createdAt, result: r.summary })) },
        };
      }
      const state = !finished && !stalled && !runningAssigned ? 'running' : finished ? 'skipped' : 'pending';
      if (state === 'running') runningAssigned = true;
      return { key, label, state, at: null, summary: state === 'running' ? 'Working on it…' : '', detail: null };
    }
    let detail = parseDetail(final.detail);
    if (retries.length) {
      detail = { ...(detail || {}), attempts: retries.map((r, i) => ({ attempt: i + 1, at: r.createdAt, result: r.summary })) };
    }
    if (key === 'qualified' && detail) {
      qualification = {
        score: detail.score, tier: detail.tier, reason: detail.reason, scored_by: detail.scored_by,
        ...(detail.fallback_reason ? { fallback_reason: detail.fallback_reason } : {}),
      };
    }
    return { key, label, state: final.state, at: final.createdAt, summary: final.summary || '', detail };
  });

  const doneDetail = doneEvent ? parseDetail(doneEvent.detail) || {} : {};
  return {
    lead_id: first.lead_id,
    created_at: first.createdAt,
    finished,
    outcome: finished ? doneDetail.outcome || 'ok' : null,
    stalled,
    lead: { first_name: received.first_name || '', company: received.company || '', email_masked: received.email_masked || '' },
    qualification,
    simulated: received.simulate && received.simulate !== 'none' ? [received.simulate] : [],
    steps,
  };
}
