-- 0002_automations.sql — Automations / crons (v2)
-- Source: instructions.md §16.1 (bloc "v2 : AUTOMATISATIONS").
-- scheduled_jobs is OUR business source of truth; Trigger.dev is the execution
-- engine (§16.2). Permissions are re-evaluated at fire time, never frozen (§9.4, ADR 006).

CREATE TABLE scheduled_jobs (
  id                    TEXT PRIMARY KEY,                    -- job_01H...
  user_id               TEXT NOT NULL REFERENCES users(id),
  org_id                TEXT NOT NULL REFERENCES orgs(id),
  name                  TEXT NOT NULL,
  prompt                TEXT NOT NULL,                       -- immutable snapshot
  prompt_version        INT NOT NULL DEFAULT 1,              -- +1 per approved edit
  agent_profile         TEXT NOT NULL DEFAULT 'generalist',
  cron                  TEXT NOT NULL,                       -- "0 9 * * 1" (no seconds)
  timezone              TEXT NOT NULL DEFAULT 'UTC',
  delivery              JSONB NOT NULL,                      -- {channel, target}
  per_run_budget        JSONB NOT NULL,                      -- {max_cost_usd, max_seconds}
  monthly_budget_usd    NUMERIC(10,2),
  on_approval_needed    TEXT NOT NULL DEFAULT 'fail_fast',   -- |use_pre_approved
  pre_approved_tools    TEXT[] NOT NULL DEFAULT '{}',
  job_memory            JSONB NOT NULL DEFAULT '{}',         -- persistent state between runs (§9.1)
  trigger_schedule_id   TEXT,                                -- Trigger.dev-side id
  status                TEXT NOT NULL DEFAULT 'pending_approval',
                        -- draft|pending_approval|active|paused|deleted
  pause_reason          TEXT,
  consecutive_failures  INT NOT NULL DEFAULT 0,
  created_by            TEXT NOT NULL,                       -- 'agent' | 'user'
  approved_by           TEXT REFERENCES users(id),
  next_run_at           TIMESTAMPTZ,
  last_run_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT now(),
  updated_at            TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON scheduled_jobs (user_id, status);
CREATE INDEX ON scheduled_jobs (org_id, status);

CREATE TABLE scheduled_runs (
  id              TEXT PRIMARY KEY,                          -- srun_01H...
  job_id          TEXT NOT NULL REFERENCES scheduled_jobs(id),
  trigger_run_id  TEXT,                                      -- Trigger.dev dashboard correlation
  conversation_id TEXT,                                      -- conversation created for this run
  scheduled_for   TIMESTAMPTZ NOT NULL,
  started_at      TIMESTAMPTZ, finished_at TIMESTAMPTZ,
  status          TEXT NOT NULL,                             -- queued|running|success|failed|skipped
  error_code      TEXT,                                      -- taxonomy §21
  cost_usd        NUMERIC(10,5),
  output_summary  TEXT,
  UNIQUE (job_id, scheduled_for)                             -- natural idempotence
);
CREATE INDEX ON scheduled_runs (job_id, scheduled_for DESC);
