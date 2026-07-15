// Browser MCP tool-surface tests (instructions.md §14). Run: node --test test/browser.test.ts
// Covers the happy-path read via StubFetch, the 256 KB truncation cap, SSRF/allow-list rejection
// at the tool boundary, and 3 integration cases THROUGH the gateway (allowed / denied).
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserMcp, StubFetch, cap, MAX_BYTES, type BrowserBackend, type RawResponse } from "../src/browser.ts";
import { SsrfError } from "../src/ssrf.ts";
import { McpGateway } from "../../../mcp-gateway/src/gateway.ts";
import { sign } from "../../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";
const ctx = { userId: "usr_1", orgId: "org_1", credential: "vault:browser" };
const ALLOW = () => ["example.com"];

// Egress metadata (§17.6.2): browse reads ingest untrusted web content; they do not egress out.
const BR_META = { ingestsUntrusted: true, egressClass: "none" as const };

function jwtWith(allowed: string[], approval: string[] = []): string {
  return sign(
    { sub: "usr_1", org_id: "org_1", iat: 1000, exp: 2000, allowed_tools: allowed, approval_tools: approval },
    SECRET,
  );
}

// ---------------------------------------------------------------- unit: tool surface
test("read_page returns extracted title + text via StubFetch (offline)", async () => {
  const t = new BrowserMcp({ allowList: ALLOW }).tools();
  const r = (await t["browser.read_page"]({ url: "https://example.com/docs" }, ctx)) as any;
  assert.equal(r.status, 200);
  assert.equal(r.title, "Stub page for example.com");
  assert.match(r.text, /Hello from example\.com/);
  assert.equal(r.truncated, false);
});

test("fetch returns the raw (capped) body", async () => {
  const t = new BrowserMcp({ allowList: ALLOW }).tools();
  const r = (await t["browser.fetch"]({ url: "https://example.com/" }, ctx)) as any;
  assert.match(r.body, /<title>Stub page for example\.com<\/title>/);
  assert.equal(r.truncated, false);
});

test("responses are truncated to 256 KB (§14)", async () => {
  const t = new BrowserMcp({ allowList: ALLOW }).tools();
  const r = (await t["browser.fetch"]({ url: "https://example.com/big" }, ctx)) as any;
  assert.equal(r.truncated, true);
  assert.equal(r.bytes, 300 * 1024); // original size reported
  assert.equal(Buffer.byteLength(r.body, "utf8"), MAX_BYTES); // delivered body capped
});

test("cap() leaves small bodies untouched and flags large ones", () => {
  assert.deepEqual(cap("hi"), { content: "hi", truncated: false, bytes: 2 });
  const big = "x".repeat(MAX_BYTES + 10);
  const c = cap(big);
  assert.equal(c.truncated, true);
  assert.equal(c.bytes, MAX_BYTES + 10);
  assert.equal(Buffer.byteLength(c.content, "utf8"), MAX_BYTES);
});

// ---------------------------------------------------------------- SSRF/allow-list at the tool boundary
test("read_page rejects an internal host (SSRF gate fires before fetch)", async () => {
  const t = new BrowserMcp({ allowList: ALLOW }).tools();
  await assert.rejects(
    () => t["browser.read_page"]({ url: "http://127.0.0.1/x" }, ctx),
    (e: any) => e instanceof SsrfError && e.code === "E_GUARD_INPUT_BLOCKED",
  );
});

test("read_page rejects a non-allow-listed public host (default deny)", async () => {
  const t = new BrowserMcp({ allowList: ALLOW }).tools();
  await assert.rejects(
    () => t["browser.read_page"]({ url: "https://not-listed.example.org/" }, ctx),
    (e: any) => e instanceof SsrfError && /not-on-allow-list/.test(e.reason),
  );
});

test("fetch rejects a non-http scheme", async () => {
  const t = new BrowserMcp({ allowList: ALLOW }).tools();
  await assert.rejects(
    () => t["browser.fetch"]({ url: "file:///etc/passwd" }, ctx),
    (e: any) => e instanceof SsrfError && /scheme/.test(e.reason),
  );
});

test("the SSRF gate runs before the backend is ever called", async () => {
  let called = false;
  const spy: BrowserBackend = { async fetch(): Promise<RawResponse> { called = true; return { status: 200, contentType: "text/plain", body: "" }; } };
  const t = new BrowserMcp({ backend: spy, allowList: ALLOW }).tools();
  await assert.rejects(() => t["browser.fetch"]({ url: "http://169.254.169.254/" }, ctx));
  assert.equal(called, false, "backend must not be reached for a blocked host");
});

// ---------------------------------------------------------------- integration through the gateway
test("gateway routes an allowed browse tool to the MCP backend", async () => {
  const gw = new McpGateway(SECRET, { now: 1500 });
  const mcp = new BrowserMcp({ backend: new StubFetch(), allowList: ALLOW });
  for (const [name, fn] of Object.entries(mcp.tools())) {
    gw.register(name, async (args, gctx) => JSON.stringify(await fn(args, gctx)), BR_META);
  }
  const r = await gw.call({
    tool: "browser.read_page",
    args: { url: "https://example.com/" },
    taskJwt: jwtWith(["browser.read_page"]),
  });
  assert.equal(r.status, "ok");
  const page = JSON.parse(r.result!);
  assert.equal(page.title, "Stub page for example.com");
  assert.equal(gw.audit.at(-1)?.tool, "browser.read_page");
});

test("gateway blocks a browse tool absent from the TASK JWT (defense in depth)", async () => {
  const gw = new McpGateway(SECRET, { now: 1500 });
  const mcp = new BrowserMcp({ allowList: ALLOW });
  for (const [name, fn] of Object.entries(mcp.tools())) {
    gw.register(name, async (args, gctx) => JSON.stringify(await fn(args, gctx)), BR_META);
  }
  const r = await gw.call({
    tool: "browser.fetch",
    args: { url: "https://example.com/" },
    taskJwt: jwtWith(["browser.read_page"]), // fetch not granted
  });
  assert.equal(r.status, "denied");
  assert.equal(r.code, "E_PERM_TOOL_DENIED");
});
