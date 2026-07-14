-- 0001_init.sql — Core schema (v1)
-- Source: instructions.md §16.1 (Schéma Postgres) + §9.1.2 (mémoire d'entités).
-- Target: Postgres 16 + pgvector.  Apply with your migration tool (Atlas per §22.3).

CREATE EXTENSION IF NOT EXISTS vector;   -- pgvector
CREATE EXTENSION IF NOT EXISTS citext;   -- case-insensitive email

-- ------------------------------------------------------------------ tenancy
CREATE TABLE orgs (
  id            TEXT PRIMARY KEY,                 -- org_acme
  name          TEXT NOT NULL,
  plan          TEXT NOT NULL DEFAULT 'standard',
  settings      JSONB NOT NULL DEFAULT '{}',      -- guardrails, models, automations...
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE users (
  id            TEXT PRIMARY KEY,                 -- usr_7f3a...
  org_id        TEXT REFERENCES orgs(id),
  email         CITEXT UNIQUE NOT NULL,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'member',   -- member|power_user|admin
  status        TEXT NOT NULL DEFAULT 'active',   -- active|suspended|offboarded (SCIM)
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE identities (                         -- channel → canonical user mapping
  user_id       TEXT REFERENCES users(id),
  provider      TEXT NOT NULL,                    -- entra|slack|web
  external_id   TEXT NOT NULL,                    -- aadObjectId | slack_user_id
  PRIMARY KEY (provider, external_id)
);

-- Platform super-admins (§24.1) — never mutable via the public API.
CREATE TABLE platform_admins (
  user_id       TEXT PRIMARY KEY REFERENCES users(id),
  granted_at    TIMESTAMPTZ DEFAULT now(),
  note          TEXT
);

-- ------------------------------------------------------------------ conversations
CREATE TABLE conversations (
  id            TEXT PRIMARY KEY,
  user_id       TEXT REFERENCES users(id),
  channel       TEXT NOT NULL,                    -- teams|slack|web|scheduler
  title         TEXT,
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT REFERENCES conversations(id),
  role            TEXT NOT NULL,                  -- user|assistant|tool|system
  content         JSONB NOT NULL,
  tokens_in       INT, tokens_out INT, cost_usd NUMERIC(10,5),
  created_at      TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX ON messages (conversation_id, created_at);

-- ------------------------------------------------------------------ memory (§9.1)
CREATE TABLE memories (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id),
  content     TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'fact',       -- fact|preference|procedure|correction
  embedding   VECTOR(1024),
  source_msg  TEXT,
  created_at  TIMESTAMPTZ DEFAULT now(),
  expires_at  TIMESTAMPTZ
);
CREATE INDEX ON memories USING hnsw (embedding vector_cosine_ops);

-- Temporal entity memory (§9.1.2) — never a destructive UPDATE; contradicted
-- facts are closed (valid_to = now()) and a new row is opened.
CREATE TABLE entities (
  id        TEXT PRIMARY KEY,                     -- ent_01H...
  user_id   TEXT REFERENCES users(id),            -- NULL if org-scoped
  org_id    TEXT REFERENCES orgs(id),
  kind      TEXT NOT NULL,                        -- person|project|repo|client|system
  name      TEXT NOT NULL,
  aliases   TEXT[] NOT NULL DEFAULT '{}',
  UNIQUE (org_id, user_id, kind, name)
);

CREATE TABLE entity_facts (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id),
  predicate   TEXT NOT NULL,                      -- on_call_de, utilise, appartient_a...
  object      TEXT NOT NULL,                      -- free value OR 'ent:<id>' (relation)
  source_msg  TEXT,
  confidence  NUMERIC(3,2) NOT NULL DEFAULT 0.80,
  valid_from  TIMESTAMPTZ NOT NULL DEFAULT now(),
  valid_to    TIMESTAMPTZ                         -- NULL = current fact
);
CREATE INDEX ON entity_facts (entity_id, predicate, valid_to);

-- ------------------------------------------------------------------ secrets & policy
CREATE TABLE oauth_tokens (
  user_id       TEXT REFERENCES users(id),
  provider      TEXT NOT NULL,                    -- github|notion|msgraph|slack
  access_token  BYTEA NOT NULL,                   -- AES-256-GCM (Vault key)
  refresh_token BYTEA,
  scopes        TEXT[],
  expires_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, provider)
);

CREATE TABLE tool_policies (
  org_id         TEXT REFERENCES orgs(id),
  role           TEXT NOT NULL,
  tool_pattern   TEXT NOT NULL,                   -- ex: 'scheduler.create_cron'
  effect         TEXT NOT NULL,                   -- allow|deny|require_approval
  approver_group TEXT,                            -- team mode (§3.3): NULL = requester approves
  PRIMARY KEY (org_id, role, tool_pattern)
);

-- ------------------------------------------------------------------ runtime & audit
CREATE TABLE sandboxes (
  user_id     TEXT PRIMARY KEY REFERENCES users(id),
  node        TEXT, container_id TEXT,
  state       TEXT NOT NULL,
  volume_id   TEXT NOT NULL,
  last_active TIMESTAMPTZ
);

-- Append-only, partitioned by month (§16.3).
CREATE TABLE audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY,
  ts          TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id     TEXT, org_id TEXT,
  actor       TEXT NOT NULL,                      -- agent|user|admin|system|scheduler
  action      TEXT NOT NULL,                      -- tool.call|cron.created|cron.run|...
  target      TEXT,
  details     JSONB,
  PRIMARY KEY (ts, id)
) PARTITION BY RANGE (ts);
-- Bootstrap partition; a monthly job (§16.3) rolls new ones forward.
CREATE TABLE audit_log_default PARTITION OF audit_log DEFAULT;

CREATE TABLE usage_daily (
  day DATE, org_id TEXT, user_id TEXT, model TEXT,
  origin TEXT NOT NULL DEFAULT 'interactive',     -- interactive|scheduled
  tokens_in BIGINT, tokens_out BIGINT, cost_usd NUMERIC(12,4),
  tool_calls INT, sandbox_seconds INT,
  PRIMARY KEY (day, org_id, user_id, model, origin)
);
