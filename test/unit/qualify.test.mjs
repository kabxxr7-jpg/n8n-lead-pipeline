import { describe, expect, it } from "vitest";
import { loadFns } from "../helpers/load.mjs";

const Q = loadFns("qualify.fn.js", ["buildGeminiRequest", "checkQualification", "parseGeminiResponse", "scoreByRules", "simulatedBrokenAnswer", "tierFor"]);
const lead = { name: "Asha Rao", email: "asha@brightlane.io", company: "Brightlane", website: "brightlane.io", service: "Website redesign", budget: "$15k–50k", timeline: "1–3 months", message: "We need a faster site with a booking flow and a CRM hook before our spring launch, plus SEO basics and analytics." };
const good = { score: 82, tier: "hot", reason: "Clear scope, healthy budget and a near timeline.", next_step: "book_call", red_flags: [] };
const wrap = (text, extra = {}) => ({ candidates: [{ content: { parts: [{ text }] }, finishReason: "STOP" }], modelVersion: "gemini-x", usageMetadata: { promptTokenCount: 300, candidatesTokenCount: 40 }, ...extra });

describe("Gemini request", () => {
  const req = Q.buildGeminiRequest(lead);
  it("asks for JSON with a schema", () => {
    expect(req.generationConfig.responseMimeType).toBe("application/json");
    expect(req.generationConfig.responseSchema.required).toEqual(["score", "tier", "reason", "next_step", "red_flags"]);
  });
  it("sends the brief as data, without the person's name or full email", () => {
    const text = req.contents[0].parts[0].text;
    expect(text).toContain("brightlane.io");
    expect(text).not.toContain("Asha");
    expect(text).not.toContain("asha@");
    expect(req.systemInstruction.parts[0].text).toMatch(/untrusted/);
  });
});

describe("checkQualification", () => {
  it("accepts a good answer", () => expect(Q.checkQualification(good)).toMatchObject({ ok: true, value: good }));
  it.each([
    [{ ...good, score: 82.5 }, /integer/], [{ ...good, score: 101 }, /integer/], [{ ...good, tier: "maybe" }, /tier/],
    [{ ...good, tier: "warm" }, /does not match/], [{ ...good, reason: "ok" }, /reason/], [{ ...good, next_step: "call_now" }, /next_step/],
    [{ ...good, red_flags: "none" }, /red_flags/], [{ ...good, extra: 1 }, /unexpected/], [[], /object/],
  ])("rejects %j", (ans, problem) => {
    const r = Q.checkQualification(ans);
    expect(r.ok).toBe(false);
    expect(r.problem).toMatch(problem);
  });
});

describe("parseGeminiResponse", () => {
  it("parses a valid answer and skips thought parts", () => {
    const res = wrap(JSON.stringify(good));
    res.candidates[0].content.parts.unshift({ text: "thinking...", thought: true });
    expect(Q.parseGeminiResponse(res)).toMatchObject({ ok: true, value: good, meta: { model: "gemini-x", output_tokens: 40 } });
  });
  it("reports n8n error items", () => expect(Q.parseGeminiResponse({ error: { message: "503 overloaded" } }).problem).toMatch(/request failed: 503/));
  it("reports blocked prompts", () => expect(Q.parseGeminiResponse({ promptFeedback: { blockReason: "SAFETY" } }).problem).toMatch(/blocked: SAFETY/));
  it("reports truncated JSON", () => expect(Q.parseGeminiResponse(wrap('{"score": 4', {})).problem).toMatch(/not valid JSON/));
  it("rejects the simulated broken answer", () => expect(Q.parseGeminiResponse(Q.simulatedBrokenAnswer()).ok).toBe(false));
});

describe("scoreByRules", () => {
  it("scores a strong lead hot and passes its own contract", () => {
    const r = Q.scoreByRules(lead);
    expect(r.tier).toBe("hot");
    expect(Q.checkQualification(r).ok).toBe(true);
  });
  it("scores a weak lead cold with red flags", () => {
    const r = Q.scoreByRules({ ...lead, email: "x@gmail.com", budget: "Under $2k", timeline: "Just exploring", website: "", message: "need a site cheap" });
    expect(r.tier).toBe("cold");
    expect(r.red_flags).toEqual(expect.arrayContaining(["free email domain", "budget below minimum", "no timeline", "very short brief"]));
    expect(Q.checkQualification(r).ok).toBe(true);
  });
  it("tier bands", () => expect([Q.tierFor(70), Q.tierFor(69), Q.tierFor(40), Q.tierFor(39)]).toEqual(["hot", "warm", "warm", "cold"]));
});
