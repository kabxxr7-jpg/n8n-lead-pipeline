// Runs the same stack without Docker: the n8n CLI (N8N_BIN, version 2.45.7) on 127.0.0.1:5680
// and the gateway on 127.0.0.1:5678. Ctrl-C stops both.
//   N8N_BIN=/path/to/node_modules/n8n/bin/n8n npm run local
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createGateway } from "../gateway/server.mjs";
import { pipelineEnv } from "./lib/n8n.mjs";
import { readEnvFile } from "./setup.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bin = process.env.N8N_BIN;
if (!bin || !fs.existsSync(bin)) {
  console.error("set N8N_BIN to the n8n 2.45.7 CLI (or use docker compose up -d)");
  process.exit(1);
}
const e = readEnvFile();
const dataDir = path.join(ROOT, ".n8n-data");
fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
  N8N_USER_FOLDER: dataDir, N8N_ENCRYPTION_KEY: e.N8N_ENCRYPTION_KEY,
  N8N_PORT: "5680", N8N_LISTEN_ADDRESS: "127.0.0.1", N8N_HOST: "127.0.0.1", N8N_PROTOCOL: "http",
  N8N_EDITOR_BASE_URL: "http://127.0.0.1:5680", WEBHOOK_URL: "http://127.0.0.1:5680/", N8N_SECURE_COOKIE: "false",
  N8N_RUNNERS_BROKER_PORT: "5681",
  ...pipelineEnv({
    publicBaseUrl: e.PUBLIC_BASE_URL, emailFromLeads: e.EMAIL_FROM_LEADS, emailFromAlerts: e.EMAIL_FROM_ALERTS,
    teamEmail: e.TEAM_EMAIL, dailyCap: e.DAILY_LEAD_CAP, geminiModel: e.GEMINI_MODEL, hubspotPortalId: e.HUBSPOT_PORTAL_ID,
    simOutageUrl: "http://127.0.0.1:5680/webhook/sim-crm-outage",
  }),
};
const child = spawn(process.execPath, [bin, "start"], { env, stdio: "inherit" });
const gw = createGateway({ upstream: "http://127.0.0.1:5680" });
gw.listen(5678, "127.0.0.1", () => console.log("gateway on http://127.0.0.1:5678 (public surface); editor on http://127.0.0.1:5680 (this machine only)"));
const stop = () => { gw.close(); child.kill("SIGTERM"); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
child.on("exit", (code) => { gw.close(); process.exit(code ?? 0); });
