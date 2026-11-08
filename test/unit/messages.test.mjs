import { describe, expect, it } from "vitest";
import { loadFns } from "../helpers/load.mjs";

const M = loadFns("messages.fn.js", ["hubspotContactUpsert", "hubspotNote", "leadReplyEmail", "teamAlertEmail", "escapeHtml"]);
const lead = { name: "Asha <b>Rao</b>", first_name: "Asha", last_name: "<b>Rao</b>", email: "asha@brightlane.io", company: "Bright & Co", website: "brightlane.io", service: "Website redesign", budget: "$15k–50k", timeline: "1–3 months", message: "Line one\n<script>alert(1)</script>" };
const q = { score: 82, tier: "hot", reason: "Good <fit>", next_step: "book_call", red_flags: ["<x>"], scored_by: "ai" };

it("builds a HubSpot upsert keyed by email", () => {
  const b = M.hubspotContactUpsert(lead);
  expect(b.inputs[0]).toMatchObject({ idProperty: "email", id: "asha@brightlane.io" });
  expect(b.inputs[0].properties).toMatchObject({ firstname: "Asha", company: "Bright & Co", website: "https://brightlane.io", lifecyclestage: "lead" });
});

it("escapes every user value in the HubSpot note and links it to the contact", () => {
  const n = M.hubspotNote(lead, q, { contactId: 123, leadId: "id-1", nowMs: 0 });
  expect(n.associations[0]).toEqual({ to: { id: "123" }, types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: 202 }] });
  const html = n.properties.hs_note_body;
  expect(html).not.toMatch(/<script>|<fit>|<x>/);
  expect(html).toContain("&lt;script&gt;");
  expect(html).toContain("Line one<br>");
});

describe("lead reply", () => {
  const e = M.leadReplyEmail(lead, q, { from: "Studio <leads@example.com>", statusUrl: "https://x.example/status?id=1", leadId: "1" });
  it("goes to the lead with a tier-specific line and the status link", () => {
    expect(e.to).toEqual(["asha@brightlane.io"]);
    expect(e.text).toContain("discovery call");
    expect(e.text).toContain("https://x.example/status?id=1");
    expect(e.text).toMatch(/fictional business/);
  });
  it("escapes HTML and keeps the subject on one line", () => {
    expect(e.html).not.toContain("<b>");
    expect(e.html).toContain("Bright &amp; Co");
    expect(e.subject).not.toMatch(/[\r\n]/);
  });
  it("never shows the score or AI reason to the lead", () => {
    expect(e.text).not.toContain("82");
    expect(e.text).not.toContain("Good <fit>");
  });
});

describe("team alert", () => {
  it("normal alert has tier and score in the subject and the CRM link", () => {
    const e = M.teamAlertEmail(lead, q, { from: "a@x", to: "team@x", statusUrl: "s", crm: { contactUrl: "https://app.hubspot.com/c/1" }, problems: [] });
    expect(e.subject).toBe("[HOT 82] New lead: Bright & Co");
    expect(e.text).toContain("https://app.hubspot.com/c/1");
  });
  it("failure alert is marked urgent and carries the full lead", () => {
    const e = M.teamAlertEmail(lead, q, { from: "a@x", to: "team@x", statusUrl: "s", crm: { contactUrl: null }, problems: ["HubSpot contact not saved"] });
    expect(e.subject).toMatch(/^\[ACTION NEEDED\]/);
    expect(e.text).toContain("NOT SAVED");
    expect(e.text).toContain("asha@brightlane.io");
    expect(e.text).toContain("<script>alert(1)</script>"); // plain text email: shown as typed, never rendered
  });
});
