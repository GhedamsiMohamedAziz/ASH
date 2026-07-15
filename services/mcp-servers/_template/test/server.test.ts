// MCP streamable-HTTP JSON-RPC layer tests (server.ts). Run: node --test test/server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TemplateMcp, StubBackend } from "../src/connector.ts";
import { handleMcpRpc, validateArgs, TOOL_DEFS } from "../src/server.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "vault:stub" };

test("initialize returns protocol info", async () => {
  const mcp = new TemplateMcp(new StubBackend());
  const r = await handleMcpRpc(mcp, ctx, { id: 1, method: "initialize", params: {} });
  assert.equal(r.result.serverInfo.name, "olma-mcp-server-template");
});

test("notifications/* return null (no response body)", async () => {
  const mcp = new TemplateMcp(new StubBackend());
  const r = await handleMcpRpc(mcp, ctx, { method: "notifications/initialized" });
  assert.equal(r, null);
});

test("tools/list exposes example.read with its JSON Schema", async () => {
  const mcp = new TemplateMcp(new StubBackend());
  const r = await handleMcpRpc(mcp, ctx, { id: 2, method: "tools/list", params: {} });
  const names = r.result.tools.map((t: any) => t.name);
  assert.deepEqual(names, ["example.read"]);
  assert.deepEqual(r.result.tools[0].inputSchema.required, ["resource"]);
});

test("tools/call runs example.read through the StubBackend end to end", async () => {
  const mcp = new TemplateMcp(new StubBackend());
  const r = await handleMcpRpc(mcp, ctx, {
    id: 3, method: "tools/call", params: { name: "example.read", arguments: { resource: "widgets" } },
  });
  assert.equal(r.result.isError, false);
  const page = JSON.parse(r.result.content[0].text);
  assert.equal(page.items.length, 20);
});

test("tools/call rejects a call missing the required 'resource' field before touching the backend", async () => {
  const mcp = new TemplateMcp(new StubBackend());
  const r = await handleMcpRpc(mcp, ctx, {
    id: 4, method: "tools/call", params: { name: "example.read", arguments: {} },
  });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /E_VALIDATION/);
});

test("tools/call on an unknown tool name is an error, not a crash", async () => {
  const mcp = new TemplateMcp(new StubBackend());
  const r = await handleMcpRpc(mcp, ctx, {
    id: 5, method: "tools/call", params: { name: "example.delete_everything", arguments: {} },
  });
  assert.equal(r.result.isError, true);
});

test("validateArgs enforces declared field types", () => {
  const def = TOOL_DEFS[0];
  assert.equal(validateArgs(def, { resource: "x", pageSize: "not-a-number" }), 'field "pageSize" must be a number');
  assert.equal(validateArgs(def, { resource: "x", pageSize: 5 }), null);
});
