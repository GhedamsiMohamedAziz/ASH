-- 0004_tenant_isolation.sql — DB-enforced multi-tenant isolation (CLAUDE.md invariant #3).
--
-- Why an expand migration and not a rewrite of 0001: 0001 is already committed/applied. The
-- expand/contract rule (§16.3, ADR-016 spirit) forbids a destructive rewrite — that is exactly
-- the "production migration in six months" failure the contract warns against. This migration
-- ADDS only: org_id on the tenant tables that lack it, source_trust on memory tables, a
-- non-superuser app role, and RLS FORCE + a tenant_isolation policy on the 10 tenant tables.
-- Security outcome is identical to org_id-in-the-initial-CREATE; nothing is dropped or renamed.
--
-- The isolation boundary is `app.org_id`, a session GUC set by the connection pool at check-out
-- from the VERIFIED JWT `org` claim (never a query parameter). current_setting(..., true) returns
-- NULL when unset, so `org_id = NULL` matches zero rows — a session with no org sees NOTHING
-- (fail-closed, invariant #1). FORCE makes RLS apply even to the table owner; the app connects as
-- the non-superuser role below, so the policy is always in force.
--
-- Scope: the 10 tenant-data tables named in the spec — conversations, messages, memories,
-- entities, entity_facts, scheduled_jobs, scheduled_runs, oauth_tokens, audit_log, usage_daily.
-- Auth/identity tables (orgs, users, identities, platform_admins) are the auth-service's plane,
-- accessed before app.org_id is known (login/lookup), and are intentionally out of app-role RLS.

-- ---------------------------------------------------------------- 1. add org_id where missing
-- Nullable add + backfill from the parent, so this is safe on a populated dev DB (no-op on empty).
ALTER TABLE conversations  ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id);
ALTER TABLE messages       ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id);
ALTER TABLE memories       ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id);
ALTER TABLE entity_facts   ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id);
ALTER TABLE oauth_tokens   ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id);
ALTER TABLE scheduled_runs ADD COLUMN IF NOT EXISTS org_id TEXT REFERENCES orgs(id);  -- scheduled_jobs had it; runs did not

-- Backfill denormalized org_id from the owning row (empty tables → no-op).
UPDATE conversations c SET org_id = u.org_id FROM users u WHERE c.user_id = u.id AND c.org_id IS NULL;
UPDATE messages m SET org_id = c.org_id FROM conversations c WHERE m.conversation_id = c.id AND m.org_id IS NULL;
UPDATE memories mem SET org_id = u.org_id FROM users u WHERE mem.user_id = u.id AND mem.org_id IS NULL;
UPDATE entity_facts f SET org_id = e.org_id FROM entities e WHERE f.entity_id = e.id AND f.org_id IS NULL;
UPDATE oauth_tokens o SET org_id = u.org_id FROM users u WHERE o.user_id = u.id AND o.org_id IS NULL;
UPDATE scheduled_runs r SET org_id = j.org_id FROM scheduled_jobs j WHERE r.job_id = j.id AND r.org_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_org ON conversations (org_id);
CREATE INDEX IF NOT EXISTS idx_messages_org      ON messages (org_id);
CREATE INDEX IF NOT EXISTS idx_memories_org      ON memories (org_id);
CREATE INDEX IF NOT EXISTS idx_entity_facts_org  ON entity_facts (org_id);

-- ---------------------------------------------------------------- 2. source_trust (invariant #9)
-- A contaminated turn writes only 'untrusted' memory (§9.1.4). Default 'trusted'; the pipeline
-- downgrades to 'untrusted' when the turn ingested untrusted content (taint).
ALTER TABLE memories     ADD COLUMN IF NOT EXISTS source_trust TEXT NOT NULL DEFAULT 'trusted';
ALTER TABLE entity_facts ADD COLUMN IF NOT EXISTS source_trust TEXT NOT NULL DEFAULT 'trusted';
-- ADD CONSTRAINT is not idempotent, so guard each (re-runnable migration).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memories_source_trust_ck') THEN
    ALTER TABLE memories ADD CONSTRAINT memories_source_trust_ck CHECK (source_trust IN ('trusted','untrusted')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'entity_facts_source_trust_ck') THEN
    ALTER TABLE entity_facts ADD CONSTRAINT entity_facts_source_trust_ck CHECK (source_trust IN ('trusted','untrusted')) NOT VALID;
  END IF;
END $$;

-- ---------------------------------------------------------------- 3. non-superuser app role
-- The application connects as this role (never as the owner/superuser), so FORCE RLS binds it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'olma_app') THEN
    CREATE ROLE olma_app NOSUPERUSER NOBYPASSRLS NOLOGIN;  -- prod: ALTER ROLE ... LOGIN PASSWORD
  END IF;
END $$;
GRANT USAGE ON SCHEMA public TO olma_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO olma_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO olma_app;

-- ---------------------------------------------------------------- 4. RLS FORCE + tenant policy
-- One policy shape, applied to every tenant table. USING gates reads; WITH CHECK gates writes,
-- so a session can neither read nor write another org's rows — and cannot insert a row stamped
-- with a foreign org_id.
DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'conversations','messages','memories','entities','entity_facts',
    'scheduled_jobs','scheduled_runs','oauth_tokens','audit_log','usage_daily'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($f$
      CREATE POLICY tenant_isolation ON %I
        USING (org_id = current_setting('app.org_id', true))
        WITH CHECK (org_id = current_setting('app.org_id', true))
    $f$, t);
  END LOOP;
END $$;
