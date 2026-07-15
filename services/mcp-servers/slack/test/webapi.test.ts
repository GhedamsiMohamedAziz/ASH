// Real Slack Web API backend tests — drive WebApiBackend with a mock fetch (no network, no
// token). Proves the tool surface is unchanged behind the real backend AND that every Slack
// failure shape (HTTP-level and Slack's own `{ok: false, error}` body) maps to a named §21 error
// instead of a silent success. Run: node --test test/webapi.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackMcp } from "../src/slack.ts";
import { WebApiBackend, SlackApiError } from "../src/webapi.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "xoxp-fake-user-token" };

function mockFetch(status: number, body: unknown, sink?: any): typeof fetch {
  return (async (url: string, init: any) => {
    if (sink) { sink.url = url; sink.init = init; }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as any;
  }) as unknown as typeof fetch;
}

// ------------------------------------------------------------------------------- happy path / wiring

test("send_message hits chat.postMessage with the token from ctx (never from source)", async () => {
  const sink: any = {};
  const backend = new WebApiBackend({ fetchImpl: mockFetch(200, { ok: true, ts: "1700.1", channel: "C1" }, sink) });
  const r = (await new SlackMcp(backend).tools()["slack.send_message"]({ channel: "C1", text: "hi" }, ctx)) as any;
  assert.equal(r.ts, "1700.1");
  assert.match(sink.url, /\/chat\.postMessage$/);
  assert.equal(sink.init.method, "POST");
  assert.equal(sink.init.headers.authorization, "Bearer xoxp-fake-user-token");
  assert.deepEqual(JSON.parse(sink.init.body), { channel: "C1", text: "hi" }); // thread_ts omitted when absent
});

test("send_message with threadTs includes thread_ts in the request body", async () => {
  const sink: any = {};
  const backend = new WebApiBackend({ fetchImpl: mockFetch(200, { ok: true, ts: "1700.2", channel: "C1" }, sink) });
  await new SlackMcp(backend).tools()["slack.send_message"]({ channel: "C1", text: "hi", threadTs: "1699.1" }, ctx);
  assert.equal(JSON.parse(sink.init.body).thread_ts, "1699.1");
});

test("read_channel hits conversations.history and maps messages", async () => {
  const backend = new WebApiBackend({
    fetchImpl: mockFetch(200, {
      ok: true,
      messages: [{ ts: "1.1", user: "U1", text: "hi", thread_ts: "1.1", reply_count: 3 }],
      response_metadata: { next_cursor: "abc" },
    }),
  });
  const r = (await new SlackMcp(backend).tools()["slack.read_channel"]({ channel: "C1" }, ctx)) as any;
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].threadTs, "1.1");
  assert.equal(r.items[0].replyCount, 3);
  assert.equal(r.nextCursor, "abc");
});

test("read_thread hits conversations.replies", async () => {
  const sink: any = {};
  const backend = new WebApiBackend({
    fetchImpl: mockFetch(200, { ok: true, messages: [{ ts: "1.1", user: "U1", text: "reply" }] }, sink),
  });
  const r = (await new SlackMcp(backend).tools()["slack.read_thread"]({ channel: "C1", threadTs: "1.1" }, ctx)) as any;
  assert.equal(r.items[0].text, "reply");
  assert.match(sink.url, /\/conversations\.replies\?/);
  assert.match(sink.url, /ts=1\.1/);
});

test("search_messages hits search.messages and computes nextCursor from paging", async () => {
  const backend = new WebApiBackend({
    fetchImpl: mockFetch(200, {
      ok: true,
      messages: {
        matches: [{ channel: { id: "C1" }, ts: "1.1", user: "U1", text: "deploy done", permalink: "https://x/1" }],
        paging: { page: 1, pages: 3 },
      },
    }),
  });
  const r = (await new SlackMcp(backend).tools()["slack.search_messages"]({ query: "deploy" }, ctx)) as any;
  assert.equal(r.items[0].text, "deploy done");
  assert.equal(r.nextCursor, "2");
});

test("search_messages on the last page returns no nextCursor", async () => {
  const backend = new WebApiBackend({
    fetchImpl: mockFetch(200, { ok: true, messages: { matches: [], paging: { page: 3, pages: 3 } } }),
  });
  const r = (await new SlackMcp(backend).tools()["slack.search_messages"]({ query: "x", cursor: "3" }, ctx)) as any;
  assert.equal(r.nextCursor, undefined);
});

test("upload_file hits files.upload and maps the returned file", async () => {
  const sink: any = {};
  const backend = new WebApiBackend({
    fetchImpl: mockFetch(200, {
      ok: true,
      file: { id: "F1", name: "notes.txt", url_private: "https://files/F1", permalink: "https://x/F1" },
    }, sink),
  });
  const r = (await new SlackMcp(backend).tools()["slack.upload_file"]({ channel: "C1", filename: "notes.txt", content: "hi" }, ctx)) as any;
  assert.equal(r.id, "F1");
  assert.equal(r.url, "https://files/F1");
  assert.match(sink.url, /\/files\.upload$/);
});

// ------------------------------------------------------------------------------------- credential

test("a missing credential fails closed with E_CONN_NEEDS_CONNECTION, never calls fetch", async () => {
  let called = false;
  const backend = new WebApiBackend({ fetchImpl: (async () => { called = true; return {} as any; }) as any });
  await assert.rejects(
    () => backend.postMessage("C1", "hi", undefined, { ...ctx, credential: "" }),
    (e: unknown) => e instanceof SlackApiError && e.code === "E_CONN_NEEDS_CONNECTION",
  );
  assert.equal(called, false);
});

// ------------------------------------------------------------- failure map: HTTP status -> §21 code

const httpCases: Array<[number, string]> = [
  [429, "E_RATE_LIMITED"],
  [500, "E_TOOL_UPSTREAM_ERROR"],
  [503, "E_TOOL_UPSTREAM_ERROR"],
];
for (const [status, code] of httpCases) {
  test(`HTTP ${status} -> ${code}`, async () => {
    const backend = new WebApiBackend({ fetchImpl: mockFetch(status, "boom") });
    await assert.rejects(
      () => backend.postMessage("C1", "hi", undefined, ctx),
      (e: any) => e instanceof SlackApiError && e.code === code && e.status === status,
    );
  });
}

// --------------------------------------------------- failure map: Slack ok:false body -> §21 code

const slackErrorCases: Array<[string, string]> = [
  ["invalid_auth", "E_CONN_TOKEN_EXPIRED"],
  ["token_expired", "E_CONN_TOKEN_EXPIRED"],
  ["token_revoked", "E_CONN_TOKEN_EXPIRED"],
  ["account_inactive", "E_CONN_TOKEN_EXPIRED"],
  ["not_authed", "E_CONN_NEEDS_CONNECTION"],
  ["no_permission", "E_CONN_NEEDS_CONNECTION"],
  ["missing_scope", "E_PERM_TOOL_DENIED"],
  ["restricted_action", "E_PERM_TOOL_DENIED"],
  ["channel_not_found", "E_CONN_NEEDS_CONNECTION"],
  ["thread_not_found", "E_CONN_NEEDS_CONNECTION"],
  ["ratelimited", "E_RATE_LIMITED"],
  ["some_unmapped_error", "E_TOOL_UPSTREAM_ERROR"],
];
for (const [slackError, code] of slackErrorCases) {
  test(`Slack ok:false error "${slackError}" -> ${code}`, async () => {
    const backend = new WebApiBackend({ fetchImpl: mockFetch(200, { ok: false, error: slackError }) });
    await assert.rejects(
      () => backend.postMessage("C1", "hi", undefined, ctx),
      (e: any) => e instanceof SlackApiError && e.code === code,
    );
  });
}

test("a network error (fetch throws) maps to E_TOOL_UPSTREAM_ERROR, not a crash", async () => {
  const backend = new WebApiBackend({ fetchImpl: (async () => { throw new Error("ECONNRESET"); }) as any });
  await assert.rejects(
    () => backend.postMessage("C1", "hi", undefined, ctx),
    (e: any) => e instanceof SlackApiError && e.code === "E_TOOL_UPSTREAM_ERROR",
  );
});

test("a failure surfaces through the MCP tool call too (error is thrown, not swallowed)", async () => {
  const backend = new WebApiBackend({ fetchImpl: mockFetch(200, { ok: false, error: "invalid_auth" }) });
  const t = new SlackMcp(backend).tools();
  await assert.rejects(
    () => t["slack.send_message"]({ channel: "C1", text: "hi" }, ctx),
    (e: any) => e instanceof SlackApiError && e.code === "E_CONN_TOKEN_EXPIRED",
  );
});
