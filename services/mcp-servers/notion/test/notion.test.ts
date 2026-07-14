import { test } from "node:test";
import assert from "node:assert/strict";
import { NotionMcp } from "../src/notion.ts";
const ctx = { credential: "vault:notion" };
test("create + read + search", async () => {
  const t = new NotionMcp().tools();
  const pg: any = await t["notion.create_page"]({ title: "Spec", content: "x" }, ctx);
  assert.match(pg.url, /notion/);
  assert.ok((await t["notion.read_page"]({ id: "pg_1" }, ctx) as any).title);
  assert.ok((await t["notion.search"]({ query: "spec" }, ctx) as any[]).length);
});
