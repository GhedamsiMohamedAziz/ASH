// AX-055 job store tests. Run: node --test test/jobs.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { JobError, JobStore, type Job } from "../src/jobs.ts";

function mk(store: JobStore, createdBy: "agent" | "user" = "agent"): Job {
  return store.create({
    userId: "usr_1", orgId: "org_1", name: "morning", prompt: "résume mes PRs",
    cron: "0 9 * * 1", timezone: "Europe/Paris", createdBy,
  });
}

test("agent-created job starts pending_approval", () => {
  const s = new JobStore();
  assert.equal(mk(s).status, "pending_approval");
});

test("approve → active; run lifecycle", () => {
  const s = new JobStore();
  const j = mk(s);
  assert.equal(s.approve(j.id).status, "active");
  assert.equal(s.pause(j.id).status, "paused");
  assert.equal(s.resume(j.id).status, "active");
  s.delete(j.id);
  assert.equal(s.get(j.id)!.status, "deleted");
});

test("illegal transition rejected", () => {
  const s = new JobStore();
  const j = mk(s); // pending_approval
  assert.throws(() => s.resume(j.id), JobError); // can't resume a non-paused job
});

test("editing prompt bumps version and re-requires approval (§15.6)", () => {
  const s = new JobStore();
  const j = mk(s);
  s.approve(j.id);
  const edited = s.editPrompt(j.id, "résume mes PRs et merge les triviales");
  assert.equal(edited.promptVersion, 2);
  assert.equal(edited.status, "pending_approval");
});

test("3 consecutive failures auto-pause (§15.6)", () => {
  const s = new JobStore();
  const j = mk(s);
  s.approve(j.id);
  s.recordResult(j.id, false);
  s.recordResult(j.id, false);
  assert.equal(s.get(j.id)!.status, "active"); // not yet
  const after = s.recordResult(j.id, false);
  assert.equal(after.status, "paused");
  assert.match(after.pauseReason!, /3 consecutive/);
});

test("a success resets the failure counter", () => {
  const s = new JobStore();
  const j = mk(s);
  s.approve(j.id);
  s.recordResult(j.id, false);
  s.recordResult(j.id, true); // reset
  s.recordResult(j.id, false);
  s.recordResult(j.id, false);
  assert.equal(s.get(j.id)!.status, "active"); // only 2 in a row → still active
});

test("list excludes deleted and filters by user", () => {
  const s = new JobStore();
  const a = mk(s);
  const b = mk(s);
  s.delete(b.id);
  const ids = s.list("usr_1").map((j) => j.id);
  assert.deepEqual(ids, [a.id]);
});
