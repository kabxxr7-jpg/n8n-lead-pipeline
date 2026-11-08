// End to end against a real n8n (2.45.7) with Gemini, HubSpot and Resend replaced by local mocks.
// Run: N8N_BIN=/path/to/n8n/bin/n8n npm run test:integration
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sleep } from "../../scripts/lib/n8n.mjs";
import { startStack } from "./stack.mjs";

let s;
beforeAll(async () => { s = await startStack(); }, 240_000);
afterAll(async () => { await s?.stop(); });
beforeEach(() => s.mocks.reset());

let n = 0;
const lead = (over = {}) => ({
  name: "Asha Rao", email: `asha${++n}@brightlane.io`, company: "Brightlane", website: "brightlane.io",
  service: "Website redesign", budget: "$15k–50k", timeline: "1–3 months",
  message: "We need a faster site with a booking flow and a CRM hook before our spring launch.",
  consent: true, simulate: "none", fax: "", started_at: Date.now() - 30_000, ...over,
});
const submit = async (body) => {
  const r = await fetch(`${s.gatewayBase}/api/lead`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
};
const status = async (id) => {
  const r = await fetch(`${s.gatewayBase}/api/status?id=${id}`);
  return { status: r.status, body: await r.json() };
};
async function runToEnd(body) {
  const r = await submit(body);
  expect(r.status).toBe(202);
  const seen = [];
  for (let i = 0; i < 120; i++) {
    const st = (await status(r.body.lead_id)).body;
    seen.push(st);
    if (st.finished) return { id: r.body.lead_id, st, seen };
    await sleep(250);
  }
  throw new Error("pipeline did not finish");
}
const reqs = (prefix, list = s.mocks.requests) => list.filter((q) => q.path.startsWith(prefix));
const emails = (list) => reqs("/resend/emails", list).map((q) => ({ key: q.headers["idempotency-key"], ...q.body }));
const step = (st, key) => st.steps.find((x) => x.key === key);

describe("happy path", () => {
  let run, got;
  beforeAll(async () => {
    s.mocks.reset();
    run = await runToEnd(lead({ email: "happy@brightlane.io" }));
    got = [...s.mocks.requests]; // the shared beforeEach resets the live list
  }, 60_000);

  it("finishes every step", () => {
    expect(run.st.outcome).toBe("ok");
    expect(run.st.steps.map((x) => x.state)).toEqual(Array(8).fill("ok"));
    expect(run.st.qualification).toMatchObject({ score: 84, tier: "hot", scored_by: "ai" });
  });
  it("shows the steps progressing (the 202 came before the work finished)", () => {
    expect(run.seen.length).toBeGreaterThanOrEqual(1);
    expect(run.seen[0].steps[0].state).toBe("ok");
  });
  it("calls Gemini once with the key header and a JSON schema", () => {
    const g = reqs("/gemini", got);
    expect(g).toHaveLength(1);
    expect(g[0].headers["x-goog-api-key"]).toBe("test-gemini-key");
    expect(g[0].body.generationConfig.responseSchema.required).toContain("score");
  });
  it("upserts the contact by email and links the note to it", () => {
    const [c] = reqs("/hubspot/crm/v3/objects/contacts", got);
    expect(c.headers.authorization).toBe("Bearer test-hubspot-token");
    expect(c.body.inputs[0]).toMatchObject({ idProperty: "email", id: "happy@brightlane.io" });
    const [note] = reqs("/hubspot/crm/v3/objects/notes", got);
    const contactId = step(run.st, "crm_contact").detail.contact_id;
    expect(note.body.associations[0].to.id).toBe(contactId);
    expect(note.body.properties.hs_note_body).toContain("84/100");
  });
  it("emails the lead and the team once each, with idempotency keys", () => {
    const e = emails(got);
    expect(e).toHaveLength(2);
    expect(e[0]).toMatchObject({ key: `lead-reply-${run.id}`, to: ["happy@brightlane.io"] });
    expect(e[0].text).toContain(`/status?id=${run.id}`);
    expect(e[1]).toMatchObject({ key: `lead-alert-${run.id}`, to: ["team@example.test"], subject: "[HOT 84] New lead: Brightlane" });
    expect(e[1].text).toContain("https://app.hubspot.com/contacts/4242/record/0-1/");
  });
  it("never shows the full email or message on the public status", () => {
    const text = JSON.stringify(run.st);
    expect(text).not.toContain("happy@brightlane.io");
    expect(text).not.toContain("booking flow");
    expect(run.st.lead.email_masked).toBe("ha••@brightlane.io");
  });
});

describe("rejections", () => {
  it("spam (too fast) gets 422 and touches nothing", async () => {
    const r = await submit(lead({ started_at: Date.now() - 500 }));
    expect(r).toMatchObject({ status: 422, body: { error: "spam_suspected" } });
    await sleep(500);
    expect(s.mocks.requests).toHaveLength(0);
  });
  it("honeypot gets 422", async () => expect((await submit(lead({ fax: "x" }))).status).toBe(422));
  it("invalid fields get 400 with messages per field", async () => {
    const r = await submit(lead({ email: "nope", budget: "lots" }));
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.fields).sort()).toEqual(["budget", "email"]);
  });
  it("the same email again within 5 minutes gets 429", async () => {
    const body = lead();
    expect((await submit(body)).status).toBe(202);
    const again = await submit({ ...body, started_at: Date.now() - 20_000 });
    expect(again.status).toBe(429);
    expect(again.body.retry_after_s).toBeGreaterThan(200);
  });
  it("unknown and malformed status ids get 404", async () => {
    expect((await status("0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b")).status).toBe(404);
    expect((await status("x")).status).toBe(404);
  });
});

describe("AI failures fall back to the rules", () => {
  it("off-contract answer (tier does not match score)", async () => {
    s.mocks.setGeminiAnswer(JSON.stringify({ score: 90, tier: "cold", reason: "Looks fine to me overall.", next_step: "book_call", red_flags: [] }));
    const { st } = await runToEnd(lead());
    expect(st.qualification).toMatchObject({ scored_by: "rules-fallback", fallback_reason: 'tier "cold" does not match score 90' });
    expect(st.outcome).toBe("ok");
  });
  it("main model busy: 3 tries, then the backup model answers", async () => {
    s.mocks.faults.gemini.push(503, 503, 503);
    const { st } = await runToEnd(lead());
    const g = reqs("/gemini");
    expect(g.map((q) => q.path.includes("-lite:"))).toEqual([false, false, false, true]);
    expect(g[1].at - g[0].at).toBeGreaterThanOrEqual(1900);
    expect(st.qualification.scored_by).toBe("ai");
    expect(step(st, "qualified").summary).toMatch(/^Gemini \(mock-gemini\)/);
  }, 60_000);
  it("both models down: 3 + 3 tries, then the rules fallback; the lead still flows on", async () => {
    s.mocks.faults.gemini.push(503, 503, 503);
    s.mocks.faults.geminiBackup.push(503, 503, 503);
    const { st } = await runToEnd(lead());
    expect(reqs("/gemini")).toHaveLength(6);
    expect(st.qualification.scored_by).toBe("rules-fallback");
    expect(st.qualification.fallback_reason).toMatch(/request failed/);
    expect(step(st, "crm_contact").state).toBe("ok");
  }, 90_000);
  it("Gemini fails twice then answers: the third try is used", async () => {
    s.mocks.faults.gemini.push(500, 429);
    const { st } = await runToEnd(lead());
    expect(reqs("/gemini")).toHaveLength(3);
    expect(st.qualification.scored_by).toBe("ai");
  }, 60_000);
  it("simulated broken answer does not call Gemini", async () => {
    const { st } = await runToEnd(lead({ simulate: "ai_invalid" }));
    expect(reqs("/gemini")).toHaveLength(0);
    expect(st.qualification.scored_by).toBe("rules-fallback");
    expect(st.simulated).toEqual(["ai_invalid"]);
  });
});

describe("CRM failures", () => {
  it("simulated outage: retries visible live, note skipped, lead still replied, urgent team alert", async () => {
    const { st, seen } = await runToEnd(lead({ simulate: "crm_outage" }));
    expect(seen.some((x) => step(x, "crm_contact").state === "running" && /Attempt \d failed/.test(step(x, "crm_contact").summary))).toBe(true);
    expect(step(st, "crm_contact")).toMatchObject({ state: "failed" });
    expect(step(st, "crm_contact").detail.attempts).toHaveLength(3);
    expect(step(st, "crm_note").state).toBe("skipped");
    expect(step(st, "reply_email").state).toBe("ok");
    expect(st.outcome).toBe("partial");
    expect(reqs("/hubspot")).toHaveLength(0); // the real CRM was never called
    const alert = emails().find((e) => e.key.startsWith("lead-alert-"));
    expect(alert.subject).toMatch(/^\[ACTION NEEDED\].*HubSpot contact not saved/);
    expect(alert.text).toContain("NOT SAVED");
  }, 60_000);
  it("real CRM error on the note only", async () => {
    s.mocks.faults.hubspotNote.push(500, 500, 500);
    const { st } = await runToEnd(lead());
    expect(reqs("/hubspot/crm/v3/objects/notes")).toHaveLength(3);
    expect(step(st, "crm_note").state).toBe("failed");
    expect(st.outcome).toBe("partial");
    expect(emails().find((e) => e.key.startsWith("lead-alert-")).subject).toMatch(/HubSpot note not saved/);
  }, 60_000);
});

describe("email failures", () => {
  it("team alert cannot be sent: execution fails and the Error Workflow alerts", async () => {
    s.mocks.faults.resendAlert.push(500, 500, 500);
    const { id, st } = await runToEnd(lead());
    expect(st.outcome).toBe("failed");
    expect(step(st, "team_alert").state).toBe("failed");
    let errorMail;
    for (let i = 0; i < 40 && !errorMail; i++) {
      await sleep(250);
      errorMail = emails().find((e) => !e.key && /^\[n8n ERROR\]/.test(e.subject));
    }
    expect(errorMail.text).toContain(`Lead ${id}: team alert could not be sent`);
    const ex = (await s.n8n.executions(s.ids["lead-intake.json"], { limit: 1 }))[0];
    expect(ex.status).toBe("error");
  }, 60_000);
});

describe("retention", () => {
  it("the cleanup workflow deletes old pipeline records", async () => {
    const { id } = await runToEnd(lead());
    expect((await status(id)).status).toBe(200);
    const cookie = await s.n8n.login(s.secrets);
    const r = await s.n8n.runFromTrigger(cookie, s.ids["cleanup.json"], "Every day 03:00 UTC");
    expect(r.status).toBe(200);
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) {
      await sleep(250);
      gone = (await status(id)).status === 404;
    }
    expect(gone).toBe(true);
  }, 60_000);
});

describe("Zoho CRM instead of HubSpot", () => {
  it("renews the expired OAuth token, creates the lead and its note, and says Zoho on the status page", async () => {
    const { st, id } = await runToEnd(lead({ crm: "zoho", email: "zoho1@brightlane.io" }));
    expect(st.crm).toBe("zoho");
    expect(step(st, "crm_contact")).toMatchObject({ label: "Zoho CRM lead", state: "ok" });
    expect(step(st, "crm_note")).toMatchObject({ label: "Zoho CRM note", state: "ok" });
    expect(reqs("/hubspot")).toHaveLength(0);
    // first call with the expired token got 401, n8n refreshed once, then the same call succeeded
    const tokenCalls = reqs("/zoho-accounts/oauth/v2/token");
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0].form).toMatchObject({ grant_type: "refresh_token", refresh_token: "zoho-refresh-1" });
    const ups = reqs("/zoho/crm/v8/Leads/upsert");
    expect(ups.map((q) => q.headers.authorization)).toEqual(["Bearer zoho-access-1-expired", "Bearer zoho-access-2"]);
    expect(ups[1].body).toMatchObject({ duplicate_check_fields: ["Email"], data: [{ Email: "zoho1@brightlane.io", Company: "Brightlane", Last_Name: "Rao", First_Name: "Asha" }] });
    const leadId = step(st, "crm_contact").detail.contact_id;
    const [note] = reqs(`/zoho/crm/v8/Leads/${leadId}/Notes`);
    expect(note.body.data[0].Note_Title).toBe("Lead score 84/100 (hot)");
    expect(note.body.data[0].Note_Content).toContain(id);
    const alert = emails().find((e) => e.key.startsWith("lead-alert-"));
    expect(alert.text).toContain(`Zoho CRM record: https://crm.zoho.test/crm/org777/tab/Leads/${leadId}`);
  }, 60_000);
  it("keeps using the renewed token (and the refresh token survives the renewal)", async () => {
    await runToEnd(lead({ crm: "zoho" }));
    expect(reqs("/zoho-accounts")).toHaveLength(0);
    s.mocks.zoho.validToken = "zoho-access-3"; // the token expires again
    const { st } = await runToEnd(lead({ crm: "zoho" }));
    expect(step(st, "crm_contact").state).toBe("ok");
    expect(reqs("/zoho-accounts/oauth/v2/token")[0].form.refresh_token).toBe("zoho-refresh-1");
  }, 60_000);
  it("a record Zoho refuses (200 with an error inside) is a failed step, not a success", async () => {
    s.mocks.faults.zohoLead.push("mandatory");
    const { st } = await runToEnd(lead({ crm: "zoho" }));
    expect(step(st, "crm_contact").state).toBe("failed");
    expect(step(st, "crm_contact").summary).toMatch(/MANDATORY_NOT_FOUND/);
    expect(step(st, "crm_note").state).toBe("skipped");
    expect(st.outcome).toBe("partial");
    expect(emails().find((e) => e.key.startsWith("lead-alert-")).subject).toMatch(/Zoho CRM lead not saved/);
  }, 60_000);
  it("simulated outage on the Zoho path never calls Zoho", async () => {
    const { st } = await runToEnd(lead({ crm: "zoho", simulate: "crm_outage" }));
    expect(step(st, "crm_contact")).toMatchObject({ label: "Zoho CRM lead", state: "failed" });
    expect(reqs("/zoho")).toHaveLength(0);
  }, 60_000);
});
