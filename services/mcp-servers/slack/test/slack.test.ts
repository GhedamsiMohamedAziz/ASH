import { test } from "node:test";
import assert from "node:assert/strict";
import { SlackMcp } from "../src/slack.ts";
const ctx = { credential: "vault:slackbot" };
test("read channel respects limit", async () => {
  const t = new SlackMcp().tools();
  const msgs: any = await t["slack.read_channel"]({ channel: "C1", limit: 1 }, ctx);
  assert.equal(msgs.length, 1);
});
test("post recap returns ts", async () => {
  const t = new SlackMcp().tools();
  assert.ok((await t["slack.post_recap"]({ channel: "C1", text: "done" }, ctx) as any).ts);
});
