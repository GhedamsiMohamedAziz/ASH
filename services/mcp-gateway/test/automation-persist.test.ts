// Scheduler create_cron persistence wiring (§16.1, Phase 2). Proves an injected schedulerBackend
// is what scheduler.create_cron routes to through the FULL gateway path (TASK_JWT verify →
// allowed_tools → approval → audit), and that HttpAutomationBackend POSTs the CronSpec to
// backend-core's /internal/automations with the service token (keyless via a mocked fetch).
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGateway } from "../src/server.ts";
import type { AutomationBackend, CronSpec, JobRef } from "../../mcp-servers/scheduler/src/scheduler.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";

function taskJwt(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: "usr_1", org_id: "org_1",
    iss: "olma-prompt-layer", aud: "olma-mcp-gateway",
    iat: now - 5, exp: now + 3600,
    allowed_tools: ["scheduler.create_cron"], approval_tools: [],
    ...overrides,
  }, SECRET);
}

const SPEC: CronSpec = {
  name: "Résumé PRs", prompt: "résume mes PRs", cron: "0 9 * * *", timezone: "UTC",
  delivery: { channel: "web", target: "usr_1" },
  perRunBudget: { maxCostUsd: 0.5, maxSeconds: 60 },
};

test("scheduler.create_cron routes to the injected AutomationBackend through the full gateway path", async () => {
  const seen: { userId: string; orgId: string; spec: CronSpec }[] = [];
  const backend: AutomationBackend = {
    async create(userId, orgId, spec): Promise<JobRef> {
      seen.push({ userId, orgId, spec });
      return { jobId: "job_persisted_1", status: "active", humanSchedule: "" };
    },
    async list() { return []; },
    async pause(jobId) { return { jobId, status: "paused", humanSchedule: "" }; },
    async resume(jobId) { return { jobId, status: "active", humanSchedule: "" }; },
    async runNow() { return { runId: "srun_1" }; },
  };
  const gw = buildGateway({ schedulerBackend: backend });
  const r = await gw.call({ tool: "scheduler.create_cron", args: SPEC as unknown as Record<string, unknown>, taskJwt: taskJwt() });
  assert.equal(r.status, "ok");
  assert.equal(seen.length, 1);
  assert.equal(seen[0].userId, "usr_1");            // the verified TASK JWT subject
  assert.equal(seen[0].spec.cron, "0 9 * * *");
  assert.match(String(r.result), /job_persisted_1/); // the persisted jobId is surfaced
});

test("BACKEND_CORE_URL configured: HttpAutomationBackend POSTs the CronSpec to /internal/automations", async () => {
  const prevUrl = process.env.BACKEND_CORE_URL;
  const prevTok = process.env.AUTOMATION_SERVICE_TOKEN;
  const prevFetch = globalThis.fetch;
  process.env.BACKEND_CORE_URL = "http://backend.test:8000";
  process.env.AUTOMATION_SERVICE_TOKEN = "svc-tok";
  let seenUrl = "";
  let seenToken = "";
  let seenBody: any = null;
  globalThis.fetch = (async (url: string, init: any) => {
    seenUrl = String(url);
    seenToken = init.headers["X-Service-Token"];
    seenBody = JSON.parse(init.body);
    return { ok: true, status: 201, json: async () => ({ jobId: "job_http_1", status: "active" }) } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    const gw = buildGateway(); // no injected backend → env-driven HttpAutomationBackend
    const r = await gw.call({ tool: "scheduler.create_cron", args: SPEC as unknown as Record<string, unknown>, taskJwt: taskJwt() });
    assert.equal(r.status, "ok");
    assert.equal(seenUrl, "http://backend.test:8000/internal/automations");
    assert.equal(seenToken, "svc-tok");
    assert.equal(seenBody.user_id, "usr_1");
    assert.equal(seenBody.cron, "0 9 * * *");
    assert.equal(seenBody.created_by, "agent");
    assert.equal(seenBody.per_run_budget.max_cost_usd, 0.5);
    assert.match(String(r.result), /job_http_1/);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevUrl === undefined) delete process.env.BACKEND_CORE_URL; else process.env.BACKEND_CORE_URL = prevUrl;
    if (prevTok === undefined) delete process.env.AUTOMATION_SERVICE_TOKEN; else process.env.AUTOMATION_SERVICE_TOKEN = prevTok;
  }
});
