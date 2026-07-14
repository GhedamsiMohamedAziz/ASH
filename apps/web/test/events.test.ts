// AX-019 web chat event-mapping tests. Run: node --test test/events.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { reduceStream, toViewModel, type AgentEvent } from "../src/events.ts";

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
