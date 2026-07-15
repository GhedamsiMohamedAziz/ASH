// Slack MCP tool-surface tests (instructions.md §14). Run: node --test test/slack.test.ts
// Covers the tool surface end to end via StubSlack (happy path, pagination, 256 KB truncation),
// strict JSON Schema validation (missing/wrong-typed/unknown/over-long args), and the pre-existing
// slack.post_recap tool preserved for back-compat. Real Slack Web API error mapping lives in
// test/webapi.test.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackMcp, StubSlack, TOOL_SCHEMAS, type SlackBackend, type SlackPage, type SlackMessage } from "../src/slack.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "vault:slackbot" };

// ======================================================================================= surface

test("tool surface exposes exactly the §14 tools + the pre-existing post_recap", () => {
  const names = Object.keys(new SlackMcp().tools()).sort();
  assert.deepEqual(names, [
    "slack.post_recap",
    "slack.read_channel",
    "slack.read_thread",
    "slack.search_messages",
    "slack.send_message",
    "slack.upload_file",
  ]);
});

test("every tool has a JSON Schema with additionalProperties: false", () => {
  for (const name of Object.keys(new SlackMcp().tools())) {
    const schema = TOOL_SCHEMAS[name];
    assert.ok(schema, `missing TOOL_SCHEMAS entry for ${name}`);
    assert.equal(schema.inputSchema.additionalProperties, false);
  }
});

// ==================================================================================== happy path

test("slack.read_channel returns a page of messages", async () => {
  const t = new SlackMcp().tools();
  const r = (await t["slack.read_channel"]({ channel: "C1" }, ctx)) as SlackPage<SlackMessage> & { truncated: boolean };
  assert.equal(r.items.length, 20); // default page size
  assert.match(r.items[0].text, /stub message 0 in #C1/);
  assert.equal(r.truncated, false);
  assert.ok(r.nextCursor);
});

test("slack.read_channel respects a smaller pageSize (existing shape: limit -> pageSize)", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.read_channel"]({ channel: "C1", pageSize: 1 }, ctx);
  assert.equal(r.items.length, 1);
});

test("slack.read_thread returns replies to a thread", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.read_thread"]({ channel: "C1", threadTs: "1700000000.000100" }, ctx);
  assert.equal(r.items.length, 8);
  assert.equal(r.items[0].threadTs, "1700000000.000100");
});

test("slack.search_messages returns matches mentioning the query", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.search_messages"]({ query: "deploy" }, ctx);
  assert.ok(r.items.length > 0);
  assert.match(r.items[0].text, /deploy/);
  assert.ok(r.items[0].permalink);
});

test("slack.send_message posts and returns a ts + channel", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.send_message"]({ channel: "C1", text: "shipped" }, ctx);
  assert.ok(r.ts);
  assert.equal(r.channel, "C1");
});

test("slack.send_message supports a threaded reply (threadTs passthrough)", async () => {
  let seenThreadTs: string | undefined;
  const backend: SlackBackend = {
    async readChannel() { return { items: [] }; },
    async readThread() { return { items: [] }; },
    async searchMessages() { return { items: [] }; },
    async postMessage(channel, _text, threadTs) { seenThreadTs = threadTs; return { ts: "1.1", channel }; },
    async uploadFile() { return { id: "F1", name: "x", url: "u", permalink: "p" }; },
  };
  const t = new SlackMcp(backend).tools();
  await t["slack.send_message"]({ channel: "C1", text: "reply", threadTs: "1699.1" }, ctx);
  assert.equal(seenThreadTs, "1699.1");
});

test("slack.post_recap (pre-existing tool) posts top-level and returns only { ts }", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.post_recap"]({ channel: "C1", text: "done" }, ctx);
  assert.ok(r.ts);
  assert.deepEqual(Object.keys(r), ["ts"]); // preserves the original shape
});

test("slack.post_recap never threads (always posts top-level, unlike send_message)", async () => {
  let seenThreadTs: string | undefined = "not-set";
  const backend: SlackBackend = {
    async readChannel() { return { items: [] }; },
    async readThread() { return { items: [] }; },
    async searchMessages() { return { items: [] }; },
    async postMessage(_channel, _text, threadTs) { seenThreadTs = threadTs; return { ts: "1.1", channel: "C1" }; },
    async uploadFile() { return { id: "F1", name: "x", url: "u", permalink: "p" }; },
  };
  const t = new SlackMcp(backend).tools();
  await t["slack.post_recap"]({ channel: "C1", text: "done" }, ctx);
  assert.equal(seenThreadTs, undefined);
});

test("slack.upload_file returns file metadata", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.upload_file"]({ channel: "C1", filename: "notes.txt", content: "hello" }, ctx);
  assert.equal(r.name, "notes.txt");
  assert.match(r.url, /C1/);
  assert.match(r.permalink, /notes\.txt/);
});

// ===================================================================================== pagination

test("slack.read_channel paginates across multiple pages with a cursor", async () => {
  const t = new SlackMcp(new StubSlack(), { defaultPageSize: 20 }).tools();
  const page1: any = await t["slack.read_channel"]({ channel: "C1" }, ctx);
  assert.equal(page1.items.length, 20);
  assert.ok(page1.nextCursor);

  const page2: any = await t["slack.read_channel"]({ channel: "C1", cursor: page1.nextCursor }, ctx);
  assert.equal(page2.items.length, 20);
  assert.ok(page2.nextCursor);

  const page3: any = await t["slack.read_channel"]({ channel: "C1", cursor: page2.nextCursor }, ctx);
  assert.equal(page3.items.length, 7); // 47 total, 20 + 20 + 7
  assert.equal(page3.nextCursor, undefined, "the final page has no next cursor");
});

test("slack.search_messages paginates with a cursor", async () => {
  const t = new SlackMcp(new StubSlack(), { defaultPageSize: 10 }).tools();
  const page1: any = await t["slack.search_messages"]({ query: "x" }, ctx);
  assert.equal(page1.items.length, 10);
  const page2: any = await t["slack.search_messages"]({ query: "x", cursor: page1.nextCursor }, ctx);
  assert.equal(page2.items.length, 10);
  assert.notEqual(page1.items[0].ts, page2.items[0].ts);
});

test("pageSize is clamped to the connector's max page size", async () => {
  const t = new SlackMcp(new StubSlack(), { maxPageSize: 5 }).tools();
  const r: any = await t["slack.read_channel"]({ channel: "C1", pageSize: 999 }, ctx);
  assert.equal(r.items.length, 5);
});

// ==================================================================== 256 KB response truncation

test("slack.read_channel truncates a large page to 256 KB and flags truncated", async () => {
  const bigText = "x".repeat(2000);
  const backend: SlackBackend = {
    async readChannel(_channel, opts) {
      const items = Array.from({ length: opts.pageSize }, (_, i) => ({ ts: `${i}`, user: "U1", text: bigText }));
      return { items };
    },
    async readThread() { return { items: [] }; },
    async searchMessages() { return { items: [] }; },
    async postMessage() { return { ts: "1", channel: "C1" }; },
    async uploadFile() { return { id: "F1", name: "x", url: "u", permalink: "p" }; },
  };
  const t = new SlackMcp(backend, { defaultPageSize: 500, maxPageSize: 500 }).tools();
  const r: any = await t["slack.read_channel"]({ channel: "C1", pageSize: 500 }, ctx);

  assert.equal(r.truncated, true);
  assert.ok(r.items.length < 500, "messages must have been dropped to fit the byte budget");
  const rebuilt = JSON.stringify({ items: r.items, nextCursor: r.nextCursor, truncated: true });
  assert.ok(Buffer.byteLength(rebuilt, "utf8") <= 256 * 1024);
});

test("slack.search_messages truncates when results are large", async () => {
  const bigText = "y".repeat(2000);
  const backend: SlackBackend = {
    async readChannel() { return { items: [] }; },
    async readThread() { return { items: [] }; },
    async searchMessages(_q, opts) {
      const items = Array.from({ length: opts.pageSize }, (_, i) => ({
        channel: "C1", ts: `${i}`, user: "U1", text: bigText, permalink: `https://x/${i}`,
      }));
      return { items };
    },
    async postMessage() { return { ts: "1", channel: "C1" }; },
    async uploadFile() { return { id: "F1", name: "x", url: "u", permalink: "p" }; },
  };
  const t = new SlackMcp(backend, { defaultPageSize: 500, maxPageSize: 500 }).tools();
  const r: any = await t["slack.search_messages"]({ query: "x", pageSize: 500 }, ctx);
  assert.equal(r.truncated, true);
  const rebuilt = JSON.stringify({ items: r.items, nextCursor: r.nextCursor, truncated: true });
  assert.ok(Buffer.byteLength(rebuilt, "utf8") <= 256 * 1024);
});

// ============================================================================ schema validation

test("slack.read_channel rejects a missing channel", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.read_channel"]({}, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("slack.read_thread rejects a missing threadTs", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.read_thread"]({ channel: "C1" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("slack.search_messages rejects a missing query", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.search_messages"]({}, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("slack.send_message rejects a missing text", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.send_message"]({ channel: "C1" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("slack.upload_file rejects a missing content", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.upload_file"]({ channel: "C1", filename: "a.txt" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("a wrong-typed field is rejected (pageSize must be a number)", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.read_channel"]({ channel: "C1", pageSize: "lots" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /pageSize.*number/);
});

test("an empty-string required field is rejected, not silently accepted", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.send_message"]({ channel: "", text: "hi" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("an over-long string field is rejected (maxLength)", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.send_message"]({ channel: "C1", text: "x".repeat(40001) }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /max length/);
});

test("an unknown field is rejected (additionalProperties: false)", async () => {
  const t = new SlackMcp().tools();
  const r: any = await t["slack.send_message"]({ channel: "C1", text: "hi", extra: "nope" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /unknown field/);
});

test("validation runs before the backend is ever called", async () => {
  let called = false;
  const backend: SlackBackend = {
    async readChannel() { called = true; return { items: [] }; },
    async readThread() { return { items: [] }; },
    async searchMessages() { return { items: [] }; },
    async postMessage() { return { ts: "1", channel: "C1" }; },
    async uploadFile() { return { id: "F1", name: "x", url: "u", permalink: "p" }; },
  };
  const t = new SlackMcp(backend).tools();
  await t["slack.read_channel"]({}, ctx);
  assert.equal(called, false, "an invalid call must never reach the backend");
});

// ======================================================================================= StubSlack

test("StubSlack is deterministic and offline (no credential/network needed)", async () => {
  const b = new StubSlack();
  const page1 = await b.readChannel("C1", { pageSize: 5 }, ctx);
  const page2 = await b.readChannel("C1", { pageSize: 5 }, ctx);
  assert.deepEqual(page1, page2);
});
