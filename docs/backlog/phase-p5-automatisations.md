# P5 — Automatisations

> automation-service + Trigger.dev, Scheduler MCP, delivery, fire-time perms.  ·  _3 wk_  ·  13 tickets

## ✅ AX-055 — automation-service jobs API ⭐M0

TypeScript service owning scheduled_jobs: create/update/pause/resume/delete/resync.

- **Estimate:** L  ·  **Labels:** automation  ·  **Spec:** §15.2, §8.2
- **Depends on:** AX-004
- **Acceptance:**
  - [ ] CRUD + resync endpoints
  - [ ] scheduled_jobs is source of truth
  - [ ] idempotent create (dedup key)

## ✅ AX-056 — Trigger.dev self-hosted ⭐M0

Deploy Trigger.dev v4 (webapp/supervisor/workers/datastores); DEV/STAGING/PROD envs isolated.

- **Estimate:** L  ·  **Labels:** automation, infra  ·  **Spec:** §15, §22.1, ADR 004
- **Depends on:** AX-055
- **Acceptance:**
  - [ ] Trigger.dev up self-hosted
  - [ ] envs isolated
  - [ ] dashboard reachable

## ✅ AX-057 — Pivot task (agent-scheduled-run) ⭐M0

The one durable task that fires a cron and re-injects an InboundMessage into /internal/scheduled-runs.

- **Estimate:** L  ·  **Labels:** automation  ·  **Spec:** §15.3, ADR 005
- **Depends on:** AX-056, AX-012
- **Acceptance:**
  - [ ] Cron re-enters standard pipeline
  - [ ] idempotency key per fire
  - [ ] retries durable

## ✅ AX-058 — Scheduler MCP façade ⭐M0

MCP tools create_cron/list_crons/pause/run_now over automation-service; policy-gated.

- **Estimate:** M  ·  **Labels:** mcp-server, automation  ·  **Spec:** §14.1, §15
- **Depends on:** AX-055, AX-017
- **Acceptance:**
  - [ ] Tools callable by agent
  - [ ] create_cron require_approval default
  - [ ] list_crons allow

## ✅ AX-059 — Cron creation flow + approval ⭐M0

NL intent → proposed cron → user confirmation → active; immutable versioned prompt.

- **Estimate:** M  ·  **Labels:** automation, approvals  ·  **Spec:** §15.4, §9.2
- **Depends on:** AX-058, AX-033
- **Acceptance:**
  - [ ] Draft→pending→active lifecycle
  - [ ] prompt immutable/versioned
  - [ ] agent.cron.created emitted

## ✅ AX-060 — Fire-time permissions preflight ⭐M0

Re-evaluate perms/guardrails/budgets at each run; degrade/pause on revocation (E_PERM_REVOKED).

- **Estimate:** L  ·  **Labels:** automation, security  ·  **Spec:** §9.4, §15.6, ADR 006
- **Depends on:** AX-057, AX-032
- **Acceptance:**
  - [ ] Perms re-checked per run
  - [ ] revoked user → job paused + notified
  - [ ] never escalates

## ✅ AX-061 — Job lifecycle state machine

draft/pending_approval/active/paused/deleted with 3-failure auto-pause and resume re-checks.

- **Estimate:** M  ·  **Labels:** automation  ·  **Spec:** §15.4
- **Depends on:** AX-059
- **Acceptance:**
  - [ ] State transitions enforced
  - [ ] auto-pause on 3 failures
  - [ ] resume re-verifies quotas/policy

## ✅ AX-062 — Delivery & notifications ⭐M0

Deliver run results to DM/email/webhook; anti-noise digests; no-op suppression.

- **Estimate:** M  ·  **Labels:** automation, notifications  ·  **Spec:** §15.5
- **Depends on:** AX-057
- **Acceptance:**
  - [ ] 3 delivery channels
  - [ ] digest batching
  - [ ] no-op runs suppressed

## ✅ AX-063 — job_memory between runs

Persist per-job state (dedup already-alerted, no_op markers) in scheduled_jobs.job_memory.

- **Estimate:** S  ·  **Labels:** automation, memory  ·  **Spec:** §9.1, §15
- **Depends on:** AX-057
- **Acceptance:**
  - [ ] State persists across runs
  - [ ] duplicate alerts suppressed
  - [ ] bounded size

## ✅ AX-064 — Automations UI page

User page: list crons (human schedule, next run, run history+cost), pause/resume/edit/delete.

- **Estimate:** M  ·  **Labels:** web, automation  ·  **Spec:** §4.4, §7.3
- **Depends on:** AX-055, AX-019
- **Acceptance:**
  - [ ] Crons listed with next run
  - [ ] pause/resume/edit works
  - [ ] run history + cost shown

## ✅ AX-065 — Internal platform jobs

Migrate consolidation jobs to Trigger.dev: memory-consolidation, oauth-refresh-sweep, partition roll, user-erasure.

- **Estimate:** M  ·  **Labels:** automation, platform  ·  **Spec:** §9.1.3, §15.7
- **Depends on:** AX-056
- **Acceptance:**
  - [ ] 4 internal jobs scheduled
  - [ ] declarative schedules deploy
  - [ ] runs observable

## ✅ AX-066 — Event-driven automations (webhooks)

Inbound webhooks trigger automations (Sentry/GitHub events) into the same pipeline.

- **Estimate:** M  ·  **Labels:** automation  ·  **Spec:** §15.8
- **Depends on:** AX-057
- **Acceptance:**
  - [ ] Webhook → automation run
  - [ ] signature verified
  - [ ] same guardrails/audit

## ✅ AX-067 — P5 exit: fire-time perms proven ⭐M0

Demo §18.2 + §18.3 end-to-end; revoke a right and show the job pauses.

- **Estimate:** S  ·  **Labels:** milestone, security  ·  **Spec:** §29 P5
- **Depends on:** AX-060, AX-062
- **Acceptance:**
  - [ ] Cron create+run demoed
  - [ ] revocation test pauses job
  - [ ] P5 exit gate green
