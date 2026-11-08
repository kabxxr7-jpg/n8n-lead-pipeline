// Public gateway in front of n8n. The tunnel points here, never at n8n itself.
// It serves the form and status pages, forwards exactly two API routes to n8n
// webhooks, rate limits by client IP, and answers 404 for everything else
// (so the n8n editor, REST API and other webhooks are not reachable from outside).
// No dependencies: Node's http module only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");

const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8" };

const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "Strict-Transport-Security": "max-age=15552000",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** Sliding-window counter per key. */
export class RateLimiter {
  constructor(rules, now = () => Date.now()) {
    this.rules = rules; // [{ windowMs, max }]
    this.now = now;
    this.hits = new Map();
  }
  /** Returns { ok: true } or { ok: false, retryAfterS }. Counts the hit only when allowed. */
  take(key) {
    const t = this.now();
    const longest = Math.max(...this.rules.map((r) => r.windowMs));
    const list = (this.hits.get(key) || []).filter((x) => t - x < longest);
    for (const r of this.rules) {
      const inWindow = list.filter((x) => t - x < r.windowMs);
      if (inWindow.length >= r.max) {
        this.hits.set(key, list);
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((inWindow[0] + r.windowMs - t) / 1000)) };
      }
    }
    list.push(t);
    this.hits.set(key, list);
    if (this.hits.size > 50_000) this.sweep(t, longest);
    return { ok: true };
  }
  sweep(t, longest) {
    for (const [k, v] of this.hits) if (!v.some((x) => t - x < longest)) this.hits.delete(k);
  }
}

function staticFiles() {
  const files = new Map();
  const add = (urlPath, file) => files.set(urlPath, { file, type: TYPES[path.extname(file)] || "application/octet-stream" });
  add("/", path.join(PUBLIC_DIR, "index.html"));
  add("/status", path.join(PUBLIC_DIR, "status.html"));
  const assets = path.join(PUBLIC_DIR, "assets");
  for (const name of fs.readdirSync(assets)) {
    if (/^[\w.-]+$/.test(name) && TYPES[path.extname(name)]) add(`/assets/${name}`, path.join(assets, name));
  }
  if (fs.existsSync(path.join(assets, "favicon.svg"))) add("/favicon.ico", path.join(assets, "favicon.svg"));
  return files;
}

export function createGateway({
  upstream = process.env.N8N_INTERNAL_URL || "http://127.0.0.1:5680",
  trustCloudflare = process.env.TRUST_CF_HEADER !== "0",
  leadLimiter = new RateLimiter([{ windowMs: 10 * 60e3, max: 6 }, { windowMs: 24 * 3600e3, max: 30 }]),
  statusLimiter = new RateLimiter([{ windowMs: 60e3, max: 120 }]),
  upstreamTimeoutMs = 20_000,
  log = (line) => console.log(line),
} = {}) {
  const files = staticFiles();

  function send(res, status, body, headers = {}) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, { ...SECURITY_HEADERS, "Content-Length": buf.length, ...headers });
    res.end(res.req.method === "HEAD" ? undefined : buf);
  }
  const json = (res, status, obj, extra = {}) => send(res, status, obj, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...extra });

  function clientIp(req) {
    const cf = req.headers["cf-connecting-ip"];
    if (trustCloudflare && typeof cf === "string" && cf.length < 64) return cf.trim();
    return req.socket.remoteAddress || "unknown";
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      // Over the limit: stop keeping data but read on, so the 413 answer reaches the client.
      // A client that keeps streaming far past the limit is cut off.
      req.on("data", (c) => {
        size += c.length;
        if (size <= limit) chunks.push(c);
        else if (size > limit * 64) req.destroy();
      });
      req.on("end", () => (size > limit ? reject(Object.assign(new Error("too large"), { code: 413 })) : resolve(Buffer.concat(chunks))));
      req.on("error", reject);
    });
  }

  async function forward(res, method, webhookPath, body) {
    try {
      const r = await fetch(`${upstream}/webhook/${webhookPath}`, {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        body,
        signal: AbortSignal.timeout(upstreamTimeoutMs),
      });
      const text = await r.text();
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        return json(res, 502, { ok: false, error: "upstream" });
      }
      // only pass on the statuses the workflows are designed to return
      const allowed = [200, 202, 400, 404, 422, 429, 503];
      return json(res, allowed.includes(r.status) ? r.status : 502, allowed.includes(r.status) ? parsed : { ok: false, error: "upstream" });
    } catch {
      return json(res, 502, { ok: false, error: "upstream" });
    }
  }

  async function handle(req, res) {
    const url = new URL(req.url, "http://gateway.local");
    const p = url.pathname;
    const m = req.method;

    if (p === "/healthz" && (m === "GET" || m === "HEAD")) return json(res, 200, { ok: true });

    if (p === "/api/lead") {
      if (m !== "POST") return json(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "POST" });
      if (!/^application\/json\b/i.test(req.headers["content-type"] || "")) return json(res, 415, { ok: false, error: "json_required" });
      let raw;
      try {
        raw = await readBody(req, 16 * 1024);
      } catch (e) {
        return json(res, e.code === 413 ? 413 : 400, { ok: false, error: e.code === 413 ? "too_large" : "bad_request" });
      }
      let body;
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        return json(res, 400, { ok: false, error: "invalid", fields: { form: "The request was not valid JSON." } });
      }
      if (body === null || typeof body !== "object" || Array.isArray(body)) {
        return json(res, 400, { ok: false, error: "invalid", fields: { form: "The request body must be a JSON object." } });
      }
      const lim = leadLimiter.take(clientIp(req));
      if (!lim.ok) return json(res, 429, { ok: false, error: "rate_limited", retry_after_s: lim.retryAfterS }, { "Retry-After": String(lim.retryAfterS) });
      return forward(res, "POST", "lead-intake", JSON.stringify(body));
    }

    if (p === "/api/status") {
      if (m !== "GET" && m !== "HEAD") return json(res, 405, { ok: false, error: "method_not_allowed" }, { Allow: "GET" });
      const id = url.searchParams.get("id") || "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return json(res, 404, { error: "not_found" });
      const lim = statusLimiter.take(clientIp(req));
      if (!lim.ok) return json(res, 429, { ok: false, error: "rate_limited", retry_after_s: lim.retryAfterS });
      return forward(res, "GET", `lead-status?id=${encodeURIComponent(id)}`);
    }

    const f = files.get(p === "/index.html" ? "/" : p === "/status.html" ? "/status" : p);
    if (f && (m === "GET" || m === "HEAD")) {
      const isHtml = f.type.startsWith("text/html");
      return send(res, 200, fs.readFileSync(f.file), { "Content-Type": f.type, "Cache-Control": isHtml ? "no-cache" : "public, max-age=300" });
    }
    return send(res, 404, "Not found\n", { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  }

  const server = http.createServer((req, res) => {
    const t0 = Date.now();
    res.on("finish", () => log(`${new Date().toISOString()} ${req.method} ${req.url.split("?")[0]} ${res.statusCode} ${Date.now() - t0}ms`));
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { ok: false, error: "internal" });
      else res.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  const port = Number(process.env.GATEWAY_PORT || 5678);
  const host = process.env.GATEWAY_HOST || "127.0.0.1";
  createGateway().listen(port, host, () => console.log(`gateway on http://${host}:${port} -> ${process.env.N8N_INTERNAL_URL || "http://127.0.0.1:5680"}`));
}
