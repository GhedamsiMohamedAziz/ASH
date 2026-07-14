// AX-025/026 slack-adapter tests. Run: node --test test/adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventDedup, signSlackRequest, verifySlackSignature } from "../src/verify.ts";
import { normalize, type IdentityResolver, type SlackEvent } from "../src/normalize.ts";

const SECRET = "slack-signing-secret";

function headersFor(rawBody: string, ts: number) {
  return {
    "x-slack-signature": signSlackRequest(rawBody, SECRET, ts),
    "x-slack-request-timestamp": String(ts),
  };
}

// ---------------------------------------------------------------- signature (§7.2)
test("valid signature verifies", () => {
  const body = "payload=1";
  const r = verifySlackSignature(headersFor(body, 1000), body, SECRET, 1000);
  assert.deepEqual(r, { ok: true });
});

test("tampered body fails signature", () => {
  const body = "payload=1";
  const h = headersFor(body, 1000);
  const r = verifySlackSignature(h, "payload=EVIL", SECRET, 1000);
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "bad_signature");
});

test("wrong secret fails", () => {
  const body = "x";
  const h = headersFor(body, 1000);
  const r = verifySlackSignature(h, body, "other-secret", 1000);
  assert.equal(r.ok, false);
});

test("stale timestamp rejected (anti-replay)", () => {
  const body = "x";
  const h = headersFor(body, 1000);
  const r = verifySlackSignature(h, body, SECRET, 1000 + 600); // 10 min later
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "stale");
});

test("missing headers rejected", () => {
  const r = verifySlackSignature({}, "x", SECRET, 1000);
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "missing");
});

// ---------------------------------------------------------------- retry dedup (§7.2)
test("duplicate event_id is dropped", () => {
  const d = new EventDedup();
  assert.equal(d.isDuplicate("Ev123"), false);
  assert.equal(d.isDuplicate("Ev123"), true); // Slack retry
  assert.equal(d.isDuplicate("Ev999"), false);
});

// ---------------------------------------------------------------- normalization (§7.4)
const linked: IdentityResolver = (team, user) =>
  user === "U_KNOWN" ? { userId: "usr_1", orgId: "org_1", locale: "fr-FR" } : null;

function evt(overrides: Partial<SlackEvent["event"]> = {}): SlackEvent {
  return {
    team_id: "T1",
    event_id: "Ev123",
    event: {
      type: "app_mention", user: "U_KNOWN", channel: "C1",
      text: "<@UBOT> déploie fix/login sur staging", ts: "1699.1", ...overrides,
    },
  };
}

test("normalizes a linked mention into InboundMessage, stripping the bot mention", () => {
  const m = normalize(evt(), linked, "2026-07-13T09:00:00Z")!;
  assert.equal(m.channel, "slack");
  assert.equal(m.user_id, "usr_1");
  assert.equal(m.org_id, "org_1");
  assert.equal(m.text, "déploie fix/login sur staging"); // <@UBOT> stripped
  assert.equal(m.idempotency_key, "Ev123");
  assert.equal(m.locale, "fr-FR");
});

test("thread_ts drives the conversation id", () => {
  const m = normalize(evt({ thread_ts: "1699.0" }), linked, "t")!;
  assert.equal(m.conversation_id, "slack:C1:1699.0");
});

test("unlinked user returns null (adapter sends linking prompt §7.2)", () => {
  const m = normalize(evt({ user: "U_STRANGER" }), linked, "t");
  assert.equal(m, null);
});
