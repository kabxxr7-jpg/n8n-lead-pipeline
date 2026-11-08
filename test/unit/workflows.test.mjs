// Static checks on the exported workflow JSON: wiring, retries, error branches, no secrets.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const load = (f) => JSON.parse(fs.readFileSync(new URL(`../../workflows/${f}`, import.meta.url), "utf8"));
const files = fs.readdirSync(new URL("../../workflows/", import.meta.url)).filter((f) => f.endsWith(".json"));

it("committed JSON matches the builder", () => {
  execFileSync(process.execPath, ["scripts/build-workflows.mjs", "--check"], { stdio: "pipe" });
});

describe.each(files)("%s", (file) => {
  const wf = load(file);
  const names = new Set(wf.nodes.map((n) => n.name));
  it("connections point at real nodes", () => {
    for (const [from, c] of Object.entries(wf.connections)) {
      expect(names.has(from)).toBe(true);
      for (const t of c.main.flat()) expect(names.has(t.node)).toBe(true);
    }
  });
  it("has no secrets, only credential placeholders", () => {
    const text = JSON.stringify(wf);
    expect(text).not.toMatch(/re_[A-Za-z0-9]{20,}|pat-[a-z0-9-]{20,}|AIza[0-9A-Za-z_-]{30,}|Bearer [A-Za-z0-9]/);
    for (const n of wf.nodes.filter((x) => x.credentials)) for (const c of Object.values(n.credentials)) expect(c.id).toMatch(/^__CRED_[A-Z]+__$/);
  });
  it("every outside call retries and has a timeout", () => {
    for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.httpRequest")) {
      expect(n.retryOnFail, n.name).toBe(true);
      expect(n.maxTries, n.name).toBeGreaterThanOrEqual(3);
      expect(n.parameters.options.timeout, n.name).toBeGreaterThan(0);
    }
  });
});

describe("intake", () => {
  const wf = load("lead-intake.json");
  const node = (n) => wf.nodes.find((x) => x.name === n);
  it("sends the main model's failures to the backup model, then both outputs to the check", () => {
    expect(wf.connections["Gemini: qualify lead"].main.map((o) => o[0].node)).toEqual(["Check AI answer", "Gemini: backup model"]);
    expect(wf.connections["Gemini: backup model"].main.map((o) => o[0].node)).toEqual(["Check AI answer", "Check AI answer"]);
  });
  it("routes both outputs of every other outside call to its recorder (error branch)", () => {
    for (const n of wf.nodes.filter((x) => x.type === "n8n-nodes-base.httpRequest" && x.name !== "Gemini: qualify lead")) {
      expect(n.onError, n.name).toBe("continueErrorOutput");
      const outs = wf.connections[n.name].main;
      expect(outs).toHaveLength(2);
      expect(outs[0][0].node).toBe(outs[1][0].node);
    }
  });
  it("answers the form before the slow steps", () => {
    expect(wf.connections["Log: received"].main[0][0].node).toBe("Accepted (202)");
    expect(node("Accepted (202)").parameters.options.responseCode).toBe(202);
  });
  it("Zoho calls use the OAuth2 credential, HubSpot calls the header credential", () => {
    for (const n of ["Zoho: upsert lead", "Zoho: add note"]) expect(Object.keys(node(n).credentials)).toEqual(["oAuth2Api"]);
    for (const n of ["HubSpot: upsert contact", "HubSpot: add note"]) expect(Object.keys(node(n).credentials)).toEqual(["httpHeaderAuth"]);
  });
  it("sends emails with idempotency keys", () => {
    for (const n of ["Resend: reply to lead", "Resend: team alert"]) {
      expect(node(n).parameters.headerParameters.parameters[0].name).toBe("Idempotency-Key");
    }
  });
  it("links the error workflow and fails the run if the alert cannot be sent", () => {
    expect(wf.settings.errorWorkflow).toBe("__ERROR_WORKFLOW_ID__");
    expect(wf.connections["Alert failed?"].main[0][0].node).toBe("Fail execution");
  });
});

it("the simulated outage workflow does not keep execution data", () => {
  const wf = load("simulated-crm-outage.json");
  expect(wf.settings).toMatchObject({ saveDataSuccessExecution: "none", saveDataErrorExecution: "none" });
});
