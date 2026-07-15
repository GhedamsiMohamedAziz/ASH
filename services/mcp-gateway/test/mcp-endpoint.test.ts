// MCP Streamable-HTTP endpoint tests (instructions.md §13). Proves the REAL gateway now exposes the
// MCP JSON-RPC surface opencode speaks (POST /mcp) and that it reuses the SAME auth path as the REST
// route: every tools/call is delegated to gw.call(), so the full chain (TASK_JWT verify → allowed_tools
// → approval → taint → DLP → audit) runs unchanged. tools/list is JWT-gated and reflects ONLY the
// token's allowed_tools; no/invalid JWT fails closed. Exercised KEYLESSLY (StubBackend). Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildGateway, createGatewayServer } from "../src/server.ts";
import type { McpGateway } from "../src/gateway.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";

// A TASK JWT valid against real wall-clock (buildGateway uses requireExp + real time, no `now`).
function taskJwt(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: "usr_1", org_id: "org_1",
    iss: "olma-prompt-layer", aud: "olma-mcp-gateway",
    iat: now - 5, exp: now + 3600,
    allowed_tools: ["github.search"], approval_tools: [],
    ...overrides,
  }, SECRET);
}

async function listen(server: ReturnType<typeof createGatewayServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

// POST one JSON-RPC message to /mcp; returns { status, json }. Omit jwt to send no Authorization header.
async function rpc(
  server: ReturnType<typeof createGatewayServer>,
  msg: unknown,
  jwt?: string,
): Promise<{ status: number; json: any }> {
  const { port } = server.address() as AddressInfo;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (jwt) headers["authorization"] = `Bearer ${jwt}`;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify(msg),
  });
  const status = res.status;
  const raw = await res.text();
  return { status, json: raw ? JSON.parse(raw) : undefined };
}

// buildGateway defaults to StubBackend only when GITHUB_TOKEN is unset. Guard it for the whole file.
function withServer(fn: (server: ReturnType<typeof createGatewayServer>, gw: McpGateway) => Promise<void>) {
  return async () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const gw = buildGateway();
    const server = createGatewayServer(gw);
    await listen(server);
    try {
      await fn(server, gw);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
    }
  };
}

test("initialize handshake returns protocolVersion + serverInfo", withServer(async (server) => {
  const { status, json } = await rpc(server, {
    jsonrpc: "2.0", id: 1, method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "opencode", version: "x" } },
  });
  assert.equal(status, 200);
  assert.equal(json.id, 1);
  assert.equal(json.result.protocolVersion, "2025-06-18");
  assert.equal(json.result.serverInfo.name, "olma-mcp-gateway");
  assert.ok(json.result.capabilities.tools);
}));

test("notifications/initialized is accepted with 202 and no body", withServer(async (server) => {
  const { status, json } = await rpc(server, { jsonrpc: "2.0", method: "notifications/initialized" }, taskJwt());
  assert.equal(status, 202);
  assert.equal(json, undefined);
}));

test("tools/list is JWT-gated and reflects ONLY allowed_tools", withServer(async (server) => {
  // Token allows only github.search → only github_search is listed (create_pr etc. hidden).
  const narrow = await rpc(server, { jsonrpc: "2.0", id: 2, method: "tools/list" }, taskJwt());
  assert.equal(narrow.status, 200);
  const narrowNames = narrow.json.result.tools.map((t: any) => t.name);
  assert.deepEqual(narrowNames, ["github_search"]);
  assert.ok(narrow.json.result.tools[0].inputSchema, "list entries carry an inputSchema");

  // A broader token surfaces exactly the allowed set — no more, no less.
  const wide = await rpc(server, { jsonrpc: "2.0", id: 3, method: "tools/list" },
    taskJwt({ allowed_tools: ["github.search", "github.create_pr"] }));
  const wideNames = wide.json.result.tools.map((t: any) => t.name).sort();
  assert.deepEqual(wideNames, ["github_create_pr", "github_search"]);
}));

test("tools/list with no JWT fails closed (E_AUTH_INVALID_TOKEN), no catalog leak", withServer(async (server) => {
  const { status, json } = await rpc(server, { jsonrpc: "2.0", id: 4, method: "tools/list" }); // no auth header
  assert.equal(status, 200); // JSON-RPC transport ok…
  assert.equal(json.result, undefined); // …but no tools returned
  assert.equal(json.error.data.code, "E_AUTH_INVALID_TOKEN");
}));

test("tools/call for an allowed tool succeeds and produces an audit record", withServer(async (server, gw) => {
  const before = gw.audit.length;
  const { status, json } = await rpc(server, {
    jsonrpc: "2.0", id: 5, method: "tools/call",
    params: { name: "github_search", arguments: { query: "login" } },
  }, taskJwt());
  assert.equal(status, 200);
  assert.equal(json.result.isError, false);
  assert.match(json.result.content[0].text, /src\/login\.ts/); // deterministic stub output
  // The call traversed the real gateway → an append-only audit row for the canonical tool name.
  assert.equal(gw.audit.length, before + 1);
  assert.equal(gw.audit.at(-1)?.tool, "github.search");
  assert.equal(gw.audit.at(-1)?.status, "ok");
}));

test("tools/call for a NOT-allowed tool is denied (E_PERM_TOOL_DENIED)", withServer(async (server, gw) => {
  // Token allows only github.search; github_create_pr → github.create_pr is not in allowed_tools.
  const { json } = await rpc(server, {
    jsonrpc: "2.0", id: 6, method: "tools/call",
    params: { name: "github_create_pr", arguments: { repo: "acme/x", head: "h", base: "main", title: "t" } },
  }, taskJwt());
  assert.equal(json.result.isError, true);
  assert.match(json.result.content[0].text, /E_PERM_TOOL_DENIED/);
  assert.equal(gw.audit.at(-1)?.status, "denied"); // the denial is audited, fail-closed
}));

test("tools/call with no JWT fails closed (E_AUTH_INVALID_TOKEN)", withServer(async (server) => {
  const { json } = await rpc(server, {
    jsonrpc: "2.0", id: 7, method: "tools/call",
    params: { name: "github_search", arguments: { query: "x" } },
  }); // no auth header
  assert.equal(json.result.isError, true);
  assert.match(json.result.content[0].text, /E_AUTH_INVALID_TOKEN/);
}));

test("tools/call with an invalid/forged JWT fails closed (E_AUTH_INVALID_TOKEN)", withServer(async (server) => {
  const { json } = await rpc(server, {
    jsonrpc: "2.0", id: 8, method: "tools/call",
    params: { name: "github_search", arguments: { query: "x" } },
  }, taskJwt() + "tamper");
  assert.equal(json.result.isError, true);
  assert.match(json.result.content[0].text, /E_AUTH_INVALID_TOKEN/);
}));

test("GET /mcp is handled (405, no SSE stream) — REST routes preserved", withServer(async (server) => {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, { method: "GET" });
  assert.equal(res.status, 405);
  const json = (await res.json()) as any;
  assert.equal(json.error.code, -32000);
  // And a preserved REST route still works alongside the new endpoint.
  const health = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(health.status, 200);
}));
