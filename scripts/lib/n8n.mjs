// Talks to a running n8n: first-run owner setup, API key, data tables, credentials, workflows.
// Used by scripts/setup.mjs (real run) and the integration tests (against local mocks).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { allWorkflows, CRED, TABLES } from "../../src/workflows/pipeline.mjs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, { timeoutMs = 120_000, intervalMs = 500, what = "condition" } = {}) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      if (await fn()) return;
    } catch (e) {
      last = e;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? `: ${last.message}` : ""}`);
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
export function writeSecretJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
}

export class N8n {
  constructor(base, apiKey = null) {
    this.base = base.replace(/\/$/, "");
    this.apiKey = apiKey;
  }

  async api(p, { method = "GET", body } = {}) {
    const res = await fetch(`${this.base}/api/v1${p}`, {
      method,
      headers: { "X-N8N-API-KEY": this.apiKey, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    if (res.status >= 300) {
      const e = new Error(`${method} /api/v1${p} -> HTTP ${res.status}: ${String(typeof json === "string" ? json : JSON.stringify(json)).slice(0, 300)}`);
      e.status = res.status;
      throw e;
    }
    return json;
  }

  async ready(timeoutMs = 180_000) {
    await waitFor(async () => (await fetch(`${this.base}/healthz/readiness`, { signal: AbortSignal.timeout(2000) })).status === 200, {
      timeoutMs,
      what: `n8n at ${this.base}`,
    });
  }

  /** Owner account + API key on first run; afterwards reuses what is stored in the secrets file. */
  async bootstrap(secretsFile, ownerEmail) {
    let s = readJson(secretsFile);
    const settings = await (await fetch(`${this.base}/rest/settings`)).json();
    const needsOwner = settings.data?.userManagement?.showSetupOnFirstLoad === true;
    if (needsOwner) {
      s = { ownerEmail, ownerPassword: `Pl-${crypto.randomBytes(15).toString("base64url")}9a`, apiKey: null };
      writeSecretJson(secretsFile, s);
      const r = await fetch(`${this.base}/rest/owner/setup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: s.ownerEmail, firstName: "Pipeline", lastName: "Owner", password: s.ownerPassword }),
      });
      if (r.status !== 200) throw new Error(`owner setup failed: HTTP ${r.status}`);
    }
    if (!s?.ownerPassword) throw new Error(`n8n already has an owner but ${secretsFile} is missing; restore it or reset the n8n data volume`);
    if (!s.apiKey) {
      const login = await fetch(`${this.base}/rest/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emailOrLdapLoginId: s.ownerEmail, password: s.ownerPassword }),
      });
      if (login.status !== 200) throw new Error(`owner login failed: HTTP ${login.status}`);
      const cookie = login.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const scopes = (await (await fetch(`${this.base}/rest/api-keys/scopes`, { headers: { cookie } })).json()).data;
      const r = await fetch(`${this.base}/rest/api-keys`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ label: "lead-pipeline-setup", scopes, expiresAt: null }),
      });
      if (r.status >= 300) throw new Error(`API key creation failed: HTTP ${r.status}`);
      s.apiKey = (await r.json()).data.rawApiKey;
      writeSecretJson(secretsFile, s);
    }
    this.apiKey = s.apiKey;
    return s;
  }

  async ensureTables() {
    const existing = (await this.api("/data-tables?limit=100")).data;
    const ids = {};
    for (const t of Object.values(TABLES)) {
      const found = existing.find((d) => d.name === t.name);
      if (found) {
        const have = new Set(found.columns.map((c) => c.name));
        for (const c of t.columns) if (!have.has(c)) await this.api(`/data-tables/${found.id}/columns`, { method: "POST", body: { name: c, type: "string" } });
        ids[t.name] = found.id;
      } else {
        const created = await this.api("/data-tables", { method: "POST", body: { name: t.name, columns: t.columns.map((name) => ({ name, type: "string" })) } });
        ids[t.name] = created.id;
      }
    }
    return ids;
  }

  /** values: { gemini: {name, value}, hubspot: {...}, resend: {...} } (header name + value). Creates or updates by name. */
  async ensureCredentials(values) {
    const list = (await this.api("/credentials?limit=100")).data ?? [];
    const ids = {};
    for (const c of Object.values(CRED)) {
      const v = values[c.key];
      if (!v?.value) throw new Error(`missing value for credential "${c.name}"`);
      const found = list.find((x) => x.name === c.name && x.type === "httpHeaderAuth");
      const body = { name: c.name, type: "httpHeaderAuth", data: { name: v.name, value: v.value } };
      if (found) {
        await this.api(`/credentials/${found.id}`, { method: "PATCH", body: { name: c.name, data: body.data } });
        ids[c.key] = found.id;
      } else {
        ids[c.key] = (await this.api("/credentials", { method: "POST", body })).id;
      }
    }
    return ids;
  }

  /** Upload every workflow (create or replace by name), wire credential ids and the error workflow, activate. */
  async syncWorkflows(credIds) {
    const existing = (await this.api("/workflows?limit=250")).data ?? [];
    const out = {};
    const entries = Object.entries(allWorkflows()).sort(([a]) => (a === "error-alert.json" ? -1 : 1));
    let errorId = null;
    for (const [file, flow] of entries) {
      let text = JSON.stringify(flow.toJSON());
      for (const [k, id] of Object.entries(credIds)) text = text.replaceAll(`__CRED_${k.toUpperCase()}__`, id);
      if (errorId) text = text.replaceAll("__ERROR_WORKFLOW_ID__", errorId);
      if (/__CRED_|__ERROR_WORKFLOW_ID__/.test(text)) throw new Error(`unresolved placeholder in ${file}`);
      const wf = JSON.parse(text);
      const body = { name: wf.name, nodes: wf.nodes, connections: wf.connections, settings: wf.settings };
      const prev = existing.find((w) => w.name === wf.name);
      if (prev?.active) await this.api(`/workflows/${prev.id}/deactivate`, { method: "POST", body: {} });
      const saved = prev ? await this.api(`/workflows/${prev.id}`, { method: "PUT", body }) : await this.api("/workflows", { method: "POST", body });
      const act = await this.api(`/workflows/${saved.id}/activate`, { method: "POST", body: {} });
      if (act.active !== true) throw new Error(`could not activate ${file}`);
      if (file === "error-alert.json") errorId = saved.id;
      out[file] = saved.id;
    }
    return out;
  }

  /** Owner session cookie (for the editor's own run endpoint). */
  async login(secrets) {
    const r = await fetch(`${this.base}/rest/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emailOrLdapLoginId: secrets.ownerEmail, password: secrets.ownerPassword }) });
    if (r.status !== 200) throw new Error(`login failed: HTTP ${r.status}`);
    return r.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  }

  /** What the editor's "Execute workflow" button does: run from a trigger node now. */
  async runFromTrigger(cookie, workflowId, triggerName) {
    const r = await fetch(`${this.base}/rest/workflows/${workflowId}/run`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ triggerToStartFrom: { name: triggerName } }) });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  }

  async executions(workflowId, { limit = 20 } = {}) {
    return (await this.api(`/executions?workflowId=${workflowId}&includeData=true&limit=${limit}`)).data;
  }
}

/** Environment n8n needs (both the Docker service and the local dev process). */
export function pipelineEnv(cfg) {
  return {
    N8N_DIAGNOSTICS_ENABLED: "false",
    N8N_VERSION_NOTIFICATIONS_ENABLED: "false",
    N8N_TEMPLATES_ENABLED: "false",
    N8N_PERSONALIZATION_ENABLED: "false",
    N8N_HIRING_BANNER_ENABLED: "false",
    N8N_DYNAMIC_BANNERS_ENABLED: "false",
    N8N_AI_ENABLED: "false",
    N8N_COMMUNITY_PACKAGES_ENABLED: "false",
    N8N_PUBLIC_API_SWAGGERUI_DISABLED: "true",
    N8N_BLOCK_ENV_ACCESS_IN_NODE: "false",
    NODE_FUNCTION_ALLOW_BUILTIN: "crypto",
    N8N_RUNNERS_MODE: "internal",
    GENERIC_TIMEZONE: "UTC",
    TZ: "UTC",
    EXECUTIONS_DATA_PRUNE: "true",
    EXECUTIONS_DATA_MAX_AGE: "336",
    PUBLIC_BASE_URL: cfg.publicBaseUrl,
    EMAIL_FROM_LEADS: cfg.emailFromLeads,
    EMAIL_FROM_ALERTS: cfg.emailFromAlerts,
    TEAM_EMAIL: cfg.teamEmail,
    DAILY_LEAD_CAP: String(cfg.dailyCap ?? 150),
    GEMINI_MODEL: cfg.geminiModel,
    HUBSPOT_PORTAL_ID: cfg.hubspotPortalId ?? "",
    SIM_OUTAGE_URL: cfg.simOutageUrl,
    RETENTION_DAYS: String(cfg.retentionDays ?? 14),
    ...(cfg.geminiBase ? { GEMINI_BASE: cfg.geminiBase } : {}),
    ...(cfg.hubspotBase ? { HUBSPOT_BASE: cfg.hubspotBase } : {}),
    ...(cfg.resendBase ? { RESEND_BASE: cfg.resendBase } : {}),
  };
}
