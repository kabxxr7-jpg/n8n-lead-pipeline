// One command after `docker compose up -d` (or `npm run local`): owner account, API key,
// data tables, credentials and workflows. Safe to run again; it updates in place.
//   npm run setup            uses N8N_LOCAL_URL or http://127.0.0.1:5680
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { N8n } from "./lib/n8n.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export function readEnvFile(file = path.join(ROOT, ".env")) {
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].trim();
  }
  return out;
}
function setEnvValue(key, value, file = path.join(ROOT, ".env")) {
  const text = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, new RegExp(`^${key}=.*$`, "m").test(text) ? text.replace(new RegExp(`^${key}=.*$`, "m"), `${key}=${value}`) : `${text}${key}=${value}\n`, { mode: 0o600 });
}

async function main() {
  const env = readEnvFile();
  const missing = ["GEMINI_API_KEY", "HUBSPOT_TOKEN", "RESEND_API_KEY", "TEAM_EMAIL", "EMAIL_FROM_LEADS"].filter((k) => !env[k]);
  if (missing.length) throw new Error(`fill these in .env first: ${missing.join(", ")}`);

  if (!env.HUBSPOT_PORTAL_ID) {
    const r = await fetch("https://api.hubapi.com/account-info/v3/details", { headers: { Authorization: `Bearer ${env.HUBSPOT_TOKEN}` } });
    if (r.status !== 200) throw new Error(`HubSpot token check failed: HTTP ${r.status} (check the token and its scopes)`);
    const portal = String((await r.json()).portalId);
    setEnvValue("HUBSPOT_PORTAL_ID", portal);
    console.log(`HubSpot account found (portal ${portal}); saved HUBSPOT_PORTAL_ID to .env. Restart n8n so it picks it up (docker compose up -d).`);
  }

  const n8n = new N8n(process.env.N8N_LOCAL_URL || "http://127.0.0.1:5680");
  await n8n.ready();
  await n8n.bootstrap(path.join(ROOT, ".n8n-owner.json"), "owner@lead-pipeline.local");
  const tables = await n8n.ensureTables();
  const creds = await n8n.ensureCredentials({
    gemini: { name: "x-goog-api-key", value: env.GEMINI_API_KEY },
    hubspot: { name: "Authorization", value: `Bearer ${env.HUBSPOT_TOKEN}` },
    resend: { name: "Authorization", value: `Bearer ${env.RESEND_API_KEY}` },
    zoho: env.ZOHO_REFRESH_TOKEN
      ? { clientId: env.ZOHO_CLIENT_ID, clientSecret: env.ZOHO_CLIENT_SECRET, accessTokenUrl: `${env.ZOHO_ACCOUNTS_URL}/oauth/v2/token`, refreshToken: env.ZOHO_REFRESH_TOKEN }
      : null,
  });
  console.log(env.ZOHO_REFRESH_TOKEN ? "Zoho CRM credential stored (the form offers Zoho when ZOHO_ENABLED=true)." : "Zoho CRM not configured: placeholder credential, the form offers HubSpot only.");
  const ids = await n8n.syncWorkflows(creds);
  console.log(`data tables: ${Object.keys(tables).join(", ")}`);
  console.log(`workflows active: ${Object.keys(ids).join(", ")}`);
  console.log("editor (this machine only): http://127.0.0.1:5680  login details: .n8n-owner.json");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`setup failed: ${e.message}`);
    process.exit(1);
  });
}
