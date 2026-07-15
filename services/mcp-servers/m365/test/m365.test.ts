// M365 MCP tool-surface tests (instructions.md §14). Run: node --test test/m365.test.ts
// Covers the tool surface end to end via StubM365 (happy path, pagination, 256 KB truncation),
// strict JSON Schema validation (missing/wrong-typed/unknown/over-long args), and E_NOT_FOUND on an
// unknown message id. Real Microsoft Graph error mapping lives in test/graph.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  M365Mcp,
  StubM365,
  capBody,
  TOOL_SCHEMAS,
  type M365Backend,
} from "../src/m365.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "vault:graph" };

// ======================================================================================= surface

test("tool surface is exactly the 5 pre-existing §14 tools, unchanged by name", () => {
  const names = Object.keys(new M365Mcp().tools()).sort();
  assert.deepEqual(names, [
    "m365.create_event",
    "m365.list_mail",
    "m365.read_mail",
    "m365.search_files",
    "m365.send_mail",
  ]);
});

test("every tool has a JSON Schema with additionalProperties: false", () => {
  for (const name of Object.keys(new M365Mcp().tools())) {
    const schema = TOOL_SCHEMAS[name];
    assert.ok(schema, `missing TOOL_SCHEMAS entry for ${name}`);
    assert.equal(schema.inputSchema.additionalProperties, false);
  }
});

test("every tool handler has the (args, ctx) shape the gateway registration relies on", () => {
  const tools = new M365Mcp().tools();
  for (const [name, handler] of Object.entries(tools)) {
    assert.equal(typeof handler, "function", name);
    assert.equal(handler.length, 2, `${name} handler must take exactly (args, ctx)`);
  }
});

// ==================================================================================== happy path

test("m365.list_mail defaults to the inbox folder and returns a page", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.list_mail"]({}, ctx);
  assert.ok(r.items.length >= 1);
  assert.equal(r.truncated, false);
  assert.ok(r.items.some((m: any) => m.id === "m1"));
});

test("m365.list_mail respects an explicit folder", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.list_mail"]({ folder: "archive" }, ctx);
  assert.ok(r.items.some((m: any) => /archive/.test(m.subject)));
});

test("m365.read_mail returns subject/from/body for a known message", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.read_mail"]({ id: "m1" }, ctx);
  assert.equal(r.subject, "Q3 review");
  assert.equal(r.from, "ceo@acme.com");
  assert.match(r.body, /Q3 review/);
  assert.equal(r.truncated, false);
});

test("m365.read_mail returns E_NOT_FOUND for an unknown id", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.read_mail"]({ id: "does-not-exist" }, ctx);
  assert.equal(r.error.code, "E_NOT_FOUND");
});

test("m365.send_mail (approval-gated by tool_policies/gateway taint) returns an id", async () => {
  const t = new M365Mcp().tools();
  assert.ok("m365.send_mail" in t);
  const r: any = await t["m365.send_mail"]({ to: "x@y.com", subject: "hi", body: "b" }, ctx);
  assert.ok(r.id);
});

test("m365.search_files returns a page of file hits mentioning the query", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.search_files"]({ query: "budget" }, ctx);
  assert.ok(r.items.length > 0);
  assert.match(r.items[0].path, /budget/);
  assert.ok(r.items[0].webUrl);
});

test("m365.create_event returns an id", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.create_event"]({ title: "1:1", start: "2026-07-13T09:00Z" }, ctx);
  assert.ok(r.id);
});

// ===================================================================================== pagination

test("m365.list_mail paginates across multiple pages with a cursor", async () => {
  const t = new M365Mcp(new StubM365(), { defaultPageSize: 10 }).tools();
  const page1: any = await t["m365.list_mail"]({}, ctx);
  assert.equal(page1.items.length, 10);
  assert.ok(page1.nextCursor);

  const page2: any = await t["m365.list_mail"]({ cursor: page1.nextCursor }, ctx);
  assert.equal(page2.items.length, 10);
  assert.notEqual(page1.items[0].id, page2.items[0].id);
});

test("m365.list_mail reaches the final page with no nextCursor", async () => {
  const backend: M365Backend = {
    async listMail(_folder, opts) {
      const all = Array.from({ length: 7 }, (_, i) => ({ id: `m${i}`, subject: `s${i}`, from: `u${i}@x.com` }));
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const items = all.slice(start, start + opts.pageSize);
      const next = start + items.length;
      return { items, nextCursor: next < all.length ? String(next) : undefined };
    },
    async readMail() { return null; },
    async sendMail() { return { id: "sent_1" }; },
    async searchFiles() { return { items: [] }; },
    async createEvent() { return { id: "evt_1" }; },
  };
  const t = new M365Mcp(backend, { defaultPageSize: 3 }).tools();
  const p1: any = await t["m365.list_mail"]({}, ctx);
  const p2: any = await t["m365.list_mail"]({ cursor: p1.nextCursor }, ctx);
  const p3: any = await t["m365.list_mail"]({ cursor: p2.nextCursor }, ctx);
  assert.equal(p3.items.length, 1);
  assert.equal(p3.nextCursor, undefined);
});

test("m365.search_files paginates with a cursor", async () => {
  const t = new M365Mcp(new StubM365(), { defaultPageSize: 10 }).tools();
  const page1: any = await t["m365.search_files"]({ query: "x" }, ctx);
  assert.equal(page1.items.length, 10);
  const page2: any = await t["m365.search_files"]({ query: "x", cursor: page1.nextCursor }, ctx);
  assert.equal(page2.items.length, 10);
  assert.notEqual(page1.items[0].path, page2.items[0].path);
});

test("pageSize is clamped to the connector's max page size", async () => {
  const t = new M365Mcp(new StubM365(), { maxPageSize: 5 }).tools();
  const r: any = await t["m365.list_mail"]({ pageSize: 999 }, ctx);
  assert.equal(r.items.length, 5);
});

// ==================================================================== 256 KB response truncation

test("m365.list_mail truncates a large page to 256 KB and flags truncated", async () => {
  const backend: M365Backend = {
    async listMail(_folder, opts) {
      const items = Array.from({ length: opts.pageSize }, (_, i) => ({
        id: `m${i}`, subject: `stub ${i}`, from: `${"y".repeat(2000)}_${i}@x.com`,
      }));
      return { items };
    },
    async readMail() { return null; },
    async sendMail() { return { id: "sent_1" }; },
    async searchFiles() { return { items: [] }; },
    async createEvent() { return { id: "evt_1" }; },
  };
  const t = new M365Mcp(backend, { defaultPageSize: 500, maxPageSize: 500 }).tools();
  const r: any = await t["m365.list_mail"]({ pageSize: 500 }, ctx);
  assert.equal(r.truncated, true);
  assert.ok(r.items.length < 500, "messages must have been dropped to fit the byte budget");
  const rebuilt = JSON.stringify({ items: r.items, nextCursor: r.nextCursor, truncated: true });
  assert.ok(Buffer.byteLength(rebuilt, "utf8") <= 256 * 1024);
});

test("m365.search_files truncates when results are large", async () => {
  const backend: M365Backend = {
    async listMail() { return { items: [] }; },
    async readMail() { return null; },
    async sendMail() { return { id: "sent_1" }; },
    async searchFiles(_q, opts) {
      const items = Array.from({ length: opts.pageSize }, (_, i) => ({
        name: `f${i}`, path: `sites/${"z".repeat(2000)}_${i}`, webUrl: `https://x/${i}`,
      }));
      return { items };
    },
    async createEvent() { return { id: "evt_1" }; },
  };
  const t = new M365Mcp(backend, { defaultPageSize: 500, maxPageSize: 500 }).tools();
  const r: any = await t["m365.search_files"]({ query: "x", pageSize: 500 }, ctx);
  assert.equal(r.truncated, true);
  const rebuilt = JSON.stringify({ items: r.items, nextCursor: r.nextCursor, truncated: true });
  assert.ok(Buffer.byteLength(rebuilt, "utf8") <= 256 * 1024);
});

test("m365.read_mail caps body at 256 KB and flags truncated", async () => {
  const bigBody = "z".repeat(300 * 1024);
  const backend: M365Backend = {
    async listMail() { return { items: [] }; },
    async readMail(id) { return { id, subject: "Huge", from: "a@b.com", body: bigBody }; },
    async sendMail() { return { id: "sent_1" }; },
    async searchFiles() { return { items: [] }; },
    async createEvent() { return { id: "evt_1" }; },
  };
  const t = new M365Mcp(backend).tools();
  const r: any = await t["m365.read_mail"]({ id: "huge" }, ctx);
  assert.equal(r.truncated, true);
  assert.equal(Buffer.byteLength(r.body, "utf8"), 256 * 1024);
});

test("capBody leaves small content untouched and flags large content", () => {
  assert.deepEqual(capBody("hi", 256 * 1024), { content: "hi", truncated: false });
  const big = "x".repeat(256 * 1024 + 10);
  const c = capBody(big, 256 * 1024);
  assert.equal(c.truncated, true);
  assert.equal(Buffer.byteLength(c.content, "utf8"), 256 * 1024);
});

// ============================================================================ schema validation

test("m365.read_mail rejects a missing id", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.read_mail"]({}, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("m365.send_mail rejects a missing to/subject/body", async () => {
  const t = new M365Mcp().tools();
  assert.equal(((await t["m365.send_mail"]({ subject: "s", body: "b" }, ctx)) as any).error.code, "E_VALIDATION");
  assert.equal(((await t["m365.send_mail"]({ to: "x@y.com", body: "b" }, ctx)) as any).error.code, "E_VALIDATION");
  assert.equal(((await t["m365.send_mail"]({ to: "x@y.com", subject: "s" }, ctx)) as any).error.code, "E_VALIDATION");
});

test("m365.search_files rejects a missing query", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.search_files"]({}, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("m365.create_event rejects a missing title or start", async () => {
  const t = new M365Mcp().tools();
  assert.equal(((await t["m365.create_event"]({ start: "2026-07-13T09:00Z" }, ctx)) as any).error.code, "E_VALIDATION");
  assert.equal(((await t["m365.create_event"]({ title: "1:1" }, ctx)) as any).error.code, "E_VALIDATION");
});

test("a wrong-typed field is rejected (pageSize must be a number)", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.list_mail"]({ pageSize: "lots" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /pageSize.*number/);
});

test("an empty-string required field is rejected, not silently accepted", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.read_mail"]({ id: "" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("an over-long string field is rejected (maxLength)", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.send_mail"]({ to: "x@y.com", subject: "s", body: "x".repeat(262145) }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /max length/);
});

test("an unknown field is rejected (additionalProperties: false)", async () => {
  const t = new M365Mcp().tools();
  const r: any = await t["m365.read_mail"]({ id: "m1", extra: "nope" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /unknown field/);
});

test("validation runs before the backend is ever called", async () => {
  let called = false;
  const backend: M365Backend = {
    async listMail() { called = true; return { items: [] }; },
    async readMail() { return null; },
    async sendMail() { return { id: "sent_1" }; },
    async searchFiles() { return { items: [] }; },
    async createEvent() { return { id: "evt_1" }; },
  };
  const t = new M365Mcp(backend).tools();
  await t["m365.list_mail"]({ pageSize: "lots" }, ctx);
  assert.equal(called, false, "an invalid call must never reach the backend");
});

// ======================================================================================= StubM365

test("StubM365 is deterministic and offline (no credential/network needed)", async () => {
  const b = new StubM365();
  const page1 = await b.listMail("inbox", { pageSize: 5 }, ctx);
  const page2 = await b.listMail("inbox", { pageSize: 5 }, ctx);
  assert.deepEqual(page1, page2);
});

test("StubM365's m1 seed keeps mentioning 'Q3 review' (relied on by mcp-gateway's connectors.test.ts)", async () => {
  const b = new StubM365();
  const mail = await b.readMail("m1", ctx);
  assert.match(mail!.subject, /Q3 review/);
});
