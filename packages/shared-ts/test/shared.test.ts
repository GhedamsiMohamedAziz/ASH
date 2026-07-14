// AX-007 shared-ts tests. Run: node --test test/shared.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DedupeGuard, InMemoryBus } from "../src/bus.ts";
import { InMemoryStore } from "../src/idempotency.ts";
import { sign, verify, InvalidClaim } from "../src/jwt.ts";

// ---------------------------------------------------------------- jwt requireExp
test("requireExp rejects a token with no expiry (fail closed)", () => {
  const noExp = sign({ sub: "u", iat: 1000 }, "s"); // no exp claim
  assert.throws(() => verify(noExp, "s", { requireExp: true }), InvalidClaim);
  // Without the flag the same token verifies (other token types may be long-lived).
  assert.equal(verify(noExp, "s").sub, "u");
});

test("requireExp passes when exp is present and valid", () => {
  const withExp = sign({ sub: "u", iat: 1000, exp: 9999999999 }, "s");
  assert.equal(verify(withExp, "s", { requireExp: true }).sub, "u");
});

// ---------------------------------------------------------------- bus
test("bus publish/subscribe with trailing-* wildcard", async () => {
  const bus = new InMemoryBus();
  const got: string[] = [];
  bus.subscribe("agent.events.*", (m) => {
    got.push(m.subject);
  });
  bus.subscribe("inbound.messages", (m) => {
    got.push(m.subject);
  });
  await bus.publish("agent.events.conv_1", { x: 1 });
  await bus.publish("inbound.messages", { y: 2 });
  await bus.publish("other.subject", { z: 3 }); // no subscriber
  assert.deepEqual(got, ["agent.events.conv_1", "inbound.messages"]);
});

test("bus unsubscribe stops delivery", async () => {
  const bus = new InMemoryBus();
  const got: string[] = [];
  const unsub = bus.subscribe("s", () => got.push("x"));
  unsub();
  await bus.publish("s", {});
  assert.deepEqual(got, []);
});

test("dedupe guard drops repeats, empty id never dedups", () => {
  const g = new DedupeGuard();
  assert.equal(g.isDuplicate("m1"), false);
  assert.equal(g.isDuplicate("m1"), true);
  assert.equal(g.isDuplicate(""), false);
  assert.equal(g.isDuplicate("m2"), false);
});

// ---------------------------------------------------------------- idempotency
test("idempotency remember/get/seen", () => {
  const s = new InMemoryStore();
  assert.equal(s.remember("k", { id: 1 }), true);
  assert.equal(s.remember("k", { id: 1 }), false); // duplicate
  assert.deepEqual(s.get("k"), { id: 1 });
  assert.equal(s.seen("k"), true);
  assert.equal(s.seen("nope"), false);
});

test("idempotency ttl expiry", () => {
  const s = new InMemoryStore();
  s.remember("k", "v", -1); // already expired
  assert.equal(s.get("k"), null);
  assert.equal(s.remember("k", "v2"), true); // can store again
});
