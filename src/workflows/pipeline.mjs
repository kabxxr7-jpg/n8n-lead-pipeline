// Builds the four workflows of the lead pipeline. `npm run build:workflows` writes workflows/*.json.
import fs from "node:fs";
import path from "node:path";
import { Flow, at, CODE_DIR } from "../lib/wfkit.mjs";

const fn = (file) => fs.readFileSync(path.join(CODE_DIR, file), "utf8").trimEnd();
const js = (includes, body) => [...includes.map(fn), body.trim()].join("\n\n");

export const TABLES = {
  leads: { name: "pipeline_leads", columns: ["lead_id", "email_hash", "day", "simulate"] },
  events: { name: "lead_events", columns: ["lead_id", "step", "state", "summary", "detail"] },
};
export const CRED = {
  gemini: { key: "gemini", name: "Gemini API key" },
  hubspot: { key: "hubspot", name: "HubSpot private app" },
  resend: { key: "resend", name: "Resend API key" },
};
// placeholder ids; scripts/setup.mjs swaps in the real credential ids at upload
const credRef = (c) => ({ httpHeaderAuth: { id: `__CRED_${c.key.toUpperCase()}__`, name: c.name } });

const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000 };
const V = "$('Validate & spam guard').first().json";

// ------------------------------------------------------------------ helpers

function dataTable(flow, name, parameters, pos, extra = {}) {
  return flow.add(name, "n8n-nodes-base.dataTable", 1.1, { resource: "row", ...parameters }, pos, extra);
}
const tableRef = (t) => ({ __rl: true, mode: "name", value: t.name });

/** Data-table insert of event rows shaped exactly like the lead_events columns. */
function logEvent(flow, name, pos) {
  return dataTable(
    flow,
    name,
    { operation: "insert", dataTableId: tableRef(TABLES.events), columns: { mappingMode: "autoMapInputData", value: {}, matchingColumns: [], schema: [] }, options: {} },
    pos,
  );
}

function stringSchema(cols) {
  return cols.map((c) => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: "string", canBeUsedToMatch: true }));
}

/** Event row helper used inside Code nodes. */
const EVENT_FN = `
function event(lead_id, step, state, summary, detail) {
  return { json: { lead_id, step, state, summary: String(summary).slice(0, 300), detail: detail === undefined ? '' : JSON.stringify(detail) } };
}
function errorText(e) {
  if (!e) return 'unknown error';
  if (typeof e === 'string') return e.slice(0, 200);
  const parts = [e.message, e.description].filter(Boolean).map(String);
  return (parts.join(': ') || JSON.stringify(e)).replace(/\\s+/g, ' ').slice(0, 200);
}`;

// ------------------------------------------------------------------ intake

export function intakeFlow() {
  const f = new Flow("Lead pipeline: intake", { settings: { errorWorkflow: "__ERROR_WORKFLOW_ID__", saveManualExecutions: true } });

  f.webhook("Lead form", { path: "lead-intake", pos: at(0, 2), note: "POST from the public form via the gateway (/api/lead)." });

  f.code(
    "Validate & spam guard",
    js(["validate.fn.js"], `
const crypto = require('crypto');
const nowMs = Date.now();
const r = validateLead($input.first().json.body, nowMs);
if (r.kind !== 'ok') return [{ json: r }];
const email_hash = crypto.createHash('sha256').update(r.lead.email).digest('hex');
return [{ json: {
  kind: 'ok',
  lead: r.lead,
  lead_id: crypto.randomUUID(),
  email_hash,
  day: dayKey(nowMs),
  public_base: ($env.PUBLIC_BASE_URL || '').replace(/\\/$/, ''),
} }];`),
    at(1, 2),
    { note: "Honeypot, minimum fill time, link count, field rules, disposable-email block." },
  );

  f.ifTrue("Spam?", "$json.kind === 'spam'", at(2, 2));
  f.respond("Reject: spam", { code: 422, body: "({ ok: false, error: 'spam_suspected', reason: $json.reason })", pos: at(3, 0) });
  f.ifTrue("Valid?", "$json.kind === 'ok'", at(3, 2));
  f.respond("Reject: invalid", { code: 400, body: "({ ok: false, error: 'invalid', fields: $json.fields })", pos: at(4, 1) });

  dataTable(
    f,
    "Find recent leads",
    {
      operation: "get",
      dataTableId: tableRef(TABLES.leads),
      matchType: "anyCondition",
      filters: {
        conditions: [
          { keyName: "email_hash", condition: "eq", keyValue: "={{ $json.email_hash }}" },
          { keyName: "day", condition: "eq", keyValue: "={{ $json.day }}" },
        ],
      },
      returnAll: true,
    },
    at(4, 3),
    { alwaysOutputData: true, notes: "Same email (any day) or any lead today: feeds the rate limits." },
  );

  f.code(
    "Check limits",
    js(["validate.fn.js"], `
const v = ${V};
const rows = $input.all().map((i) => i.json).filter((r) => r && r.id !== undefined);
return [{ json: checkLimits(rows, { emailHash: v.email_hash, nowMs: Date.now(), dailyCap: Number($env.DAILY_LEAD_CAP || 150) }) }];`),
    at(5, 3),
    { note: "5 min cooldown per email, 3 per email per day, global daily cap." },
  );
  f.ifTrue("Within limits?", "$json.ok === true", at(6, 3));
  f.add(
    "Reject: limit",
    "n8n-nodes-base.respondToWebhook",
    1.5,
    {
      respondWith: "json",
      responseBody: "={{ $json.error === 'daily_cap' ? { ok: false, error: 'daily_cap' } : { ok: false, error: 'rate_limited', retry_after_s: $json.retry_after_s } }}",
      options: { responseCode: "={{ $json.error === 'daily_cap' ? 503 : 429 }}" },
    },
    at(7, 2),
  );

  dataTable(
    f,
    "Save lead",
    {
      operation: "insert",
      dataTableId: tableRef(TABLES.leads),
      columns: {
        mappingMode: "defineBelow",
        value: {
          lead_id: `={{ ${V}.lead_id }}`,
          email_hash: `={{ ${V}.email_hash }}`,
          day: `={{ ${V}.day }}`,
          simulate: `={{ ${V}.lead.simulate }}`,
        },
        matchingColumns: [],
        schema: stringSchema(TABLES.leads.columns),
      },
      options: {},
    },
    at(7, 4),
    { notes: "Only a hash of the email is kept here (for rate limits)." },
  );

  f.code(
    "Event: received",
    js([], `${EVENT_FN}
const v = ${V};
const l = v.lead;
const masked = l.email.split('@')[0].slice(0, 2) + '••@' + l.email.split('@')[1];
return [
  event(v.lead_id, 'received', 'ok', 'Your form reached the n8n webhook.', { first_name: l.first_name, company: l.company, email_masked: masked, simulate: l.simulate }),
  event(v.lead_id, 'validated', 'ok', 'Passed field checks, honeypot, timing (' + l.fill_seconds + ' s to fill), link count and rate limits.', { fill_seconds: l.fill_seconds, service: l.service, budget: l.budget, timeline: l.timeline }),
];`),
    at(8, 4),
  );
  logEvent(f, "Log: received", at(9, 4));
  f.add(
    "Accepted (202)",
    "n8n-nodes-base.respondToWebhook",
    1.5,
    {
      respondWith: "json",
      responseBody: `={{ { ok: true, lead_id: ${V}.lead_id, status_url: '/status?id=' + ${V}.lead_id } }}`,
      options: { responseCode: 202 },
    },
    at(10, 4),
    { executeOnce: true, notes: "Answer the form right away; the rest runs after the response." },
  );

  // --- AI qualification
  f.ifTrue("Simulate broken AI?", `${V}.lead.simulate === 'ai_invalid'`, at(11, 4));
  f.code("Build AI request", js(["qualify.fn.js"], `return [{ json: { request: buildGeminiRequest(${V}.lead) } }];`), at(12, 5));
  f.http("Gemini: qualify lead", {
    method: "POST",
    url: "={{ ($env.GEMINI_BASE || 'https://generativelanguage.googleapis.com') + '/v1beta/models/' + ($env.GEMINI_MODEL || 'gemini-3.5-flash') + ':generateContent' }}",
    json: "$json.request",
    timeout: 20000,
    pos: at(13, 5),
    node: { ...RETRY, onError: "continueErrorOutput", credentials: credRef(CRED.gemini), notes: "Structured output (JSON schema). 3 tries, 2 s apart." },
  });
  f.nodes.at(-1).parameters.authentication = "genericCredentialType";
  f.nodes.at(-1).parameters.genericAuthType = "httpHeaderAuth";
  f.http("Gemini: backup model", {
    method: "POST",
    url: "={{ ($env.GEMINI_BASE || 'https://generativelanguage.googleapis.com') + '/v1beta/models/' + ($env.GEMINI_BACKUP_MODEL || 'gemini-3.5-flash-lite') + ':generateContent' }}",
    json: "$('Build AI request').first().json.request",
    timeout: 20000,
    pos: at(13, 7),
    node: { retryOnFail: true, maxTries: 3, waitBetweenTries: 2000, onError: "continueErrorOutput", credentials: credRef(CRED.gemini), notes: "Second chance on a lighter model when the main one is busy. Then the rules fallback." },
  });
  Object.assign(f.nodes.at(-1).parameters, { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" });
  f.code("Simulated AI answer", js(["qualify.fn.js"], "return [{ json: simulatedBrokenAnswer() }];"), at(13, 3), {
    note: "Only for the 'AI returns broken JSON' demo option.",
  });
  f.code(
    "Check AI answer",
    js(["qualify.fn.js"], `${EVENT_FN}
const v = ${V};
const input = $input.first().json;
const parsed = parseGeminiResponse(input);
let q, summary;
if (parsed.ok) {
  q = { ...parsed.value, scored_by: 'ai', model: parsed.meta.model };
  summary = 'Gemini (' + (q.model || 'model') + ') scored the lead ' + q.score + '/100 (' + q.tier + '). The answer passed the schema check.';
} else {
  q = { ...scoreByRules(v.lead), scored_by: 'rules-fallback', fallback_reason: parsed.problem };
  summary = 'AI answer rejected (' + parsed.problem + '). Scored by the rules fallback: ' + q.score + '/100 (' + q.tier + ').';
}
return [event(v.lead_id, 'qualified', 'ok', summary, q)];`),
    at(14, 4),
    { note: "Strict contract check. Anything off-contract falls back to deterministic rules." },
  );
  logEvent(f, "Log: qualified", at(15, 4));

  // --- HubSpot contact
  f.code(
    "Prepare contact",
    js(["messages.fn.js"], `
const v = ${V};
const outage = v.lead.simulate === 'crm_outage';
const url = outage
  ? ($env.SIM_OUTAGE_URL || 'http://127.0.0.1:5678/webhook/sim-crm-outage') + '?lead_id=' + encodeURIComponent(v.lead_id)
  : ($env.HUBSPOT_BASE || 'https://api.hubapi.com') + '/crm/v3/objects/contacts/batch/upsert';
return [{ json: { url, body: hubspotContactUpsert(v.lead) } }];`),
    at(16, 4),
  );
  f.http("HubSpot: upsert contact", {
    method: "POST",
    url: "={{ $json.url }}",
    json: "$json.body",
    timeout: 15000,
    pos: at(17, 4),
    node: { ...RETRY, onError: "continueErrorOutput", credentials: credRef(CRED.hubspot), notes: "Create or update by email. 3 tries, 2 s apart." },
  });
  Object.assign(f.nodes.at(-1).parameters, { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" });
  f.code(
    "Record contact",
    js([], `${EVENT_FN}
const v = ${V};
const res = $input.first().json;
if (res.error) {
  return [event(v.lead_id, 'crm_contact', 'failed', 'HubSpot did not accept the contact after 3 attempts: ' + errorText(res.error), { attempts: 3, error: errorText(res.error) })];
}
const r = Array.isArray(res.results) ? res.results[0] : null;
if (!r || !r.id) return [event(v.lead_id, 'crm_contact', 'failed', 'HubSpot answered without a contact id.', { error: 'unexpected response' })];
return [event(v.lead_id, 'crm_contact', 'ok', (r.new === false ? 'Existing contact updated' : 'New contact created') + ' in HubSpot (id ' + r.id + ').', { contact_id: String(r.id), created: r.new !== false, lifecycle_stage: 'lead', lead_status: 'NEW' })];`),
    at(18, 4),
  );
  logEvent(f, "Log: contact", at(19, 4));
  f.ifTrue("Contact saved?", "$('Record contact').first().json.state === 'ok'", at(20, 4));

  // --- HubSpot note
  f.code(
    "Prepare note",
    js(["messages.fn.js"], `
const v = ${V};
const q = JSON.parse($('Check AI answer').first().json.detail);
const contactId = JSON.parse($('Record contact').first().json.detail).contact_id;
return [{ json: { body: hubspotNote(v.lead, q, { contactId, leadId: v.lead_id, nowMs: Date.now() }) } }];`),
    at(21, 3),
  );
  f.http("HubSpot: add note", {
    method: "POST",
    url: "={{ ($env.HUBSPOT_BASE || 'https://api.hubapi.com') + '/crm/v3/objects/notes' }}",
    json: "$json.body",
    timeout: 15000,
    pos: at(22, 3),
    node: { ...RETRY, onError: "continueErrorOutput", credentials: credRef(CRED.hubspot), notes: "Note with score, reason, red flags and the brief, linked to the contact." },
  });
  Object.assign(f.nodes.at(-1).parameters, { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" });
  f.code(
    "Record note",
    js([], `${EVENT_FN}
const v = ${V};
const res = $input.first().json;
if (res.error || !res.id) return [event(v.lead_id, 'crm_note', 'failed', 'HubSpot did not save the note: ' + errorText(res.error || 'no id returned'), { error: errorText(res.error || 'no id') })];
return [event(v.lead_id, 'crm_note', 'ok', 'Note with the score, reason and brief attached to the contact (note id ' + res.id + ').', { note_id: String(res.id) })];`),
    at(23, 3),
  );
  f.code(
    "Skip note",
    js([], `${EVENT_FN}
const v = ${V};
return [event(v.lead_id, 'crm_note', 'skipped', 'Skipped: there is no contact to attach a note to. The team alert carries the full details instead.')];`),
    at(23, 5),
  );
  logEvent(f, "Log: note", at(24, 4));

  // --- reply to the lead
  f.code(
    "Prepare reply",
    js(["messages.fn.js"], `
const v = ${V};
const q = JSON.parse($('Check AI answer').first().json.detail);
const statusUrl = v.public_base + '/status?id=' + v.lead_id;
return [{ json: { body: leadReplyEmail(v.lead, q, { from: $env.EMAIL_FROM_LEADS, statusUrl, leadId: v.lead_id }) } }];`),
    at(25, 4),
  );
  f.http("Resend: reply to lead", {
    method: "POST",
    url: "={{ ($env.RESEND_BASE || 'https://api.resend.com') + '/emails' }}",
    headers: { "Idempotency-Key": `={{ 'lead-reply-' + ${V}.lead_id }}` },
    json: "$json.body",
    timeout: 15000,
    pos: at(26, 4),
    node: { ...RETRY, onError: "continueErrorOutput", credentials: credRef(CRED.resend), notes: "Idempotency key per lead, so a retry never sends twice." },
  });
  Object.assign(f.nodes.at(-1).parameters, { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" });
  f.code(
    "Record reply",
    js([], `${EVENT_FN}
const v = ${V};
const res = $input.first().json;
if (res.error || !res.id) return [event(v.lead_id, 'reply_email', 'failed', 'The reply email could not be sent: ' + errorText(res.error || 'no id returned'), { error: errorText(res.error || 'no id') })];
return [event(v.lead_id, 'reply_email', 'ok', 'Reply email accepted by the email service for delivery.', { email_id: res.id, to: JSON.parse($('Event: received').first().json.detail).email_masked })];`),
    at(27, 4),
  );
  logEvent(f, "Log: reply", at(28, 4));

  // --- team alert
  f.code(
    "Prepare team alert",
    js(["messages.fn.js"], `
const v = ${V};
const q = JSON.parse($('Check AI answer').first().json.detail);
const contact = $('Record contact').first().json;
const problems = [];
if (contact.state !== 'ok') problems.push('HubSpot contact not saved');
const note = $('Log: note').first().json;
if (note.state === 'failed') problems.push('HubSpot note not saved');
if ($('Record reply').first().json.state !== 'ok') problems.push('reply email not sent');
const contactId = contact.state === 'ok' ? JSON.parse(contact.detail).contact_id : null;
const portal = $env.HUBSPOT_PORTAL_ID;
const contactUrl = contactId && portal ? 'https://app.hubspot.com/contacts/' + portal + '/record/0-1/' + contactId : null;
const statusUrl = v.public_base + '/status?id=' + v.lead_id;
return [{ json: { problems, body: teamAlertEmail(v.lead, q, { from: $env.EMAIL_FROM_ALERTS || $env.EMAIL_FROM_LEADS, to: $env.TEAM_EMAIL, statusUrl, crm: { contactUrl }, problems }) } }];`),
    at(29, 4),
  );
  f.http("Resend: team alert", {
    method: "POST",
    url: "={{ ($env.RESEND_BASE || 'https://api.resend.com') + '/emails' }}",
    headers: { "Idempotency-Key": `={{ 'lead-alert-' + ${V}.lead_id }}` },
    json: "$json.body",
    timeout: 15000,
    pos: at(30, 4),
    node: { ...RETRY, onError: "continueErrorOutput", credentials: credRef(CRED.resend) },
  });
  Object.assign(f.nodes.at(-1).parameters, { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" });
  f.code(
    "Record alert",
    js([], `${EVENT_FN}
const v = ${V};
const res = $input.first().json;
const problems = $('Prepare team alert').first().json.problems;
if (res.error || !res.id) return [event(v.lead_id, 'team_alert', 'failed', 'The team alert could not be sent: ' + errorText(res.error || 'no id returned'), { error: errorText(res.error || 'no id') })];
const summary = problems.length
  ? 'Urgent alert sent to the team: ' + problems.join('; ') + '. Nothing is lost: the alert carries the full lead.'
  : 'The team was emailed the lead, its score and the HubSpot link.';
return [event(v.lead_id, 'team_alert', 'ok', summary, { email_id: res.id, urgent: problems.length > 0, problems })];`),
    at(31, 4),
  );
  logEvent(f, "Log: alert", at(32, 4));

  f.code(
    "Finish",
    js([], `${EVENT_FN}
const v = ${V};
const problems = $('Prepare team alert').first().json.problems;
const alertOk = $('Record alert').first().json.state === 'ok';
const outcome = !alertOk ? 'failed' : problems.length ? 'partial' : 'ok';
const started = new Date($('Log: received').first().json.createdAt || Date.now()).getTime();
const secs = Math.round((Date.now() - started) / 100) / 10;
const summary = outcome === 'ok'
  ? 'All steps finished in ' + secs + ' s.'
  : outcome === 'partial'
    ? 'Finished in ' + secs + ' s with a handled failure: ' + problems.join('; ') + '. The team was alerted.'
    : 'Finished with failures and the team alert could not be sent. The error workflow takes over.';
return [event(v.lead_id, 'done', outcome === 'failed' ? 'failed' : 'ok', summary, { outcome, seconds: secs, problems })];`),
    at(33, 4),
  );
  logEvent(f, "Log: done", at(34, 4));
  f.ifTrue("Alert failed?", "$('Record alert').first().json.state !== 'ok'", at(35, 4));
  f.add(
    "Fail execution",
    "n8n-nodes-base.stopAndError",
    1,
    { errorMessage: `={{ 'Lead ' + ${V}.lead_id + ': team alert could not be sent' }}` },
    at(36, 3),
    { notes: "Marks the execution as failed so the Error Workflow alerts by its own route." },
  );

  // wiring
  f.connect("Lead form", "Validate & spam guard");
  f.connect("Validate & spam guard", "Spam?");
  f.connect("Spam?", "Reject: spam", 0).connect("Spam?", "Valid?", 1);
  f.connect("Valid?", "Find recent leads", 0).connect("Valid?", "Reject: invalid", 1);
  f.connect("Find recent leads", "Check limits");
  f.connect("Check limits", "Within limits?");
  f.connect("Within limits?", "Save lead", 0).connect("Within limits?", "Reject: limit", 1);
  f.connect("Save lead", "Event: received");
  f.connect("Event: received", "Log: received");
  f.connect("Log: received", "Accepted (202)");
  f.connect("Accepted (202)", "Simulate broken AI?");
  f.connect("Simulate broken AI?", "Simulated AI answer", 0).connect("Simulate broken AI?", "Build AI request", 1);
  f.connect("Build AI request", "Gemini: qualify lead");
  f.connect("Gemini: qualify lead", "Check AI answer", 0).connect("Gemini: qualify lead", "Gemini: backup model", 1);
  f.connect("Gemini: backup model", "Check AI answer", 0).connect("Gemini: backup model", "Check AI answer", 1);
  f.connect("Simulated AI answer", "Check AI answer");
  f.connect("Check AI answer", "Log: qualified");
  f.connect("Log: qualified", "Prepare contact");
  f.connect("Prepare contact", "HubSpot: upsert contact");
  f.connect("HubSpot: upsert contact", "Record contact", 0).connect("HubSpot: upsert contact", "Record contact", 1);
  f.connect("Record contact", "Log: contact");
  f.connect("Log: contact", "Contact saved?");
  f.connect("Contact saved?", "Prepare note", 0).connect("Contact saved?", "Skip note", 1);
  f.connect("Prepare note", "HubSpot: add note");
  f.connect("HubSpot: add note", "Record note", 0).connect("HubSpot: add note", "Record note", 1);
  f.connect("Record note", "Log: note");
  f.connect("Skip note", "Log: note");
  f.connect("Log: note", "Prepare reply");
  f.connect("Prepare reply", "Resend: reply to lead");
  f.connect("Resend: reply to lead", "Record reply", 0).connect("Resend: reply to lead", "Record reply", 1);
  f.connect("Record reply", "Log: reply");
  f.connect("Log: reply", "Prepare team alert");
  f.connect("Prepare team alert", "Resend: team alert");
  f.connect("Resend: team alert", "Record alert", 0).connect("Resend: team alert", "Record alert", 1);
  f.connect("Record alert", "Log: alert");
  f.connect("Log: alert", "Finish");
  f.connect("Finish", "Log: done");
  f.connect("Log: done", "Alert failed?");
  f.connect("Alert failed?", "Fail execution", 0);
  return f;
}

// ------------------------------------------------------------------ status

export function statusFlow() {
  const f = new Flow("Lead pipeline: status", { settings: { saveDataSuccessExecution: "none", saveManualExecutions: false } });
  f.add(
    "Status request",
    "n8n-nodes-base.webhook",
    2.2,
    { httpMethod: "GET", path: "lead-status", responseMode: "responseNode", options: {} },
    at(0, 1),
    { webhookId: "5c6f1a52-1f1e-4b8e-9a51-6c2d7f0e3a10", notes: "GET from the status page via the gateway (/api/status?id=)." },
  );
  f.ifTrue("Valid id?", "/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(String($json.query.id || ''))", at(1, 1));
  dataTable(
    f,
    "Get lead events",
    {
      operation: "get",
      dataTableId: tableRef(TABLES.events),
      matchType: "allConditions",
      filters: { conditions: [{ keyName: "lead_id", condition: "eq", keyValue: "={{ $json.query.id }}" }] },
      returnAll: true,
    },
    at(2, 0),
    { alwaysOutputData: true },
  );
  f.code(
    "Build status",
    js(["timeline.fn.js"], `
const rows = $input.all().map((i) => i.json).filter((r) => r && r.id !== undefined);
const status = buildStatus(rows, Date.now());
return [{ json: status ? { found: true, status } : { found: false } }];`),
    at(3, 0),
  );
  f.ifTrue("Found?", "$json.found === true", at(4, 0));
  f.add(
    "Status (200)",
    "n8n-nodes-base.respondToWebhook",
    1.5,
    { respondWith: "json", responseBody: "={{ $json.status }}", options: { responseCode: 200, responseHeaders: { entries: [{ name: "Cache-Control", value: "no-store" }] } } },
    at(5, -1),
  );
  f.respond("Not found (404)", { code: 404, body: "({ error: 'not_found' })", pos: at(5, 1) });
  f.connect("Status request", "Valid id?");
  f.connect("Valid id?", "Get lead events", 0).connect("Valid id?", "Not found (404)", 1);
  f.connect("Get lead events", "Build status");
  f.connect("Build status", "Found?");
  f.connect("Found?", "Status (200)", 0).connect("Found?", "Not found (404)", 1);
  return f;
}

// ------------------------------------------------------------------ simulated CRM outage

export function outageFlow() {
  // Executions are not saved: the request carries the CRM credential header.
  const f = new Flow("Lead pipeline: simulated CRM outage", {
    settings: { saveDataSuccessExecution: "none", saveDataErrorExecution: "none", saveManualExecutions: false },
  });
  f.webhook("Fake HubSpot", { path: "sim-crm-outage", pos: at(0, 1), note: "Internal only. The gateway never forwards this path." });
  f.ifTrue("Valid id?", "/^[0-9a-f-]{36}$/.test(String($json.query.lead_id || ''))", at(1, 1));
  f.code(
    "Event: attempt failed",
    js([], `${EVENT_FN}
return [event($input.first().json.query.lead_id, 'crm_contact', 'retrying', 'HTTP 503 from the simulated HubSpot outage')];`),
    at(2, 0),
  );
  logEvent(f, "Log: attempt", at(3, 0));
  f.respond("Outage (503)", { code: 503, body: "({ status: 'error', message: 'Simulated outage: service unavailable' })", pos: at(4, 1) });
  f.connect("Fake HubSpot", "Valid id?");
  f.connect("Valid id?", "Event: attempt failed", 0).connect("Valid id?", "Outage (503)", 1);
  f.connect("Event: attempt failed", "Log: attempt");
  f.connect("Log: attempt", "Outage (503)");
  return f;
}

// ------------------------------------------------------------------ error workflow

export function errorFlow() {
  const f = new Flow("Lead pipeline: error alert");
  f.add("On workflow error", "n8n-nodes-base.errorTrigger", 1, {}, at(0, 1));
  f.code(
    "Format alert",
    js([], `
const e = $input.first().json;
const ex = e.execution || {};
const wf = e.workflow || {};
const msg = (ex.error && (ex.error.message || ex.error.description)) || 'unknown error';
const text = [
  'An n8n execution failed and its own error handling could not finish.',
  '',
  'Workflow: ' + (wf.name || '?'),
  'Execution: ' + (ex.id || '?') + ' (mode ' + (ex.mode || '?') + ')',
  'Last node: ' + (ex.lastNodeExecuted || '?'),
  'Error: ' + String(msg).slice(0, 500),
  '',
  'Open the execution in the n8n editor (local only) to replay it.',
].join('\\n');
return [{ json: { body: { from: $env.EMAIL_FROM_ALERTS || $env.EMAIL_FROM_LEADS, to: [$env.TEAM_EMAIL], subject: '[n8n ERROR] ' + (wf.name || 'workflow') + ': ' + String(msg).slice(0, 80), text } } }];`),
    at(1, 1),
  );
  f.http("Resend: error alert", {
    method: "POST",
    url: "={{ ($env.RESEND_BASE || 'https://api.resend.com') + '/emails' }}",
    json: "$json.body",
    timeout: 15000,
    pos: at(2, 1),
    node: { retryOnFail: true, maxTries: 5, waitBetweenTries: 5000, credentials: credRef(CRED.resend) },
  });
  Object.assign(f.nodes.at(-1).parameters, { authentication: "genericCredentialType", genericAuthType: "httpHeaderAuth" });
  f.connect("On workflow error", "Format alert");
  f.connect("Format alert", "Resend: error alert");
  return f;
}


// ------------------------------------------------------------------ retention

export function cleanupFlow() {
  const f = new Flow("Lead pipeline: cleanup", { settings: { errorWorkflow: "__ERROR_WORKFLOW_ID__" } });
  f.add("Every day 03:00 UTC", "n8n-nodes-base.scheduleTrigger", 1.2, { rule: { interval: [{ field: "cronExpression", expression: "0 3 * * *" }] } }, at(0, 1));
  const cutoff = "={{ $now.minus({ days: Number($env.RETENTION_DAYS || 14) }).toUTC().toISO() }}";
  for (const [name, t, pos] of [["Delete old events", TABLES.events, at(1, 1)], ["Delete old leads", TABLES.leads, at(2, 1)]]) {
    dataTable(
      f,
      name,
      { operation: "deleteRows", dataTableId: tableRef(t), matchType: "allConditions", filters: { conditions: [{ keyName: "createdAt", condition: "lt", keyValue: cutoff }] }, options: {} },
      pos,
      { alwaysOutputData: true, executeOnce: true, notes: "Pipeline records older than RETENTION_DAYS (default 14)." },
    );
  }
  f.connect("Every day 03:00 UTC", "Delete old events");
  f.connect("Delete old events", "Delete old leads");
  return f;
}

export function allWorkflows() {
  return {
    "error-alert.json": errorFlow(),
    "lead-intake.json": intakeFlow(),
    "lead-status.json": statusFlow(),
    "simulated-crm-outage.json": outageFlow(),
    "cleanup.json": cleanupFlow(),
  };
}
