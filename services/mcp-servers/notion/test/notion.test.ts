// Notion MCP tool-surface tests (instructions.md §14). Run: node --test test/notion.test.ts
// Covers the tool surface end to end via StubNotion (happy path, pagination, 256 KB truncation),
// strict JSON Schema validation (missing/wrong-typed/unknown/over-long args), and E_NOT_FOUND on
// an unknown page id. Real Notion API error mapping lives in test/api.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NotionMcp,
  StubNotion,
  capContent,
  TOOL_SCHEMAS,
  type NotionBackend,
} from "../src/notion.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "vault:notion" };

// ======================================================================================= surface

test("tool surface is exactly the §14 tools: search, read_page, create_page, update_page", () => {
  const names = Object.keys(new NotionMcp().tools()).sort();
  assert.deepEqual(names, ["notion.create_page", "notion.read_page", "notion.search", "notion.update_page"]);
});

test("every tool has a JSON Schema with additionalProperties: false", () => {
  for (const name of Object.keys(new NotionMcp().tools())) {
    const schema = TOOL_SCHEMAS[name];
    assert.ok(schema, `missing TOOL_SCHEMAS entry for ${name}`);
    assert.equal(schema.inputSchema.additionalProperties, false);
  }
});

// ==================================================================================== happy path

test("notion.search finds a seeded page by title", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.search"]({ query: "Q3" }, ctx);
  assert.ok(r.items.some((p: any) => p.id === "pg_1"));
  assert.match(r.items.find((p: any) => p.id === "pg_1").url, /notion/);
});

test("notion.search finds a seeded page by content", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.search"]({ query: "onboarding v2" }, ctx);
  assert.ok(r.items.some((p: any) => p.id === "pg_1"));
});

test("notion.read_page returns title + content + url for a known page", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.read_page"]({ id: "pg_1" }, ctx);
  assert.equal(r.title, "Q3 Spec");
  assert.match(r.content, /roadmap/);
  assert.match(r.url, /notion/);
  assert.equal(r.truncated, false);
});

test("notion.read_page returns E_NOT_FOUND for an unknown id", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.read_page"]({ id: "does-not-exist" }, ctx);
  assert.equal(r.error.code, "E_NOT_FOUND");
});

test("notion.create_page creates a page under a parent and it becomes readable/searchable", async () => {
  const t = new NotionMcp().tools();
  const created: any = await t["notion.create_page"]({ parentId: "pg_1", title: "New Spec", content: "draft body" }, ctx);
  assert.match(created.url, /notion/);
  assert.ok(created.id);

  const read: any = await t["notion.read_page"]({ id: created.id }, ctx);
  assert.equal(read.title, "New Spec");
  assert.match(read.content, /draft body/);
});

test("notion.update_page renames a page (title only)", async () => {
  const t = new NotionMcp().tools();
  const created: any = await t["notion.create_page"]({ parentId: "pg_1", title: "Old Name" }, ctx);
  const updated: any = await t["notion.update_page"]({ id: created.id, title: "New Name" }, ctx);
  assert.equal(updated.updated, true);

  const read: any = await t["notion.read_page"]({ id: created.id }, ctx);
  assert.equal(read.title, "New Name");
});

test("notion.update_page appends content without touching the title", async () => {
  const t = new NotionMcp().tools();
  const created: any = await t["notion.create_page"]({ parentId: "pg_1", title: "Notes", content: "line one" }, ctx);
  await t["notion.update_page"]({ id: created.id, appendContent: "line two" }, ctx);

  const read: any = await t["notion.read_page"]({ id: created.id }, ctx);
  assert.equal(read.title, "Notes");
  assert.match(read.content, /line one/);
  assert.match(read.content, /line two/);
});

test("notion.update_page returns E_NOT_FOUND for an unknown id", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.update_page"]({ id: "nope", title: "x" }, ctx);
  assert.equal(r.error.code, "E_NOT_FOUND");
});

test("notion.update_page rejects a call with neither title nor appendContent", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.update_page"]({ id: "pg_1" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /at least one/);
});

// ===================================================================================== pagination

test("notion.search paginates across multiple pages with a cursor", async () => {
  const t = new NotionMcp(new StubNotion(), { defaultPageSize: 10 }).tools();
  const page1: any = await t["notion.search"]({ query: "stub" }, ctx);
  assert.equal(page1.items.length, 10);
  assert.ok(page1.nextCursor);

  const page2: any = await t["notion.search"]({ query: "stub", cursor: page1.nextCursor }, ctx);
  assert.equal(page2.items.length, 10);
  assert.notEqual(page1.items[0].id, page2.items[0].id);
});

test("notion.search reaches the final page with no nextCursor", async () => {
  const backend: NotionBackend = {
    async search(_q, opts) {
      const all = Array.from({ length: 7 }, (_, i) => ({ id: `p${i}`, title: `t${i}`, url: `https://x/${i}` }));
      const start = opts.cursor ? Number(opts.cursor) : 0;
      const items = all.slice(start, start + opts.pageSize);
      const next = start + items.length;
      return { items, nextCursor: next < all.length ? String(next) : undefined };
    },
    async readPage() { return null; },
    async createPage() { return { id: "x", url: "https://x" }; },
    async updatePage() { return null; },
  };
  const t = new NotionMcp(backend, { defaultPageSize: 3 }).tools();
  const p1: any = await t["notion.search"]({ query: "x" }, ctx);
  const p2: any = await t["notion.search"]({ query: "x", cursor: p1.nextCursor }, ctx);
  const p3: any = await t["notion.search"]({ query: "x", cursor: p2.nextCursor }, ctx);
  assert.equal(p3.items.length, 1);
  assert.equal(p3.nextCursor, undefined);
});

test("pageSize is clamped to the connector's max page size", async () => {
  const t = new NotionMcp(new StubNotion(), { maxPageSize: 5 }).tools();
  const r: any = await t["notion.search"]({ query: "stub", pageSize: 999 }, ctx);
  assert.equal(r.items.length, 5);
});

// ==================================================================== 256 KB response truncation

test("notion.search truncates a large result page to 256 KB and flags truncated", async () => {
  const backend: NotionBackend = {
    async search(_q, opts) {
      const items = Array.from({ length: opts.pageSize }, (_, i) => ({
        id: `pg_${i}`, title: `stub ${i}`, url: `https://notion.so/${"y".repeat(2000)}_${i}`,
      }));
      return { items };
    },
    async readPage() { return null; },
    async createPage() { return { id: "x", url: "https://x" }; },
    async updatePage() { return null; },
  };
  const t = new NotionMcp(backend, { defaultPageSize: 500, maxPageSize: 500 }).tools();
  const r: any = await t["notion.search"]({ query: "x", pageSize: 500 }, ctx);
  assert.equal(r.truncated, true);
  assert.ok(r.items.length < 500, "results must have been dropped to fit the byte budget");
  const rebuilt = JSON.stringify({ items: r.items, nextCursor: r.nextCursor, truncated: true });
  assert.ok(Buffer.byteLength(rebuilt, "utf8") <= 256 * 1024);
});

test("notion.read_page caps content at 256 KB and flags truncated", async () => {
  const bigContent = "z".repeat(300 * 1024);
  const backend: NotionBackend = {
    async search() { return { items: [] }; },
    async readPage(id) { return { id, title: "Huge", content: bigContent, url: "https://notion.so/huge" }; },
    async createPage() { return { id: "x", url: "https://x" }; },
    async updatePage() { return null; },
  };
  const t = new NotionMcp(backend).tools();
  const r: any = await t["notion.read_page"]({ id: "huge" }, ctx);
  assert.equal(r.truncated, true);
  assert.equal(Buffer.byteLength(r.content, "utf8"), 256 * 1024);
});

test("capContent leaves small content untouched and flags large content", () => {
  assert.deepEqual(capContent("hi", 256 * 1024), { content: "hi", truncated: false });
  const big = "x".repeat(256 * 1024 + 10);
  const c = capContent(big, 256 * 1024);
  assert.equal(c.truncated, true);
  assert.equal(Buffer.byteLength(c.content, "utf8"), 256 * 1024);
});

// ============================================================================ schema validation

test("notion.search rejects a missing query", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.search"]({}, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("notion.read_page rejects a missing id", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.read_page"]({}, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("notion.create_page rejects a missing parentId", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.create_page"]({ title: "x" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("notion.create_page rejects a missing title", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.create_page"]({ parentId: "pg_1" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("notion.update_page rejects a missing id", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.update_page"]({ title: "x" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("a wrong-typed field is rejected (pageSize must be a number)", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.search"]({ query: "x", pageSize: "lots" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /pageSize.*number/);
});

test("an over-long string field is rejected (maxLength)", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.create_page"]({ parentId: "pg_1", title: "x".repeat(2001) }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /max length/);
});

test("an unknown field is rejected (additionalProperties: false)", async () => {
  const t = new NotionMcp().tools();
  const r: any = await t["notion.read_page"]({ id: "pg_1", extra: "nope" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /unknown field/);
});

test("validation runs before the backend is ever called", async () => {
  let called = false;
  const backend: NotionBackend = {
    async search() { called = true; return { items: [] }; },
    async readPage() { return null; },
    async createPage() { return { id: "x", url: "https://x" }; },
    async updatePage() { return null; },
  };
  const t = new NotionMcp(backend).tools();
  await t["notion.search"]({}, ctx);
  assert.equal(called, false, "an invalid call must never reach the backend");
});

// ======================================================================================= StubNotion

test("StubNotion is deterministic and offline (no credential/network needed)", async () => {
  const b = new StubNotion();
  const page1 = await b.readPage("pg_1", ctx);
  const page2 = await b.readPage("pg_1", ctx);
  assert.deepEqual(page1, page2);
});
