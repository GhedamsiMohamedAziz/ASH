import { test } from "node:test";
import assert from "node:assert/strict";
import { auditRow, auditSummary, automationRow, groupMemories, identityTypeLabel } from "../src/pages.ts";

test("memories grouped by kind with labels (§4.4)", () => {
  const g = groupMemories([
    { id: "1", content: "a", kind: "fact" },
    { id: "2", content: "b", kind: "correction" },
    { id: "3", content: "c", kind: "fact" },
  ]);
  const facts = g.find((x) => x.kind === "fact")!;
  assert.equal(facts.label, "Faits");
  assert.equal(facts.items.length, 2);
});

test("active automation row is amber + pausable (§4.5)", () => {
  const r = automationRow({ id: "j1", name: "Brief matin", humanSchedule: "chaque jour 8h", status: "active", costPerRun: 0.02 });
  assert.equal(r.color, "amber");
  assert.equal(r.canPause, true);
  assert.match(r.subtitle, /⟳ chaque jour 8h · active · \$0.0200\/run/);
});

test("paused automation is muted + not pausable", () => {
  const r = automationRow({ id: "j2", name: "x", humanSchedule: "y", status: "paused", costPerRun: 0 });
  assert.equal(r.color, "muted");
  assert.equal(r.canPause, false);
});

// ---- audit view (§16.1, §4.5 colours) ----
test("audit ok row is green, denied is rose (§4.5)", () => {
  const ok = auditRow({ ts: 0, actor: "u", on_behalf_of: null, action: "tool.call",
    tool: "github.search", status: "ok", redacted: [] });
  assert.equal(ok.color, "green");
  assert.equal(ok.statusLabel, "autorisé");
  const denied = auditRow({ ts: 0, actor: "u", on_behalf_of: null, action: "tool.call",
    tool: "github.merge_pr", status: "denied", redacted: [], reason: "tool not allowed" });
  assert.equal(denied.color, "rose");
  assert.equal(denied.reason, "tool not allowed");
});

test("Mode B on-behalf-of is surfaced (§3.2)", () => {
  const r = auditRow({ ts: 0, actor: "agent-org@org_1", on_behalf_of: "usr_mehdi",
    action: "tool.call", tool: "github.create_pr", status: "ok", redacted: [] });
  assert.equal(r.who, "agent-org@org_1 ⇢ usr_mehdi");
});

test("DLP redactions are shown on the audit row (§13.5)", () => {
  const r = auditRow({ ts: 0, actor: "u", on_behalf_of: null, action: "tool.call",
    tool: "github.read", status: "ok", redacted: ["github_token", "anthropic_key"] });
  assert.deepEqual(r.redactions, ["github_token", "anthropic_key"]);
});

test("real timestamp formats to HH:MM:SS, ts=0 → dash", () => {
  assert.equal(auditRow({ ts: 0, actor: "u", on_behalf_of: null, action: "a",
    tool: "t", status: "ok", redacted: [] }).time, "—");
  // epoch 1784283907 = 2026-07-13T10:25:07Z (UTC)
  assert.equal(auditRow({ ts: 1784283907, actor: "u", on_behalf_of: null, action: "a",
    tool: "t", status: "ok", redacted: [] }).time, "10:25:07");
});

test("audit summary counts verdicts + redacted calls", () => {
  const s = auditSummary([
    { ts: 0, actor: "u", on_behalf_of: null, action: "a", tool: "t1", status: "ok", redacted: ["github_token"] },
    { ts: 0, actor: "u", on_behalf_of: null, action: "a", tool: "t2", status: "ok", redacted: [] },
    { ts: 0, actor: "u", on_behalf_of: null, action: "a", tool: "t3", status: "denied", redacted: [] },
  ]);
  assert.equal(s.ok, 2);
  assert.equal(s.denied, 1);
  assert.equal(s.redactedCalls, 1);
});

// ---- connectors identity type (§2.5, §14) ----
test("identityTypeLabel: user-OAuth connectors", () => {
  assert.equal(identityTypeLabel("github"), "OAuth utilisateur");
  assert.equal(identityTypeLabel("slack"), "OAuth utilisateur");
  assert.equal(identityTypeLabel("notion"), "OAuth utilisateur");
});

test("identityTypeLabel: delegated + service-account connectors", () => {
  assert.equal(identityTypeLabel("m365"), "Permissions déléguées");
  assert.equal(identityTypeLabel("database"), "Compte de service");
});

test("identityTypeLabel: org-included connectors + unknown fallback", () => {
  assert.equal(identityTypeLabel("browser"), "Aucune / éphémère");
  assert.equal(identityTypeLabel("scheduler"), "Service token");
  assert.equal(identityTypeLabel("some_future_provider"), "Token par projet");
});
