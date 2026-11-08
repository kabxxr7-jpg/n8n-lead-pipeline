import { describe, expect, it } from "vitest";
import { loadFns } from "../helpers/load.mjs";

const { buildStatus } = loadFns("timeline.fn.js", ["buildStatus"]);
const T0 = Date.parse("2026-11-08T12:00:00Z");
let id = 0;
const ev = (secs, step, state, summary = "", detail = "") => ({ id: ++id, lead_id: "L", step, state, summary, detail: typeof detail === "string" ? detail : JSON.stringify(detail), createdAt: new Date(T0 + secs * 1000).toISOString() });
const start = [
  ev(0, "received", "ok", "in", { first_name: "Asha", company: "Brightlane", email_masked: "as••@brightlane.io", simulate: "none" }),
  ev(0, "validated", "ok", "checked"),
];

describe("buildStatus", () => {
  it("returns null for no rows", () => expect(buildStatus([], T0)).toBeNull());
  it("marks the next step running while in progress", () => {
    const s = buildStatus(start, T0 + 1000);
    expect(s.finished).toBe(false);
    expect(s.steps.map((x) => x.state)).toEqual(["ok", "ok", "running", "pending", "pending", "pending", "pending", "pending"]);
    expect(s.lead).toEqual({ first_name: "Asha", company: "Brightlane", email_masked: "as••@brightlane.io" });
  });
  it("shows a finished run with the qualification", () => {
    const rows = [...start,
      ev(3, "qualified", "ok", "scored", { score: 82, tier: "hot", reason: "r", scored_by: "ai", next_step: "book_call", red_flags: [] }),
      ev(4, "crm_contact", "ok", "c", { contact_id: "1" }), ev(5, "crm_note", "ok"), ev(6, "reply_email", "ok"), ev(7, "team_alert", "ok"),
      ev(7, "done", "ok", "all done", { outcome: "ok", seconds: 7 })];
    const s = buildStatus(rows.reverse(), T0 + 8000);
    expect(s).toMatchObject({ finished: true, outcome: "ok", stalled: false, qualification: { score: 82, tier: "hot", scored_by: "ai" }, simulated: [] });
    expect(s.steps.every((x) => x.state === "ok")).toBe(true);
  });
  it("shows retries live and then the failure, with the attempts", () => {
    const base = [...start.map((e) => ({ ...e, detail: e.step === "received" ? JSON.stringify({ simulate: "crm_outage" }) : e.detail })),
      ev(2, "qualified", "ok", "", { score: 50, tier: "warm", reason: "r", scored_by: "ai" }),
      ev(3, "crm_contact", "retrying", "HTTP 503"), ev(5, "crm_contact", "retrying", "HTTP 503")];
    const live = buildStatus(base, T0 + 6000);
    expect(live.steps[3]).toMatchObject({ state: "running", summary: expect.stringMatching(/Attempt 2 failed/) });
    expect(live.simulated).toEqual(["crm_outage"]);
    const after = buildStatus([...base, ev(7, "crm_contact", "retrying", "HTTP 503"), ev(7, "crm_contact", "failed", "gave up", { attempts: 3 })], T0 + 8000);
    expect(after.steps[3].state).toBe("failed");
    expect(after.steps[3].detail.attempts).toHaveLength(3);
    expect(after.steps[4].state).toBe("running");
  });
  it("shows the fallback reason", () => {
    const s = buildStatus([...start, ev(1, "qualified", "ok", "", { score: 30, tier: "cold", reason: "r", scored_by: "rules-fallback", fallback_reason: "answer is not valid JSON" })], T0 + 2000);
    expect(s.qualification).toMatchObject({ scored_by: "rules-fallback", fallback_reason: "answer is not valid JSON" });
  });
  it("flags a stalled run and stops claiming work is running", () => {
    const s = buildStatus(start, T0 + 120_000);
    expect(s.stalled).toBe(true);
    expect(s.steps.some((x) => x.state === "running")).toBe(false);
  });
  it("marks unfinished steps skipped when done arrived early", () => {
    const s = buildStatus([...start, ev(1, "done", "failed", "x", { outcome: "failed" })], T0 + 2000);
    expect(s.outcome).toBe("failed");
    expect(s.steps[2].state).toBe("skipped");
  });
});
