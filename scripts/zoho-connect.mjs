// Exchanges a Zoho Self Client grant code (valid 10 minutes, single use) for a refresh token,
// finds the CRM org, and writes ZOHO_REFRESH_TOKEN, ZOHO_API_DOMAIN, ZOHO_ACCOUNTS_URL,
// ZOHO_CRM_WEB, ZOHO_ORG_ID and ZOHO_ENABLED=true into .env. Prints no secrets.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readEnvFile } from "./setup.mjs";

const ENV = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env");
const set = (pairs) => {
  let text = fs.readFileSync(ENV, "utf8");
  for (const [k, v] of Object.entries(pairs)) {
    const re = new RegExp(`^${k}=.*$`, "m");
    text = re.test(text) ? text.replace(re, `${k}=${v}`) : `${text}${k}=${v}\n`;
  }
  fs.writeFileSync(ENV, text, { mode: 0o600 });
};

const env = readEnvFile(ENV);
for (const k of ["ZOHO_CLIENT_ID", "ZOHO_CLIENT_SECRET", "ZOHO_GRANT_CODE"]) if (!env[k]) throw new Error(`${k} is empty in .env`);

// Zoho has one accounts server per data centre; a code only works on its own.
const DCS = [
  ["https://accounts.zoho.in", "https://crm.zoho.in"],
  ["https://accounts.zoho.com", "https://crm.zoho.com"],
  ["https://accounts.zoho.eu", "https://crm.zoho.eu"],
  ["https://accounts.zoho.com.au", "https://crm.zoho.com.au"],
];
let tok = null;
let dc = null;
const tried = [];
for (const [accounts, web] of DCS) {
  const body = new URLSearchParams({ grant_type: "authorization_code", client_id: env.ZOHO_CLIENT_ID, client_secret: env.ZOHO_CLIENT_SECRET, code: env.ZOHO_GRANT_CODE });
  const r = await fetch(`${accounts}/oauth/v2/token`, { method: "POST", body, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (j.refresh_token) {
    tok = j;
    dc = { accounts, web };
    break;
  }
  tried.push(`${new URL(accounts).host}: ${j.error || r.status}`);
}
if (!tok) throw new Error(`grant code not accepted (${tried.join("; ")}). Codes expire after 10 minutes and work once: generate a new one.`);

const org = await fetch(`${tok.api_domain}/crm/v8/org`, { headers: { Authorization: `Zoho-oauthtoken ${tok.access_token}` } }).then((r) => r.json());
const o = org.org?.[0] || {};
const orgId = String(o.domain_name || "").replace(/^org/, "") || String(o.zgid || "");
set({
  ZOHO_GRANT_CODE: "",
  ZOHO_REFRESH_TOKEN: tok.refresh_token,
  ZOHO_API_DOMAIN: tok.api_domain,
  ZOHO_ACCOUNTS_URL: dc.accounts,
  ZOHO_CRM_WEB: dc.web,
  ZOHO_ORG_ID: orgId,
  ZOHO_ENABLED: "true",
});
console.log(`Zoho connected: ${new URL(dc.accounts).host}, API ${tok.api_domain}, org ${orgId ? "found" : "not found"} (${o.company_name ? "company set" : "no company name"}). Refresh token saved to .env.`);
