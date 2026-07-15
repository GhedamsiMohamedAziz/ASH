// AX-007 shared-ts tests. Run: node --test test/shared.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DedupeGuard, InMemoryBus } from "../src/bus.ts";
import { InMemoryStore } from "../src/idempotency.ts";
import {
  sign, verify, InvalidClaim,
  loadJwks, verifyES256, UnknownKey, InvalidSignature, JWTError,
} from "../src/jwt.ts";

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

// ---------------------------------------------------------------- ES256 (§13.4 seam)
// The committed vector is an ES256 TASK JWT minted by the Python prompt-layer signer
// (services/prompt-layer/app/task_jwt.mint). Verifying the SAME bytes here proves the
// TS gateway and the Python minter agree cross-language on P-256/JOSE ES256.
const fx = (name: string) => new URL(`./fixtures/${name}`, import.meta.url);
const JWKS = loadJwks(fx("task-jwt-es256.jwks.test.json").pathname);
const VECTOR = JSON.parse(readFileSync(fx("task-jwt-es256.vector.test.json"), "utf8"));

test("ES256: verifies the Python-minted committed vector + claims (cross-language)", () => {
  const claims = verifyES256(VECTOR.token, JWKS, {
    now: VECTOR.now, iss: "olma-prompt-layer", aud: "olma-mcp-gateway", requireExp: true,
  });
  assert.equal(claims.sub, "usr_1");
  assert.equal(claims.org_id, "org_1");
  assert.deepEqual(claims.allowed_tools, VECTOR.claims.allowed_tools);
  assert.equal(claims.task_id, "task_es256_vector");
});

test("ES256 fail-closed: unknown kid rejected", () => {
  // Re-header the token with a kid that is not in the JWKS.
  const [h, p, s] = VECTOR.token.split(".");
  const hdr = JSON.parse(Buffer.from(h, "base64url").toString());
  hdr.kid = VECTOR.unknown_kid;
  const forged = `${Buffer.from(JSON.stringify(hdr)).toString("base64url")}.${p}.${s}`;
  assert.throws(() => verifyES256(forged, JWKS, { now: VECTOR.now }), UnknownKey);
});

test("ES256 fail-closed: tampered signature rejected", () => {
  const tampered = VECTOR.token.slice(0, -4) + (VECTOR.token.endsWith("AAAA") ? "BBBB" : "AAAA");
  assert.throws(() => verifyES256(tampered, JWKS, { now: VECTOR.now }), InvalidSignature);
});

test("ES256 fail-closed: aud mismatch rejected", () => {
  assert.throws(
    () => verifyES256(VECTOR.token, JWKS, { now: VECTOR.now, aud: "someone-else" }),
    InvalidClaim,
  );
});

test("ES256 fail-closed: alg:none / wrong alg rejected (no HS256 fallback)", () => {
  const [, p, s] = VECTOR.token.split(".");
  const noneHdr = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT", kid: VECTOR.kid })).toString("base64url");
  assert.throws(() => verifyES256(`${noneHdr}.${p}.${s}`, JWKS, { now: VECTOR.now }), JWTError);
});
