import { test } from "node:test";
import assert from "node:assert/strict";
import { ProactiveDelivery } from "../src/proactive.ts";
test("delivers into remembered thread", () => {
  const p = new ProactiveDelivery();
  p.remember("conv_1", { channel: "C1", threadTs: "1.1", userId: "U1" });
  const m = p.deliver("conv_1", "run done")!;
  assert.equal(m.channel, "C1"); assert.equal(m.text, "run done");
});
test("mentions user for long-task completion", () => {
  const p = new ProactiveDelivery();
  p.remember("conv_1", { channel: "C1", userId: "U1" });
  assert.match(p.deliver("conv_1", "done", true)!.text, /<@U1> done/);
});
test("unknown conversation returns null", () => {
  assert.equal(new ProactiveDelivery().deliver("nope", "x"), null);
});
