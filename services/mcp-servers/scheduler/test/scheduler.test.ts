// AX-058 Scheduler MCP tests. Run: node --test test/scheduler.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SchedulerMcp,
  humanize,
  validateCron,
  type AutomationBackend,
  type CronSpec,
} from "../src/scheduler.ts";

// ---------------------------------------------------------------- cron validation (§15.6, §21)
test("valid 5-field cron passes", () => {
  assert.equal(validateCron("0 9 * * 1"), null);
});

test("wrong field count rejected", () => {
  assert.match(validateCron("0 9 * *")!, /5 fields/);
});

test("sub-15-min interval rejected", () => {
  assert.match(validateCron("*/5 * * * *")!, /< 15 min/);
  assert.match(validateCron("* * * * *")!, /< 15 min/);
});

// ---------------------------------------------------------------- humanize (§4.3)
test("weekly cron humanized", () => {
  assert.match(humanize("30 9 * * 1", "Europe/Paris"), /chaque lun à 9h30/);
});

test("daily cron humanized", () => {
  assert.match(humanize("0 8 * * *"), /chaque jour à 8h00/);
});

// ---------------------------------------------------------------- MCP tools
class FakeBackend implements AutomationBackend {
  created: CronSpec[] = [];
  async create(_u: string, _o: string, spec: CronSpec) {
    this.created.push(spec);
    return { jobId: "job_1", status: "pending_approval", humanSchedule: "" };
  }
  async list() {
    return [{ jobId: "job_1", status: "active", humanSchedule: "chaque lun à 9h" }];
  }
  async pause(jobId: string) {
    return { jobId, status: "paused", humanSchedule: "" };
  }
  async resume(jobId: string) {
    return { jobId, status: "active", humanSchedule: "" };
  }
  async runNow(jobId: string) {
    return { runId: "srun_1" };
  }
}

function spec(cron: string): CronSpec {
  return { name: "morning", prompt: "résume mes PRs", cron,
    delivery: { channel: "slack", target: "U1" },
    perRunBudget: { maxCostUsd: 0.5, maxSeconds: 120 } };
}

test("create_cron validates then forwards, returns human schedule", async () => {
  const b = new FakeBackend();
  const tools = new SchedulerMcp(b).tools("usr_1", "org_1");
  const r: any = await tools["scheduler.create_cron"](spec("0 9 * * 1"));
  assert.equal(r.jobId, "job_1");
  assert.match(r.humanSchedule, /chaque lun/);
  assert.equal(b.created.length, 1);
});

test("create_cron rejects an invalid cron before forwarding", async () => {
  const b = new FakeBackend();
  const tools = new SchedulerMcp(b).tools("usr_1", "org_1");
  const r: any = await tools["scheduler.create_cron"](spec("*/1 * * * *"));
  assert.equal(r.error.code, "E_SCHED_INVALID_CRON");
  assert.equal(b.created.length, 0); // not forwarded
});

test("list/pause/resume/run_now forward to the backend", async () => {
  const tools = new SchedulerMcp(new FakeBackend()).tools("usr_1", "org_1");
  assert.equal((await tools["scheduler.list_crons"]({}) as any[]).length, 1);
  assert.equal((await tools["scheduler.pause_cron"]({ jobId: "job_1" }) as any).status, "paused");
  assert.equal((await tools["scheduler.run_now"]({ jobId: "job_1" }) as any).runId, "srun_1");
});

// ---------------------------------------------------------------- arg validation (§14 fail-closed)
test("pause_cron rejects a missing jobId before forwarding", async () => {
  const b = new FakeBackend();
  const tools = new SchedulerMcp(b).tools("usr_1", "org_1");
  const r: any = await tools["scheduler.pause_cron"]({});
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /jobId/);
});

test("create_cron rejects a spec missing required fields", async () => {
  const b = new FakeBackend();
  const tools = new SchedulerMcp(b).tools("usr_1", "org_1");
  const r: any = await tools["scheduler.create_cron"]({ cron: "0 9 * * 1" }); // no name/prompt/delivery/budget
  assert.equal(r.error.code, "E_VALIDATION");
  assert.equal(b.created.length, 0); // never forwarded
});

test("create_cron rejects a malformed delivery object", async () => {
  const tools = new SchedulerMcp(new FakeBackend()).tools("usr_1", "org_1");
  const r: any = await tools["scheduler.create_cron"]({
    name: "x", prompt: "y", cron: "0 9 * * 1",
    delivery: { channel: "slack" }, // missing target
    perRunBudget: { maxCostUsd: 0.5, maxSeconds: 120 },
  });
  assert.equal(r.error.code, "E_VALIDATION");
  assert.match(r.error.message, /delivery\.target/);
});
