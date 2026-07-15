// Template connector tests. Run: node --test test/connector.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { TemplateMcp, StubBackend, type ExampleItem } from "../src/connector.ts";
import { paginate, truncateJson, MAX_RESPONSE_BYTES } from "../src/pagination.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "vault:stub" };

// ------------------------------------------------------------- example.read via StubBackend
test("example.read returns a first page with a nextCursor (StubBackend yields 25 items)", async () => {
  const tools = new TemplateMcp(new StubBackend()).tools();
  const page = (await tools["example.read"]({ resource: "widgets" }, ctx)) as any;
  assert.equal(page.items.length, 20); // default pageSize
  assert.equal(page.nextCursor, "20");
  assert.equal(page.truncated, false);
  assert.equal(page.items[0].id, "widgets-1");
});

test("example.read follows nextCursor to the final page", async () => {
  const tools = new TemplateMcp(new StubBackend()).tools();
  const first = (await tools["example.read"]({ resource: "widgets" }, ctx)) as any;
  const second = (await tools["example.read"]({ resource: "widgets", cursor: first.nextCursor }, ctx)) as any;
  assert.equal(second.items.length, 5); // 25 total - 20 already read
  assert.equal(second.nextCursor, undefined);
});

test("example.read clamps pageSize into [1, 100]", async () => {
  const tools = new TemplateMcp(new StubBackend()).tools();
  const page = (await tools["example.read"]({ resource: "widgets", pageSize: 500 }, ctx)) as any;
  assert.equal(page.items.length, 25); // clamped to 100, but only 25 exist
});

// ------------------------------------------------------------------------------- pagination
test("paginate slices by offset cursor and reports the next offset", () => {
  const all = Array.from({ length: 7 }, (_, i) => i);
  const p1 = paginate(all, undefined, 3);
  assert.deepEqual(p1, { items: [0, 1, 2], nextCursor: "3" });
  const p2 = paginate(all, p1.nextCursor, 3);
  assert.deepEqual(p2, { items: [3, 4, 5], nextCursor: "6" });
  const p3 = paginate(all, p2.nextCursor, 3);
  assert.deepEqual(p3, { items: [6], nextCursor: undefined });
});

test("paginate treats an invalid cursor as offset 0 (never throws on bad input)", () => {
  const all = [0, 1, 2];
  assert.deepEqual(paginate(all, "not-a-number", 10), { items: [0, 1, 2], nextCursor: undefined });
});

// ------------------------------------------------------------------------- 256 KB truncation
test("truncateJson passes small payloads through unchanged", () => {
  const payload = { items: [{ id: "a" }, { id: "b" }] };
  const { json, truncated } = truncateJson(payload);
  assert.equal(truncated, false);
  assert.deepEqual(JSON.parse(json), payload);
});

test("truncateJson drops trailing items until the payload fits 256 KB and flags truncated", () => {
  const big: ExampleItem[] = Array.from({ length: 10_000 }, (_, i) => ({
    id: `item-${i}`,
    title: "x".repeat(50), // ~10_000 * ~70 bytes ≈ 700 KB, well over the 256 KB cap
  }));
  const { json, truncated } = truncateJson({ items: big });
  assert.equal(truncated, true);
  const parsed = JSON.parse(json);
  assert.ok(parsed.items.length < big.length);
  assert.ok(Buffer.byteLength(json, "utf8") <= MAX_RESPONSE_BYTES);
});

test("truncateJson hard-slices payloads with no items array", () => {
  const payload = { blob: "y".repeat(MAX_RESPONSE_BYTES * 2) };
  const { json, truncated } = truncateJson(payload, 1024);
  assert.equal(truncated, true);
  assert.ok(Buffer.byteLength(json, "utf8") <= 1024);
});
