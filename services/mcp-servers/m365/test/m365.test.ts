import { test } from "node:test";
import assert from "node:assert/strict";
import { M365Mcp } from "../src/m365.ts";
const ctx = { credential: "vault:graph", userId: "usr_1" };
test("list + read mail", async () => {
  const t = new M365Mcp().tools();
  const mails: any = await t["m365.list_mail"]({ folder: "inbox" }, ctx);
  assert.ok(mails.length >= 1);
  const body: any = await t["m365.read_mail"]({ id: "m1" }, ctx);
  assert.ok(body.body);
});
test("send_mail tool exists (approval-gated by tool_policies)", async () => {
  const t = new M365Mcp().tools();
  assert.ok("m365.send_mail" in t);
  const r: any = await t["m365.send_mail"]({ to: "x@y.com", subject: "hi", body: "b" }, ctx);
  assert.ok(r.id);
});
test("search files + create event", async () => {
  const t = new M365Mcp().tools();
  assert.ok((await t["m365.search_files"]({ query: "budget" }, ctx) as any[]).length);
  assert.ok((await t["m365.create_event"]({ title: "1:1", start: "2026-07-13T09:00Z" }, ctx) as any).id);
});
