# Automation Service

> **Status:** scaffold (Phase P5) · **Spec:** instructions.md §15

Owns scheduled_jobs (business source of truth), drives Trigger.dev, re-injects fired crons into /internal/scheduled-runs.

- **Stack:** TypeScript + @trigger.dev/sdk
- **Contracts:** see `packages/schemas` (InboundMessage / AgentEvent) and `packages/errors` (taxonomy §21).

## Fire-time preflight (AX-060, built) — the governance moat

The security-critical half is implemented in the prompt-layer
(`services/prompt-layer/app/scheduled.py`), because a scheduled run re-enters the
**same pipeline** as a human message (§9). At each fire, permissions are
re-evaluated against the current `tool_policies` (Principle #7, ADR 006): a
revoked right, an offboarded creator, the org kill-switch, or 3 consecutive
failures auto-pause the job — it never runs with stale rights.

**Live demo (§18.3):** `services/prompt-layer/demo_revocation.py` — a cron proceeds,
an admin revokes `github.merge_pr` in the DB, the same cron fires again and pauses
with `E_PERM_REVOKED`. Run against a migrated Postgres:
`DATABASE_URL=... python3 demo_revocation.py`. Tests: `tests/test_scheduled.py` (9).

## Job store + fire pivot (AX-055 CRUD, AX-057 pivot — built)

The durable business logic — `scheduled_jobs` is the source of truth (§16.2) — lives
in `services/prompt-layer/app/scheduler.py`:

- **JobStore** (AX-055): CRUD with the §15.4 lifecycle
  (draft→pending_approval→active→paused→deleted), agent-created jobs start
  `pending_approval` (require_approval default).
- **fire_job** (AX-057): the pivot. Runs the fire-time preflight (AX-060); if it
  proceeds, re-injects the prompt as a `scheduler`-channel InboundMessage through the
  SAME pipeline (`build_task`, ADR 005), emitting a scheduled AgentTask. Idempotent
  per `(job_id, scheduled_for)` (§15.6).

Tests `tests/test_scheduler.py` (9) — incl. the revocation now running on the real
store: fire an active job → scheduled AgentTask; revoke the right → job paused,
`E_PERM_REVOKED`, run skipped; duplicate fire → skipped (idempotency).

## Trigger.dev engine (AX-056)

- **Config**: `trigger.config.ts` — DEV/STAGING/PROD projects isolated (§22.1),
  15-min maxDuration, durable retries (3×, backoff).
- **Pivot task**: `trigger/agent-scheduled-run.ts` — the ONE durable task (§15.3,
  ADR 005): fires a cron (externalId = job_id), re-injects into backend-core
  `/internal/scheduled-runs` with `Idempotency-Key = job_id:scheduled_for` (dedup,
  §15.6), throws on failure → Trigger.dev retry. Schedules created imperatively per
  user cron via `schedules.create({ deduplicationKey: job_id })` → resync-safe (§23).
- **Stack**: `docker compose up trigger` (image `ghcr.io/triggerdotdev/trigger.dev:v4`,
  own Postgres/Redis; §22.2). Deploy tasks with `trigger deploy`.

Both `.ts` files are syntax-validated; the image pulls and the datastores run. A
live dashboard needs the operator to set the auth/magic-link env (standard
Trigger.dev self-host config).
