// Local stand-ins for Gemini, HubSpot and Resend used only by the integration tests.
// Each records every request; `faults` scripts failures.
import http from "node:http";

export function startMocks() {
  const requests = [];
  const faults = { zohoLead: [], gemini: [], geminiBackup: [], hubspotContact: [], hubspotNote: [], resendAlert: [], resend: [] };
  let geminiAnswer = null; // override answer text
  let contactSeq = 100;
  let emailSeq = 0;
  const zoho = { validToken: "zoho-access-2", refreshCalls: 0, leadSeq: 5000 }; // the credential starts with an expired token

  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body = null;
      try { body = JSON.parse(raw); } catch {}
      const rec = { method: req.method, path: req.url, headers: req.headers, body, at: Date.now() };
      requests.push(rec);
      const send = (status, obj) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
      const fault = (k) => (faults[k].length ? faults[k].shift() : null);

      if (req.url.startsWith("/gemini/v1beta/models/")) {
        const f = fault(req.url.includes("-lite:") ? "geminiBackup" : "gemini");
        if (f) return send(f, { error: { code: f, message: "mock overloaded", status: "UNAVAILABLE" } });
        const text = geminiAnswer ?? JSON.stringify({ score: 84, tier: "hot", reason: "Clear redesign scope, mid-five-figure budget and a near timeline.", next_step: "book_call", red_flags: [] });
        return send(200, { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 310, candidatesTokenCount: 45 }, modelVersion: "mock-gemini" });
      }
      if (req.url === "/hubspot/crm/v3/objects/contacts/batch/upsert") {
        const f = fault("hubspotContact");
        if (f) return send(f, { status: "error", message: "mock failure" });
        return send(200, { status: "COMPLETE", results: [{ id: String(++contactSeq), new: true, properties: body.inputs[0].properties }] });
      }
      if (req.url === "/hubspot/crm/v3/objects/notes") {
        const f = fault("hubspotNote");
        if (f) return send(f, { status: "error", message: "mock failure" });
        return send(201, { id: "9000" + contactSeq, properties: body.properties });
      }
      if (req.url === "/zoho-accounts/oauth/v2/token") {
        const form = Object.fromEntries(new URLSearchParams(raw));
        rec.form = form;
        if (form.grant_type !== "refresh_token" || form.refresh_token !== "zoho-refresh-1" || form.client_id !== "zoho-client" || form.client_secret !== "zoho-secret") {
          return send(400, { error: "invalid_client" });
        }
        zoho.refreshCalls++;
        return send(200, { access_token: zoho.validToken, api_domain: "http://mock", token_type: "Bearer", expires_in: 3600 });
      }
      if (req.url.startsWith("/zoho/crm/v8/")) {
        if (req.headers.authorization !== `Bearer ${zoho.validToken}`) return send(401, { code: "INVALID_TOKEN", details: {}, message: "invalid oauth token", status: "error" });
        if (req.url === "/zoho/crm/v8/Leads/upsert") {
          const f = fault("zohoLead");
          if (f === "mandatory") return send(202, { data: [{ code: "MANDATORY_NOT_FOUND", details: { api_name: "Last_Name" }, message: "required field not found", status: "error" }] });
          if (f) return send(f, { code: "INTERNAL_ERROR", message: "mock failure", status: "error" });
          return send(200, { data: [{ code: "SUCCESS", duplicate_field: null, action: "insert", details: { id: String(++zoho.leadSeq) }, message: "record added", status: "success" }] });
        }
        const m = req.url.match(/^\/zoho\/crm\/v8\/Leads\/(\d+)\/Notes$/);
        if (m) return send(201, { data: [{ code: "SUCCESS", details: { id: "77" + m[1] }, message: "record added", status: "success" }] });
      }
      if (req.url === "/resend/emails") {
        const isAlert = String(req.headers["idempotency-key"] || "").startsWith("lead-alert-");
        const f = (isAlert && fault("resendAlert")) || fault("resend");
        if (f) return send(f, { statusCode: f, name: "application_error", message: "mock failure" });
        return send(200, { id: `email-${++emailSeq}` });
      }
      send(404, { error: "no mock route" });
    });
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const base = `http://127.0.0.1:${server.address().port}`;
      resolve({
        base, requests, faults, zoho,
        setGeminiAnswer: (t) => (geminiAnswer = t),
        reset() { requests.length = 0; for (const k of Object.keys(faults)) faults[k].length = 0; geminiAnswer = null; },
        close: () => new Promise((r) => server.close(r)),
      });
    }),
  );
}
