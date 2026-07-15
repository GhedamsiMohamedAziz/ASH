// Standalone MCP streamable-HTTP bootstrap for this connector (instructions.md §14: "chaque
// serveur MCP est un déploiement indépendant... parlant MCP en streamable HTTP, accessible
// UNIQUEMENT depuis la Gateway"). Mirrors the JSON-RPC framing in
// services/mcp-gateway/src/mcp.ts (initialize / tools.list / tools.call / ping / notifications) —
// the "SDK MCP" referenced in §14.3 is this dependency-free JSON-RPC surface, not an external
// package, matching how github.ts's tools() are actually mounted in this repo today.
//
// AuthN/AuthZ (TASK JWT verification, allowed_tools, approval, taint, DLP, audit) all live in the
// Gateway (§13) and are NOT reimplemented here — this server trusts the ctx the Gateway forwards
// and focuses on what's this connector's own job: strict JSON Schema validation, pagination +
// 256 KB truncation (connector.ts / pagination.ts), retries/breaker on its own egress (rest.ts),
// and an OTel span per call (otel.ts). NetworkPolicy (§14.3 N2, infra/helm/networkpolicy-sandbox.yaml
// for the analogous sandbox lockdown) restricts inbound to the Gateway only in prod.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { TemplateMcp, StubBackend, type ToolContext } from "./connector.ts";
import { RestBackend } from "./rest.ts";

const PROTOCOL_VERSION = "2025-06-18";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string }>;
    required?: string[];
  };
}

// TODO(connector): one entry per tool exposed by connector.ts's tools(); keep name + schema in
// sync with that map. Strict JSON Schema per instructions.md §14 "règles communes".
export const TOOL_DEFS: ToolDef[] = [
  {
    name: "example.read",
    description: "Read a paginated, size-bounded page of items for a resource (template example tool).",
    inputSchema: {
      type: "object",
      properties: {
        resource: { type: "string" },
        cursor: { type: "string" },
        pageSize: { type: "number" },
      },
      required: ["resource"],
    },
  },
];

// Minimal strict validation — dependency-free by design, matching the template's zero-dep goal.
// Checks required fields are present and declared-typed fields match. TODO(connector): swap for a
// real JSON Schema validator (e.g. ajv) if a connector's schemas grow past required+type checks.
export function validateArgs(def: ToolDef, args: Record<string, unknown>): string | null {
  for (const key of def.inputSchema.required ?? []) {
    if (args[key] === undefined || args[key] === null) return `missing required field "${key}"`;
  }
  for (const [key, spec] of Object.entries(def.inputSchema.properties)) {
    if (args[key] === undefined) continue;
    const actual = typeof args[key];
    if (spec.type === "number" && actual !== "number") return `field "${key}" must be a number`;
    if (spec.type === "string" && actual !== "string") return `field "${key}" must be a string`;
  }
  return null;
}

// TODO(connector): swap this condition for the real "do we have a live credential/config" check,
// matching github's server.ts (RestBackend when a token/env is present, StubBackend otherwise).
function buildBackend() {
  return process.env.OLMA_TEMPLATE_LIVE === "1" ? new RestBackend() : new StubBackend();
}

export function buildMcp(): TemplateMcp {
  return new TemplateMcp(buildBackend());
}

export function bearer(auth: string | string[] | undefined): string {
  const h = Array.isArray(auth) ? auth[0] : auth ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : "";
}

// The ctx the Gateway is expected to forward per call. TODO(connector): if this server is ever
// invoked directly in a non-prod environment (bypassing the Gateway), derive userId/orgId from
// the bearer token itself instead of trusting headers — prod traffic always arrives via the
// Gateway, which is the only thing on this server's NetworkPolicy allow-list (§14.3 N2).
function ctxFrom(req: IncomingMessage): ToolContext {
  return {
    userId: String(req.headers["x-olma-user-id"] ?? "anonymous"),
    orgId: String(req.headers["x-olma-org-id"] ?? "unknown"),
    credential: bearer(req.headers["authorization"]),
  };
}

// Handle one MCP JSON-RPC message. Returns a response object, or null for a notification.
export async function handleMcpRpc(mcp: TemplateMcp, ctx: ToolContext, msg: any): Promise<any | null> {
  const { id, method, params } = msg ?? {};

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "olma-mcp-server-template", version: "0.1.0" },
      },
    };
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    const tools = TOOL_DEFS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    return { jsonrpc: "2.0", id, result: { tools } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const def = TOOL_DEFS.find((t) => t.name === name);
    if (!def) {
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "unknown tool" }], isError: true } };
    }
    const invalid = validateArgs(def, args);
    if (invalid) {
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `E_VALIDATION: ${invalid}` }], isError: true },
      };
    }
    try {
      const tool = mcp.tools()[def.name];
      const result = await tool(args, ctx);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }], isError: false } };
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      return {
        jsonrpc: "2.0", id,
        result: { content: [{ type: "text", text: `E_TOOL_UPSTREAM_ERROR: ${message}` }], isError: true },
      };
    }
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
}

export function createMcpServer(mcp: TemplateMcp = buildMcp()) {
  return createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz") return send(200, { status: "ok" });
    if (req.url !== "/mcp") return send(404, { error: { code: "E_NOT_FOUND", message: "not found" } });
    if (req.method === "GET") {
      // No server->client SSE channel offered; MCP StreamableHTTP clients tolerate 405 here and
      // proceed over POST (JSON-response mode) — mirrors mcp-gateway/src/server.ts's /mcp route.
      return send(405, { jsonrpc: "2.0", error: { code: -32000, message: "no SSE stream" } });
    }
    if (req.method !== "POST") {
      res.writeHead(405);
      return res.end();
    }

    // Fail-closed resource bounds: parsing precedes any auth, so an unbounded body/batch is a
    // shared-availability DoS even for a single connector.
    const MAX_BODY = 1 << 20; // 1 MiB
    const MAX_BATCH = 50;
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) return send(413, { jsonrpc: "2.0", error: { code: -32000, message: "payload too large" } });
    }
    let body: any;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } });
    }
    const ctx = ctxFrom(req);
    const batched = Array.isArray(body);
    if (batched && body.length > MAX_BATCH) {
      return send(400, { jsonrpc: "2.0", error: { code: -32600, message: "batch too large" } });
    }
    const msgs = batched ? body : [body];
    const responses: any[] = [];
    for (const m of msgs) {
      const r = await handleMcpRpc(mcp, ctx, m);
      if (r) responses.push(r);
    }
    if (responses.length === 0) {
      res.writeHead(202);
      return res.end();
    }
    return send(200, batched ? responses : responses[0]);
  });
}

// Boot when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8090);
  createMcpServer().listen(port, () => console.log(`mcp-server-template on :${port}`));
}
