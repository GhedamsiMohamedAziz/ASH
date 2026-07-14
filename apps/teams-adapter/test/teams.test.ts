// AX-023/024 Teams adapter tests. Run: node --test test/teams.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalize, type IdentityResolver, type TeamsActivity } from "../src/normalize.ts";
import { validateClaims } from "../src/verify.ts";

const linked: IdentityResolver = (aad) =>
  aad === "aad-known" ? { userId: "usr_1", orgId: "org_1", locale: "fr-FR" } : null;

function activity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message", id: "act_1", text: "<at>bot</at> déploie fix/login",
    from: { aadObjectId: "aad-known", name: "Mehdi" },
    conversation: { id: "conv_x" },
    channelData: { tenant: { id: "tenant_1" } }, ...overrides,
  };
}

// ---------------------------------------------------------------- normalization (§7.1, §7.4)
test("normalizes a linked activity, stripping the bot mention", () => {
  const m = normalize(activity(), linked, "2026-07-13T09:00:00Z")!;
  assert.equal(m.channel, "teams");
  assert.equal(m.user_id, "usr_1");
  assert.equal(m.text, "déploie fix/login"); // <at>bot</at> stripped
  assert.equal(m.idempotency_key, "act_1");
  assert.equal(m.channel_ref.activity_id, "act_1");
});

test("unlinked user returns null (SSO/account-linking flow §7.1)", () => {
  assert.equal(normalize(activity({ from: { aadObjectId: "aad-stranger" } }), linked, "t"), null);
});

test("non-message activity ignored", () => {
  assert.equal(normalize(activity({ type: "typing" }), linked, "t"), null);
});

// ---------------------------------------------------------------- Bot Framework JWT (§7.1)
const good = { iss: "https://api.botframework.com", aud: "bot-app-id", exp: 2000 };

test("valid claims pass", () => {
  assert.deepEqual(validateClaims(good, { botAppId: "bot-app-id", now: 1500 }), { ok: true });
});

test("wrong audience (not the bot App ID) rejected", () => {
  const r = validateClaims({ ...good, aud: "someone-else" }, { botAppId: "bot-app-id", now: 1500 });
  assert.equal(r.ok, false);
  assert.equal((r as any).reason, "bad_audience");
});

test("untrusted issuer rejected", () => {
  const r = validateClaims({ ...good, iss: "https://evil.example" }, { botAppId: "bot-app-id", now: 1500 });
  assert.equal((r as any).reason, "bad_issuer");
});

test("expired beyond 5-min skew rejected", () => {
  const r = validateClaims(good, { botAppId: "bot-app-id", now: 2000 + 400 });
  assert.equal((r as any).reason, "expired");
});

test("within 5-min clock skew still valid", () => {
  const r = validateClaims(good, { botAppId: "bot-app-id", now: 2000 + 200 });
  assert.equal(r.ok, true);
});
