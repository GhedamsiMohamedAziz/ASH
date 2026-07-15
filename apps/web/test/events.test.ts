// AX-019 web chat event-mapping tests. Run: node --test test/events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceStream, toViewModel, applyIncomingEvent, type AgentEvent } from "../src/events.ts";

test("tool call → cyan monospace line (§4.3, §4.5)", () => {
  const vm = toViewModel({ type: "agent.tool.call", seq: 1, data: { tool: "github.search", args_summary: "login" } });
  assert.equal(vm.color, "cyan");
  assert.equal(vm.monospace, true);
  assert.match(vm.text, /→ github.search — login/);
});

test("approval → amber interactive card", () => {
  const vm = toViewModel({ type: "agent.approval.needed", seq: 2, data: { tool: "github.merge_pr" } });
  assert.equal(vm.color, "amber");
  assert.equal(vm.interactive, true);
});

test("cron created → amber chip (automations colour)", () => {
  const vm = toViewModel({ type: "agent.cron.created", seq: 3, data: { human_schedule: "chaque lundi 9h" } });
  assert.equal(vm.color, "amber");
  assert.match(vm.text, /⟳ chaque lundi 9h/);
});

test("error → rose", () => {
  const vm = toViewModel({ type: "agent.error", seq: 4, data: { message: "Session expirée" } });
  assert.equal(vm.color, "rose");
});

test("tool result error → rose, success → green", () => {
  assert.equal(toViewModel({ type: "agent.tool.result", seq: 1, data: { tool: "x", status: "error" } }).color, "rose");
  assert.equal(toViewModel({ type: "agent.tool.result", seq: 1, data: { tool: "x", status: "ok" } }).color, "green");
});

test("stream reducer coalesces text deltas into one bubble", () => {
  const events: AgentEvent[] = [
    { type: "agent.thinking", seq: 1 },
    { type: "agent.text.delta", seq: 2, data: { text: "bon" } },
    { type: "agent.text.delta", seq: 3, data: { text: "jour" } },
    { type: "agent.done", seq: 4, data: { cost_usd: 0.001 } },
  ];
  const rows = reduceStream(events);
  const delta = rows.find((r) => r.kind === "delta");
  assert.equal(delta!.text, "bonjour"); // coalesced
  assert.ok(rows.some((r) => r.kind === "done"));
});

test("reducer respects seq ordering", () => {
  const rows = reduceStream([
    { type: "agent.text.delta", seq: 3, data: { text: "C" } },
    { type: "agent.text.delta", seq: 1, data: { text: "A" } },
    { type: "agent.text.delta", seq: 2, data: { text: "B" } },
  ]);
  assert.equal(rows[0].text, "ABC");
});

test("approval row carries approval_id after delta coalescing (index-safe)", () => {
  const rows = reduceStream([
    { type: "agent.tool.call", seq: 1, data: { tool: "github.merge_pr" } },
    { type: "agent.approval.needed", seq: 2, data: { approval_id: "appr_9", tool: "github.merge_pr" } },
    { type: "agent.text.delta", seq: 3, data: { text: "a" } },
    { type: "agent.text.delta", seq: 4, data: { text: "b" } },
  ]);
  const appr = rows.find((r) => r.interactive);
  assert.equal(appr?.approvalId, "appr_9"); // must not depend on events[i] alignment
});

test("applyIncomingEvent (§2.3): accepts new seq and advances last_seq", () => {
  const r1 = applyIncomingEvent({ type: "agent.thinking", seq: 1 }, 0);
  assert.equal(r1.accepted?.seq, 1);
  assert.equal(r1.lastSeq, 1);

  const r2 = applyIncomingEvent({ type: "agent.text.delta", seq: 2, data: { text: "a" } }, r1.lastSeq);
  assert.equal(r2.accepted?.seq, 2);
  assert.equal(r2.lastSeq, 2);
});

test("applyIncomingEvent (§2.3): ignores duplicate/stale seq <= last_seq", () => {
  // duplicate: same seq replayed after reconnect
  const dup = applyIncomingEvent({ type: "agent.thinking", seq: 5 }, 5);
  assert.equal(dup.accepted, null);
  assert.equal(dup.lastSeq, 5); // last_seq unchanged

  // stale: out-of-order event behind the tracked position
  const stale = applyIncomingEvent({ type: "agent.text.delta", seq: 3, data: { text: "x" } }, 5);
  assert.equal(stale.accepted, null);
  assert.equal(stale.lastSeq, 5);
});

test("applyIncomingEvent (§2.3): out-of-order replay after reconnect is fully deduped", () => {
  // Simulate a reconnect where the server replays from an earlier point (e.g. resent
  // seq 3-6 even though we already applied up to 6) — only genuinely new seqs land.
  let lastSeq = 6;
  const accepted: AgentEvent[] = [];
  for (const ev of [
    { type: "agent.text.delta", seq: 3, data: { text: "old" } },
    { type: "agent.text.delta", seq: 5, data: { text: "old" } },
    { type: "agent.text.delta", seq: 6, data: { text: "old" } },
    { type: "agent.text.delta", seq: 7, data: { text: "new" } },
  ] as AgentEvent[]) {
    const r = applyIncomingEvent(ev, lastSeq);
    lastSeq = r.lastSeq;
    if (r.accepted) accepted.push(r.accepted);
  }
  assert.deepEqual(accepted.map((e) => e.seq), [7]);
  assert.equal(lastSeq, 7);
});
