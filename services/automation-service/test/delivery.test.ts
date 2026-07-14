// AX-062 delivery tests. Run: node --test test/delivery.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildDigest,
  decide,
  signWebhook,
  validateTarget,
  type RunRecap,
} from "../src/delivery.ts";

const ok: RunRecap = { jobId: "job_1", status: "success", summary: "3 PRs", noOp: false, costUsd: 0.02, links: [] };
const noop: RunRecap = { ...ok, noOp: true, summary: "nothing new" };
const fail: RunRecap = { ...ok, status: "failed", summary: "timeout" };

// ---------------------------------------------------------------- anti-noise (§15.5)
test("success with content always sends", () => {
  assert.equal(decide(ok, "always").action, "send");
});

test("no-op → digest under digest mode", () => {
  assert.equal(decide(noop, "digest").action, "digest");
});

test("no-op → suppressed under on_change mode", () => {
  assert.equal(decide(noop, "on_change").action, "suppress");
});

test("failure always sends immediately, even in digest mode", () => {
  assert.equal(decide(fail, "digest").action, "send");
});

// ---------------------------------------------------------------- exfiltration guard (§15.6)
test("webhook must be on the org allow-list", () => {
  const domains = new Set(["hooks.acme.com"]);
  assert.equal(
    validateTarget({ channel: "webhook", target: "https://hooks.acme.com/x" }, new Set(), domains),
    null,
  );
  assert.match(
    validateTarget({ channel: "webhook", target: "https://evil.example/x" }, new Set(), domains)!,
    /not on org allow-list/,
  );
});

test("DM target must be one of the user's own", () => {
  const mine = new Set(["U123"]);
  assert.equal(validateTarget({ channel: "slack", target: "U123" }, mine, new Set()), null);
  assert.match(
    validateTarget({ channel: "slack", target: "U999" }, mine, new Set())!,
    /not one of the user/,
  );
});

// ---------------------------------------------------------------- signing + digest
test("webhook signature is deterministic HMAC", () => {
  const sig = signWebhook('{"x":1}', "secret");
  assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  assert.equal(sig, signWebhook('{"x":1}', "secret")); // stable
});

test("digest batches multiple recaps", () => {
  const d = buildDigest([ok, noop]);
  assert.match(d, /Daily automations digest \(2\)/);
  assert.match(d, /job_1/);
});
