import { describe, expect, it } from "vitest";
import { loadFns } from "../helpers/load.mjs";

const { validateLead, checkLimits, maskEmail, dayKey } = loadFns("validate.fn.js", ["validateLead", "checkLimits", "maskEmail", "dayKey"]);
const NOW = Date.parse("2026-11-08T12:00:00Z");
const good = (over = {}) => ({
  name: "Asha Rao", email: "Asha@Brightlane.io", company: "Brightlane", website: "brightlane.io",
  service: "Website redesign", budget: "$15k–50k", timeline: "1–3 months",
  message: "We need a faster site with a booking flow and a CRM hook before our spring launch.",
  consent: true, simulate: "none", fax: "", started_at: NOW - 45_000, ...over,
});

describe("validateLead", () => {
  it("accepts and normalises a good lead", () => {
    const r = validateLead(good({ name: "  Asha   Rao " }), NOW);
    expect(r.kind).toBe("ok");
    expect(r.lead).toMatchObject({ name: "Asha Rao", first_name: "Asha", last_name: "Rao", email: "asha@brightlane.io", simulate: "none", fill_seconds: 45 });
  });
  it("defaults simulate to none", () => {
    const b = good(); delete b.simulate;
    expect(validateLead(b, NOW).lead.simulate).toBe("none");
  });
  it.each([
    ["honeypot", { fax: "123" }, /hidden field/],
    ["missing timer", { started_at: undefined }, /timing token/],
    ["too fast", { started_at: NOW - 1200 }, /1\.2 s/],
    ["many links", { message: "see http://a.example http://b.example www.c.example for our needs please" }, /3 links/],
  ])("flags spam: %s", (_, over, reason) => {
    const r = validateLead(good(over), NOW);
    expect(r.kind).toBe("spam");
    expect(r.reason).toMatch(reason);
  });
  it.each([
    ["name", { name: "A" }], ["name", { name: "Visit http://spam.example" }], ["email", { email: "nope" }],
    ["email", { email: "x@mailinator.com" }], ["company", { company: "" }], ["website", { website: "not a site" }],
    ["service", { service: "Logo" }], ["budget", { budget: "$1" }], ["timeline", { timeline: "yesterday" }],
    ["message", { message: "too short" }], ["consent", { consent: "yes" }], ["simulate", { simulate: "drop_tables" }],
  ])("rejects bad %s", (field, over) => {
    const r = validateLead(good(over), NOW);
    expect(r.kind).toBe("invalid");
    expect(Object.keys(r.fields)).toContain(field);
  });
  it("rejects non-objects", () => {
    for (const b of [null, [], "x", 3]) expect(validateLead(b, NOW).kind).toBe("invalid");
  });
  it("allows two links", () => {
    expect(validateLead(good({ message: "Our site is https://a.example and the old one www.b.example, please rebuild both." }), NOW).kind).toBe("ok");
  });
});

describe("checkLimits", () => {
  const H = "h1";
  const row = (minsAgo, over = {}) => ({ id: 1, email_hash: H, day: dayKey(NOW), createdAt: new Date(NOW - minsAgo * 60e3).toISOString(), ...over });
  const opts = { emailHash: H, nowMs: NOW, dailyCap: 5 };
  it("passes with no history", () => expect(checkLimits([], opts)).toEqual({ ok: true }));
  it("enforces a 5 minute cooldown per email", () => {
    expect(checkLimits([row(2)], opts)).toEqual({ ok: false, error: "rate_limited", retry_after_s: 180 });
    expect(checkLimits([row(6)], opts).ok).toBe(true);
  });
  it("allows 3 per email per day", () => {
    expect(checkLimits([row(10), row(60)], opts).ok).toBe(true);
    expect(checkLimits([row(10), row(60), row(120)], opts)).toMatchObject({ ok: false, error: "rate_limited" });
    expect(checkLimits([row(10), row(60), row(25 * 60)], opts).ok).toBe(true);
  });
  it("applies the global daily cap", () => {
    const others = Array.from({ length: 5 }, (_, i) => row(30 + i, { email_hash: `o${i}` }));
    expect(checkLimits(others, opts)).toEqual({ ok: false, error: "daily_cap" });
    expect(checkLimits(others.slice(1), opts).ok).toBe(true);
  });
});

it("masks emails", () => {
  expect(maskEmail("asha@brightlane.io")).toBe("as••@brightlane.io");
  expect(maskEmail("a@b.co")).toBe("a••@b.co");
});
