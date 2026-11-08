// Minimal builder for n8n workflow JSON. Keeps node ids deterministic so the
// committed exports diff cleanly, and keeps positions on a readable grid.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const CODE_DIR = path.resolve(here, "../code");

export function uuidFrom(...parts) {
  const h = crypto.createHash("sha1").update(parts.join("|")).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Read a Code-node body from src/code and expand `//@include file.js` lines. */
export function codeFile(name) {
  const read = (n) => fs.readFileSync(path.join(CODE_DIR, n), "utf8");
  return read(name)
    .replace(/^\/\/@include (\S+)\s*$/gm, (_, inc) => read(inc).trimEnd())
    .trimEnd();
}

/** Grid position helper: col/row -> [x, y]. */
export const at = (col, row) => [col * 250, row * 170];

export class Flow {
  constructor(name, { id, settings = {}, tags } = {}) {
    this.name = name;
    this.id = id;
    this.settings = { executionOrder: "v1", ...settings };
    this.nodes = [];
    this.connections = {};
    this.tags = tags;
  }

  add(name, type, typeVersion, parameters, pos, extra = {}) {
    if (this.nodes.some((n) => n.name === name)) throw new Error(`duplicate node name: ${name}`);
    const node = {
      parameters,
      id: uuidFrom(this.name, name),
      name,
      type,
      typeVersion,
      position: pos,
      ...extra,
    };
    this.nodes.push(node);
    return name;
  }

  /** connect(from, to, fromOutput = 0) */
  connect(from, to, fromOutput = 0) {
    const c = (this.connections[from] ??= { main: [] });
    while (c.main.length <= fromOutput) c.main.push([]);
    c.main[fromOutput].push({ node: to, type: "main", index: 0 });
    return this;
  }

  // ---- node helpers --------------------------------------------------

  webhook(name, { path: p, pos, note }) {
    return this.add(
      name,
      "n8n-nodes-base.webhook",
      2.2,
      { httpMethod: "POST", path: p, responseMode: "responseNode", options: {} },
      pos,
      { webhookId: uuidFrom(this.name, name, "webhook"), ...(note ? { notes: note } : {}) },
    );
  }

  code(name, js, pos, { mode = "runOnceForAllItems", note } = {}) {
    return this.add(name, "n8n-nodes-base.code", 2, { mode, language: "javaScript", jsCode: js }, pos, note ? { notes: note } : {});
  }

  /** IF on a boolean expression, e.g. ifTrue("Valid?", "$json.valid === true", pos) */
  ifTrue(name, expr, pos) {
    return this.add(
      name,
      "n8n-nodes-base.if",
      2.2,
      {
        conditions: {
          options: { caseSensitive: true, leftValue: "", typeValidation: "strict", version: 2 },
          conditions: [
            {
              id: uuidFrom(this.name, name, "cond"),
              leftValue: `={{ ${expr} }}`,
              rightValue: "",
              operator: { type: "boolean", operation: "true", singleValue: true },
            },
          ],
          combinator: "and",
        },
        options: {},
      },
      pos,
    );
  }

  respond(name, { code, body, pos }) {
    const options = { responseCode: code };
    return this.add(
      name,
      "n8n-nodes-base.respondToWebhook",
      1.5,
      { respondWith: "json", responseBody: `={{ ${body} }}`, options },
      pos,
    );
  }

  /**
   * HTTP Request. `json` is an expression body (without {{ }}), `raw` a raw string
   * expression. `full` returns {statusCode, body, headers} and never throws on 4xx/5xx.
   */
  http(name, { method = "GET", url, query, headers, json, raw, rawType, full = false, timeout, pagination, pos, node = {} }) {
    const parameters = { method, url };
    if (query) {
      parameters.sendQuery = true;
      parameters.queryParameters = { parameters: Object.entries(query).map(([k, v]) => ({ name: k, value: v })) };
    }
    if (headers) {
      parameters.sendHeaders = true;
      parameters.headerParameters = { parameters: Object.entries(headers).map(([k, v]) => ({ name: k, value: v })) };
    }
    if (json !== undefined) {
      parameters.sendBody = true;
      parameters.contentType = "json";
      parameters.specifyBody = "json";
      parameters.jsonBody = `={{ ${json} }}`;
    }
    if (raw !== undefined) {
      parameters.sendBody = true;
      parameters.contentType = "raw";
      parameters.rawContentType = rawType ?? "application/json";
      parameters.body = raw;
    }
    const options = {};
    if (timeout) options.timeout = timeout;
    if (full) options.response = { response: { fullResponse: true, neverError: true, responseFormat: "json" } };
    if (pagination) options.pagination = { pagination: pagination };
    parameters.options = options;
    return this.add(name, "n8n-nodes-base.httpRequest", 4.5, parameters, pos, node);
  }

  toJSON() {
    const out = {
      ...(this.id ? { id: this.id } : {}),
      name: this.name,
      nodes: this.nodes,
      connections: this.connections,
      settings: this.settings,
      pinData: {},
      meta: { templateCredsSetupCompleted: true, instanceId: "lead-pipeline" },
      active: false,
    };
    return out;
  }
}

export function stableStringify(obj) {
  return JSON.stringify(obj, null, 2) + "\n";
}
