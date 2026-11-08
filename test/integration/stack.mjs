// Starts a throwaway n8n (N8N_BIN, the n8n CLI of the pinned version) + the gateway + mocks.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createGateway, RateLimiter } from "../../gateway/server.mjs";
import { N8n, pipelineEnv } from "../../scripts/lib/n8n.mjs";
import { killTree } from "../../scripts/lib/proc.mjs";
import { startMocks } from "./mocks.mjs";

export const N8N_PORT = 5695;
const BROKER_PORT = 5696;

export async function startStack() {
  const bin = process.env.N8N_BIN;
  if (!bin || !fs.existsSync(bin)) throw new Error("set N8N_BIN to the n8n CLI (n8n 2.45.7), for example node_modules/n8n/bin/n8n");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "lead-pipeline-it-"));
  const mocks = await startMocks();
  const n8nBase = `http://127.0.0.1:${N8N_PORT}`;

  const gateway = createGateway({ upstream: n8nBase, leadLimiter: new RateLimiter([{ windowMs: 60e3, max: 1000 }]), log: () => {} });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const gatewayBase = `http://127.0.0.1:${gateway.address().port}`;

  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
    N8N_USER_FOLDER: dataDir, N8N_PORT: String(N8N_PORT), N8N_LISTEN_ADDRESS: "127.0.0.1", N8N_HOST: "127.0.0.1",
    N8N_PROTOCOL: "http", N8N_SECURE_COOKIE: "false", N8N_RUNNERS_BROKER_PORT: String(BROKER_PORT),
    N8N_LOG_LEVEL: "warn",
    EXECUTIONS_DATA_SAVE_ON_SUCCESS: "all", EXECUTIONS_DATA_SAVE_ON_ERROR: "all",
    ...pipelineEnv({
      publicBaseUrl: gatewayBase,
      emailFromLeads: "Fernbrook Studio (demo) <leads@example.test>",
      emailFromAlerts: "Lead pipeline <alerts@example.test>",
      teamEmail: "team@example.test",
      dailyCap: 150,
      geminiModel: "gemini-mock",
      geminiBackupModel: "gemini-mock-lite",
      hubspotPortalId: "4242",
      simOutageUrl: `${n8nBase}/webhook/sim-crm-outage`,
      retentionDays: -1, // the cleanup test deletes everything up to tomorrow
      geminiBase: `${mocks.base}/gemini`,
      hubspotBase: `${mocks.base}/hubspot`,
      resendBase: `${mocks.base}/resend`,
      zohoEnabled: true,
      zohoApiBase: `${mocks.base}/zoho`,
      zohoCrmWeb: "https://crm.zoho.test",
      zohoOrgId: "777",
    }),
  };
  const log = path.join(dataDir, "n8n.log");
  const fd = fs.openSync(log, "a");
  const child = spawn(process.execPath, [bin, "start"], { env, detached: true, stdio: ["ignore", fd, fd] });
  fs.closeSync(fd);

  const n8n = new N8n(n8nBase);
  const stop = async () => {
    await killTree(child.pid, { graceMs: 5000 });
    await mocks.close();
    gateway.close();
    if (!process.env.KEEP_IT_DATA) fs.rmSync(dataDir, { recursive: true, force: true });
  };
  try {
    await n8n.ready();
    const secrets = await n8n.bootstrap(path.join(dataDir, "owner.json"), "owner@example.test");
    await n8n.ensureTables();
    const creds = await n8n.ensureCredentials({
      gemini: { name: "x-goog-api-key", value: "test-gemini-key" },
      hubspot: { name: "Authorization", value: "Bearer test-hubspot-token" },
      resend: { name: "Authorization", value: "Bearer test-resend-key" },
      zoho: { clientId: "zoho-client", clientSecret: "zoho-secret", accessTokenUrl: `${mocks.base}/zoho-accounts/oauth/v2/token`, refreshToken: "zoho-refresh-1", accessToken: "zoho-access-1-expired" },
    });
    const ids = await n8n.syncWorkflows(creds);
    return { n8n, ids, secrets, mocks, gatewayBase, log, stop };
  } catch (e) {
    console.error(fs.existsSync(log) ? fs.readFileSync(log, "utf8").slice(-3000) : "no log");
    await stop();
    throw e;
  }
}
