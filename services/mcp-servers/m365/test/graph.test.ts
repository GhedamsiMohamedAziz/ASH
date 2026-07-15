// Real Microsoft Graph backend tests — drive GraphBackend with a mock fetch (no network, no
// token). Proves the tool surface is unchanged behind the real backend, that both Graph pagination
// shapes (@odata.nextLink for mail, $top/$skip for file search) round-trip, and that every Graph
// failure maps to a named §21 error instead of a silent success. Run: node --test test/graph.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { M365Mcp } from "../src/m365.ts";
import { GraphBackend, GraphApiError } from "../src/graph.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "secret_fake_graph_obo_token" };

function mockFetch(status: number, body: unknown, sink?: any): typeof fetch {
  return (async (url: string, init: any) => {
    if (sink) { sink.url = url; sink.init = init; }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as any;
  }) as unknown as typeof fetch;
}

// ------------------------------------------------------------------------------- happy path / wiring

test("m365.list_mail hits GET /me/mailFolders/{folder}/messages with the token from ctx (never from source)", async () => {
  const sink: any = {};
  const backend = new GraphBackend({
    fetchImpl: mockFetch(200, { value: [{ id: "AAMk1", subject: "Real subject", from: { emailAddress: { address: "a@acme.com" } } }] }, sink),
  });
  const r = (await new M365Mcp(backend).tools()["m365.list_mail"]({ folder: "inbox" }, ctx)) as any;
  assert.equal(r.items[0].subject, "Real subject");
  assert.equal(r.items[0].from, "a@acme.com");
  assert.match(sink.url, /\/me\/mailFolders\/inbox\/messages\?/);
  assert.equal(sink.init.method, "GET");
  assert.equal(sink.init.headers.authorization, "Bearer secret_fake_graph_obo_token");
});

test("m365.list_mail's nextCursor is the raw @odata.nextLink, called verbatim on the next page", async () => {
  const nextLink = "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skiptoken=abc123";
  const urls: string[] = [];
  let call = 0;
  const backend = new GraphBackend({
    fetchImpl: (async (url: string) => {
      call += 1;
      urls.push(url);
      if (call === 1) {
        return { ok: true, status: 200, text: async () => JSON.stringify({ value: [{ id: "m1" }], "@odata.nextLink": nextLink }) } as any;
      }
      return { ok: true, status: 200, text: async () => JSON.stringify({ value: [{ id: "m2" }] }) } as any;
    }) as any,
  });
  const t = new M365Mcp(backend).tools();
  const page1: any = await t["m365.list_mail"]({ folder: "inbox" }, ctx);
  assert.equal(page1.nextCursor, nextLink);
  const page2: any = await t["m365.list_mail"]({ folder: "inbox", cursor: page1.nextCursor }, ctx);
  assert.equal(page2.items[0].id, "m2");
  assert.equal(urls[1], nextLink, "the nextLink must be called AS IS, never reprefixed with the base");
});

test("m365.read_mail fetches GET /me/messages/{id} and maps the body", async () => {
  const sink: any = {};
  const backend = new GraphBackend({
    fetchImpl: mockFetch(200, {
      id: "m1", subject: "Real Q3", from: { emailAddress: { address: "ceo@acme.com" } }, body: { content: "the numbers" },
    }, sink),
  });
  const r = (await new M365Mcp(backend).tools()["m365.read_mail"]({ id: "m1" }, ctx)) as any;
  assert.equal(r.subject, "Real Q3");
  assert.equal(r.from, "ceo@acme.com");
  assert.equal(r.body, "the numbers");
  assert.match(sink.url, /\/me\/messages\/m1\?/);
});

test("m365.read_mail returns E_NOT_FOUND (via null) when the message GET 404s", async () => {
  const backend = new GraphBackend({ fetchImpl: mockFetch(404, { error: { code: "ErrorItemNotFound" } }) });
  const r = (await new M365Mcp(backend).tools()["m365.read_mail"]({ id: "missing" }, ctx)) as any;
  assert.equal(r.error.code, "E_NOT_FOUND");
});

test("m365.send_mail composes a draft then sends it, returning the draft's id", async () => {
  const urls: string[] = [];
  const bodies: string[] = [];
  let call = 0;
  const backend = new GraphBackend({
    fetchImpl: (async (url: string, init: any) => {
      call += 1;
      urls.push(url);
      bodies.push(init.body);
      if (call === 1) return { ok: true, status: 200, text: async () => JSON.stringify({ id: "draft_1" }) } as any;
      return { ok: true, status: 202, text: async () => "" } as any;
    }) as any,
  });
  const r = (await new M365Mcp(backend).tools()["m365.send_mail"]({ to: "x@y.com", subject: "s", body: "b" }, ctx)) as any;
  assert.equal(r.id, "draft_1");
  assert.match(urls[0], /\/me\/messages$/);
  assert.match(urls[1], /\/me\/messages\/draft_1\/send$/);
  const draftBody = JSON.parse(bodies[0]);
  assert.equal(draftBody.subject, "s");
  assert.equal(draftBody.toRecipients[0].emailAddress.address, "x@y.com");
});

test("m365.search_files hits the drive search endpoint and maps results", async () => {
  const sink: any = {};
  const backend = new GraphBackend({
    fetchImpl: mockFetch(200, {
      value: [{ name: "budget.xlsx", parentReference: { path: "/drive/root:/sites/finance" }, webUrl: "https://sp/budget.xlsx" }],
    }, sink),
  });
  const r = (await new M365Mcp(backend).tools()["m365.search_files"]({ query: "budget" }, ctx)) as any;
  assert.equal(r.items[0].name, "budget.xlsx");
  assert.match(r.items[0].path, /sites\/finance\/budget\.xlsx/);
  assert.equal(r.items[0].webUrl, "https://sp/budget.xlsx");
  assert.match(sink.url, /\/me\/drive\/root\/search\(q='budget'\)\?/);
});

test("m365.search_files's nextCursor is a numeric $skip offset; a short page has no nextCursor", async () => {
  const backend = new GraphBackend({
    fetchImpl: mockFetch(200, { value: [{ name: "a" }, { name: "b" }] }),
  });
  const t = new M365Mcp(backend, { defaultPageSize: 5 }).tools();
  const r: any = await t["m365.search_files"]({ query: "x" }, ctx);
  assert.equal(r.nextCursor, undefined, "fewer results than pageSize means no more pages");
});

test("m365.search_files's nextCursor advances by $skip when the page is full", async () => {
  const backend = new GraphBackend({
    fetchImpl: mockFetch(200, { value: [{ name: "a" }, { name: "b" }] }),
  });
  const t = new M365Mcp(backend, { defaultPageSize: 2 }).tools();
  const r: any = await t["m365.search_files"]({ query: "x" }, ctx);
  assert.equal(r.nextCursor, "2");
});

test("m365.create_event posts to /me/events with a default 30-minute window", async () => {
  const sink: any = {};
  const backend = new GraphBackend({ fetchImpl: mockFetch(200, { id: "evt_real" }, sink) });
  const r = (await new M365Mcp(backend).tools()["m365.create_event"]({ title: "1:1", start: "2026-07-13T09:00:00.000Z" }, ctx)) as any;
  assert.equal(r.id, "evt_real");
  assert.match(sink.url, /\/me\/events$/);
  const body = JSON.parse(sink.init.body);
  assert.equal(body.subject, "1:1");
  assert.equal(body.start.dateTime, "2026-07-13T09:00:00.000Z");
  assert.equal(body.end.dateTime, "2026-07-13T09:30:00.000Z");
});

test("m365.create_event rejects an invalid start date with E_VALIDATION, never calls fetch", async () => {
  let called = false;
  const backend = new GraphBackend({ fetchImpl: (async () => { called = true; return {} as any; }) as any });
  await assert.rejects(
    () => backend.createEvent("1:1", "not-a-date", ctx),
    (e: any) => e instanceof GraphApiError && e.code === "E_VALIDATION",
  );
  assert.equal(called, false);
});

// ------------------------------------------------------------------------------------- credential

test("a missing credential fails closed with E_CONN_NEEDS_CONNECTION, never calls fetch", async () => {
  let called = false;
  const backend = new GraphBackend({ fetchImpl: (async () => { called = true; return {} as any; }) as any });
  await assert.rejects(
    () => backend.readMail("m1", { ...ctx, credential: "" }),
    (e: unknown) => e instanceof GraphApiError && e.code === "E_CONN_NEEDS_CONNECTION",
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
  test(`Graph ${status} -> ${code}`, async () => {
    const backend = new GraphBackend({ fetchImpl: mockFetch(status, { error: { code: "boom", message: "boom" } }) });
    await assert.rejects(
      () => backend.createEvent("t", "2026-07-13T09:00:00.000Z", ctx),
      (e: any) => e instanceof GraphApiError && e.code === code && e.status === status,
    );
  });
}

test("a network error (fetch throws) maps to E_TOOL_UPSTREAM_ERROR, not a crash", async () => {
  const backend = new GraphBackend({ fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as any });
  await assert.rejects(
    () => backend.createEvent("t", "2026-07-13T09:00:00.000Z", ctx),
    (e: any) => e instanceof GraphApiError && e.code === "E_TOOL_UPSTREAM_ERROR",
  );
});

test("a failure surfaces through the MCP tool call too (error is thrown, not swallowed)", async () => {
  const backend = new GraphBackend({ fetchImpl: mockFetch(401, { error: { code: "InvalidAuthenticationToken" } }) });
  const t = new M365Mcp(backend).tools();
  await assert.rejects(
    () => t["m365.create_event"]({ title: "t", start: "2026-07-13T09:00:00.000Z" }, ctx),
    (e: any) => e instanceof GraphApiError && e.code === "E_CONN_TOKEN_EXPIRED",
  );
});
