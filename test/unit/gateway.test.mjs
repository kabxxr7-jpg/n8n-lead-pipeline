import http from "node:http";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createGateway, RateLimiter } from "../../gateway/server.mjs";

let upstream, gw, base, seen, reply;
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const [status, payload] = reply(req);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(typeof payload === "string" ? payload : JSON.stringify(payload));
    });
  });
  const up = await listen(upstream);
  gw = createGateway({
    upstream: `http://127.0.0.1:${up}`,
    leadLimiter: new RateLimiter([{ windowMs: 60e3, max: 3 }]),
    log: () => {},
  });
  base = `http://127.0.0.1:${await listen(gw)}`;
});
afterAll(() => { gw.close(); upstream.close(); });
beforeEach(() => { seen = []; reply = () => [202, { ok: true, lead_id: "x" }]; });

const post = (body, headers = {}) => fetch(`${base}/api/lead`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("only the public surface is reachable", () => {
  it.each(["/", "/status", "/assets/app.css", "/assets/form.js", "/assets/status.js", "/healthz"])("serves %s", async (p) => {
    const r = await fetch(base + p);
    expect(r.status).toBe(200);
  });
  it.each(["/rest/login", "/signin", "/home/workflows", "/webhook/lead-intake", "/webhook/sim-crm-outage", "/webhook-test/lead-intake", "/api/v1/workflows", "/assets/../server.mjs", "/%2e%2e/server.mjs", "/healthz/readiness", "/metrics"])("404s %s and never calls n8n", async (p) => {
    const r = await fetch(base + p);
    expect(r.status).toBe(404);
    expect(seen).toHaveLength(0);
  });
  it("sends security headers", async () => {
    const r = await fetch(base + "/");
    expect(r.headers.get("content-security-policy")).toMatch(/frame-ancestors 'none'/);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
  });
});

describe("/api/lead", () => {
  it("forwards the JSON body only, without client headers", async () => {
    const r = await post({ name: "A" }, { cookie: "secret=1", authorization: "Bearer x" });
    expect(r.status).toBe(202);
    expect(seen[0]).toMatchObject({ method: "POST", url: "/webhook/lead-intake", body: '{"name":"A"}' });
    expect(seen[0].headers.cookie).toBeUndefined();
    expect(seen[0].headers.authorization).toBeUndefined();
  });
  it("rejects non-JSON, bad JSON, arrays and big bodies before n8n", async () => {
    expect((await fetch(`${base}/api/lead`, { method: "POST", body: "a=b", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect((await post("{bad", { "cf-connecting-ip": "198.51.100.1" })).status).toBe(400);
    expect((await post("[1]", { "cf-connecting-ip": "198.51.100.1" })).status).toBe(400);
    expect((await post({ x: "y".repeat(20000) }, { "cf-connecting-ip": "198.51.100.1" })).status).toBe(413);
    expect((await fetch(`${base}/api/lead`)).status).toBe(405);
    expect(seen).toHaveLength(0);
  });
  it("passes designed statuses through and hides others", async () => {
    reply = () => [422, { ok: false, error: "spam_suspected", reason: "fast" }];
    expect((await post({}, { "cf-connecting-ip": "198.51.100.2" })).status).toBe(422);
    reply = () => [500, { message: "Workflow could not be started!", stack: "secret path" }];
    const r = await post({}, { "cf-connecting-ip": "198.51.100.2" });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ ok: false, error: "upstream" });
  });
  it("rate limits per client IP", async () => {
    const ip = { "cf-connecting-ip": "192.0.2.77" };
    for (let i = 0; i < 3; i++) expect((await post({}, ip)).status).toBe(202);
    const r = await post({}, ip);
    expect(r.status).toBe(429);
    expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await post({}, { "cf-connecting-ip": "192.0.2.78" })).status).toBe(202);
  });
});

describe("/api/status", () => {
  const id = "0b7f6a3e-1c2d-4e5f-8a9b-0c1d2e3f4a5b";
  it("forwards a well-formed id", async () => {
    reply = () => [200, { lead_id: id, steps: [] }];
    const r = await fetch(`${base}/api/status?id=${id}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(seen[0].url).toBe(`/webhook/lead-status?id=${id}`);
  });
  it("404s a malformed id without calling n8n", async () => {
    expect((await fetch(`${base}/api/status?id=../../rest`)).status).toBe(404);
    expect(seen).toHaveLength(0);
  });
});

it("RateLimiter keeps separate windows", () => {
  let t = 0;
  const rl = new RateLimiter([{ windowMs: 1000, max: 2 }, { windowMs: 10_000, max: 3 }], () => t);
  expect([rl.take("a").ok, rl.take("a").ok, rl.take("a").ok]).toEqual([true, true, false]);
  t = 1500;
  expect(rl.take("a").ok).toBe(true);
  t = 2600;
  expect(rl.take("a")).toEqual({ ok: false, retryAfterS: 8 });
});
