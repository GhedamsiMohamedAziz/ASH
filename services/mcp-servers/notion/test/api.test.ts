// Real Notion API backend tests — drive NotionRestBackend with a mock fetch (no network, no
// token). Proves the tool surface is unchanged behind the real backend AND that every Notion
// failure maps to a named §21 error instead of a silent success. Run: node --test test/api.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionMcp } from "../src/notion.ts";
import { NotionRestBackend, NotionApiError } from "../src/api.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "secret_fake_notion_token" };

function mockFetch(status: number, body: unknown, sink?: any): typeof fetch {
  return (async (url: string, init: any) => {
    if (sink) { sink.url = url; sink.init = init; }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as any;
  }) as unknown as typeof fetch;
}

// ------------------------------------------------------------------------------- happy path / wiring

test("notion.search hits POST /search with the token from ctx (never from source)", async () => {
  const sink: any = {};
  const backend = new NotionRestBackend({
    fetchImpl: mockFetch(200, {
      results: [{ id: "pg_1", url: "https://notion.so/pg_1", properties: { title: { type: "title", title: [{ plain_text: "Real Spec" }] } } }],
      has_more: false,
    }, sink),
  });
  const r = (await new NotionMcp(backend).tools()["notion.search"]({ query: "spec" }, ctx)) as any;
  assert.equal(r.items[0].title, "Real Spec");
  assert.match(sink.url, /\/search$/);
  assert.equal(sink.init.method, "POST");
  assert.equal(sink.init.headers.authorization, "Bearer secret_fake_notion_token");
  assert.equal(sink.init.headers["notion-version"], "2022-06-28");
});

test("notion.search reports nextCursor only when has_more is true", async () => {
  const backend = new NotionRestBackend({
    fetchImpl: mockFetch(200, { results: [], has_more: true, next_cursor: "cur_1" }),
  });
  const r = (await new NotionMcp(backend).tools()["notion.search"]({ query: "x" }, ctx)) as any;
  assert.equal(r.nextCursor, "cur_1");
});

test("notion.read_page fetches the page then its block children and flattens text", async () => {
  const sink: any = {};
  let call = 0;
  const backend = new NotionRestBackend({
    fetchImpl: (async (url: string, init: any) => {
      call += 1;
      sink[`call${call}`] = url;
      if (call === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({
          id: "pg_1", url: "https://notion.so/pg_1",
          properties: { Name: { type: "title", title: [{ plain_text: "Real Spec" }] } },
        }) } as any;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({
        results: [
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "line one" }] } },
          { type: "paragraph", paragraph: { rich_text: [{ plain_text: "line two" }] } },
        ],
      }) } as any;
    }) as any,
  });
  const r = (await new NotionMcp(backend).tools()["notion.read_page"]({ id: "pg_1" }, ctx)) as any;
  assert.equal(r.title, "Real Spec");
  assert.equal(r.content, "line one\nline two");
  assert.match(sink.call1, /\/pages\/pg_1$/);
  assert.match(sink.call2, /\/blocks\/pg_1\/children/);
});

test("notion.read_page returns E_NOT_FOUND (via null) when the page GET 404s", async () => {
  const backend = new NotionRestBackend({ fetchImpl: mockFetch(404, { code: "object_not_found" }) });
  const r = (await new NotionMcp(backend).tools()["notion.read_page"]({ id: "missing" }, ctx)) as any;
  assert.equal(r.error.code, "E_NOT_FOUND");
});

test("notion.create_page posts the page with a title property and a paragraph block", async () => {
  const sink: any = {};
  const backend = new NotionRestBackend({
    fetchImpl: mockFetch(200, { id: "pg_new", url: "https://notion.so/pg_new" }, sink),
  });
  const r = (await new NotionMcp(backend).tools()["notion.create_page"]({ parentId: "pg_1", title: "New", content: "body" }, ctx)) as any;
  assert.equal(r.id, "pg_new");
  assert.match(sink.url, /\/pages$/);
  const body = JSON.parse(sink.init.body);
  assert.equal(body.parent.page_id, "pg_1");
  assert.equal(body.properties.title.title[0].text.content, "New");
  assert.equal(body.children[0].paragraph.rich_text[0].text.content, "body");
});

test("notion.update_page (title only) PATCHes the page then re-fetches it", async () => {
  const urls: string[] = [];
  const backend = new NotionRestBackend({
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "pg_1", url: "https://notion.so/pg_1" }) } as any;
    }) as any,
  });
  const r = (await new NotionMcp(backend).tools()["notion.update_page"]({ id: "pg_1", title: "Renamed" }, ctx)) as any;
  assert.equal(r.updated, true);
  assert.ok(urls.some((u) => /\/pages\/pg_1$/.test(u)));
});

test("notion.update_page (appendContent) PATCHes the blocks children endpoint", async () => {
  const urls: string[] = [];
  const backend = new NotionRestBackend({
    fetchImpl: (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, text: async () => JSON.stringify({ id: "pg_1", url: "https://notion.so/pg_1" }) } as any;
    }) as any,
  });
  await new NotionMcp(backend).tools()["notion.update_page"]({ id: "pg_1", appendContent: "more" }, ctx);
  assert.ok(urls.some((u) => /\/blocks\/pg_1\/children$/.test(u)));
});

test("notion.update_page returns E_NOT_FOUND (via null) when the page doesn't exist", async () => {
  const backend = new NotionRestBackend({ fetchImpl: mockFetch(404, { code: "object_not_found" }) });
  const r = (await new NotionMcp(backend).tools()["notion.update_page"]({ id: "missing", title: "x" }, ctx)) as any;
  assert.equal(r.error.code, "E_NOT_FOUND");
});

// ------------------------------------------------------------------------------------- credential

test("a missing credential fails closed with E_CONN_NEEDS_CONNECTION, never calls fetch", async () => {
  let called = false;
  const backend = new NotionRestBackend({ fetchImpl: (async () => { called = true; return {} as any; }) as any });
  await assert.rejects(
    () => backend.readPage("pg_1", { ...ctx, credential: "" }),
    (e: unknown) => e instanceof NotionApiError && e.code === "E_CONN_NEEDS_CONNECTION",
  );
  assert.equal(called, false);
});

// ------------------------------------------------------------- failure map: HTTP status -> §21 code

const cases: Array<[number, string]> = [
  [401, "E_CONN_TOKEN_EXPIRED"],
  [403, "E_PERM_TOOL_DENIED"],
  [404, "E_CONN_NEEDS_CONNECTION"],
  [400, "E_VALIDATION"],
  [429, "E_RATE_LIMITED"],
  [500, "E_TOOL_UPSTREAM_ERROR"],
  [503, "E_TOOL_UPSTREAM_ERROR"],
];
for (const [status, code] of cases) {
  test(`Notion ${status} -> ${code}`, async () => {
    const backend = new NotionRestBackend({ fetchImpl: mockFetch(status, { code: "boom", message: "boom" }) });
    await assert.rejects(
      () => backend.createPage("pg_1", "t", "c", ctx),
      (e: any) => e instanceof NotionApiError && e.code === code && e.status === status,
    );
  });
}

test("a network error (fetch throws) maps to E_TOOL_UPSTREAM_ERROR, not a crash", async () => {
  const backend = new NotionRestBackend({ fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as any });
  await assert.rejects(
    () => backend.createPage("pg_1", "t", "c", ctx),
    (e: any) => e instanceof NotionApiError && e.code === "E_TOOL_UPSTREAM_ERROR",
  );
});

test("a failure surfaces through the MCP tool call too (error is thrown, not swallowed)", async () => {
  const backend = new NotionRestBackend({ fetchImpl: mockFetch(401, { code: "unauthorized" }) });
  const t = new NotionMcp(backend).tools();
  await assert.rejects(
    () => t["notion.create_page"]({ parentId: "pg_1", title: "x" }, ctx),
    (e: any) => e instanceof NotionApiError && e.code === "E_CONN_TOKEN_EXPIRED",
  );
});
