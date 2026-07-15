"""Postgres persistence for conversations + messages (AX-012, §16.1).

Selected at startup when DATABASE_URL is set. Writes to the `conversations` and
`messages` tables from db/migrations/0001_init.sql. Events/WS stay in-memory
(transient); this only durably persists the conversation record and each message.
"""

from __future__ import annotations

import json
from contextlib import asynccontextmanager

import asyncpg

from .models import Conversation, Message


class PgStore:
    def __init__(self, dsn: str) -> None:
        self._dsn = dsn
        self._pool: asyncpg.Pool | None = None

    async def connect(self) -> None:
        self._pool = await asyncpg.create_pool(self._dsn, min_size=1, max_size=5)

    async def close(self) -> None:
        if self._pool is not None:
            await self._pool.close()

    @asynccontextmanager
    async def _acquire(self, org_id: str | None = None):
        """Acquire a pooled connection and set the `app.org_id` session GUC the RLS policy
        (migration 0004) keys on — WITHOUT this, current_setting('app.org_id', true) is NULL and
        the tenant_isolation policy is inert (the FIX-1 backstop never engages). The GUC is set on
        every checkout (to org_id, or '' when unknown) so a pooled connection never leaks a prior
        org's scope; '' matches zero rows, i.e. fail-closed. NOTE: the policy binds only when the
        app connects as the non-superuser `olma_app` role — a superuser/owner connection bypasses
        even FORCE RLS, so the deployment DSN must use the app role for this to be load-bearing."""
        async with self._pool.acquire() as con:
            await con.execute("SELECT set_config('app.org_id', $1, false)", org_id or "")
            yield con

    async def ensure_dev_user(self, user_id: str, org_id: str = "org_dev") -> None:
        """Dev convenience: FK targets must exist. Seed org+user idempotently."""
        async with self._acquire(org_id) as con:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES($1,$1) ON CONFLICT (id) DO NOTHING", org_id
            )
            await con.execute(
                """INSERT INTO users(id, org_id, email, role)
                   VALUES($1,$2,$3,'member') ON CONFLICT (id) DO NOTHING""",
                user_id, org_id, f"{user_id}@dev.local",
            )

    async def persist_conversation(self, conv: Conversation) -> None:
        async with self._pool.acquire() as con:
            await con.execute(
                """INSERT INTO conversations(id, user_id, channel, title, status)
                   VALUES($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING""",
                conv.id, conv.user_id, conv.channel.value, conv.title, conv.status,
            )

    async def persist_message(self, msg: Message) -> None:
        async with self._pool.acquire() as con:
            await con.execute(
                """INSERT INTO messages(id, conversation_id, role, content)
                   VALUES($1,$2,$3,$4::jsonb) ON CONFLICT (id) DO NOTHING""",
                msg.id, msg.conversation_id, msg.role, json.dumps(msg.content),
            )

    async def fetch_messages(self, conversation_id: str) -> list[dict]:
        async with self._pool.acquire() as con:
            rows = await con.fetch(
                "SELECT id, conversation_id, role, content, created_at "
                "FROM messages WHERE conversation_id=$1 ORDER BY created_at",
                conversation_id,
            )
        return [dict(r) for r in rows]

    # ------------------------------------------------------------- automations (§16.1, 0002)
    _JOB_COLUMNS = (
        "id, user_id, org_id, name, prompt, cron, timezone, status, monthly_budget_usd, "
        "next_run_at, last_run_at, created_at, updated_at"
    )

    async def list_scheduled_jobs(self, user_id: str) -> list[dict]:
        """Owner-scoped list (excludes soft-deleted rows), oldest first for stable cursors."""
        async with self._pool.acquire() as con:
            rows = await con.fetch(
                f"SELECT {self._JOB_COLUMNS} FROM scheduled_jobs "
                "WHERE user_id=$1 AND status != 'deleted' ORDER BY created_at, id",
                user_id,
            )
        return [dict(r) for r in rows]

    async def get_scheduled_job(self, job_id: str) -> dict | None:
        async with self._pool.acquire() as con:
            row = await con.fetchrow(
                f"SELECT {self._JOB_COLUMNS} FROM scheduled_jobs WHERE id=$1", job_id
            )
        return dict(row) if row is not None else None

    async def update_scheduled_job(self, job_id: str, fields: dict) -> dict | None:
        """Patch a whitelisted subset of columns (caller validates the field names/values;
        see AutomationPatch). No-op (plain re-fetch) when `fields` is empty."""
        if not fields:
            return await self.get_scheduled_job(job_id)
        cols = list(fields.keys())
        set_clause = ", ".join(f"{c}=${i + 2}" for i, c in enumerate(cols))
        async with self._pool.acquire() as con:
            row = await con.fetchrow(
                f"UPDATE scheduled_jobs SET {set_clause}, updated_at=now() "
                f"WHERE id=$1 RETURNING {self._JOB_COLUMNS}",
                job_id, *[fields[c] for c in cols],
            )
        return dict(row) if row is not None else None

    async def soft_delete_scheduled_job(self, job_id: str) -> bool:
        # Soft delete (status='deleted') — scheduled_runs keeps its FK to the job for history.
        async with self._pool.acquire() as con:
            tag = await con.execute(
                "UPDATE scheduled_jobs SET status='deleted', updated_at=now() WHERE id=$1",
                job_id,
            )
        return tag.split()[-1] != "0"

    async def list_scheduled_runs(self, job_id: str) -> list[dict]:
        async with self._pool.acquire() as con:
            rows = await con.fetch(
                "SELECT id, job_id, scheduled_for, started_at, finished_at, status, "
                "error_code, cost_usd, output_summary FROM scheduled_runs "
                "WHERE job_id=$1 ORDER BY scheduled_for DESC, id",
                job_id,
            )
        return [dict(r) for r in rows]

    # ------------------------------------------------------------- admin console reads (§24.1, §24.3, 0001)
    _USAGE_COLUMNS = (
        "day, org_id, user_id, model, origin, tokens_in, tokens_out, cost_usd, "
        "tool_calls, sandbox_seconds"
    )

    async def list_usage_daily(self, org_id: str | None = None, day: str | None = None) -> list[dict]:
        """Admin usage roll-up read (§24.3) — most-recent day first. usage_daily has no
        single-row identity (PK is the (day,org_id,user_id,model,origin) tuple), so the
        secondary ORDER BY columns exist only to make the offset-cursor window stable across
        pages. Read-only: rows are written by the LLM-proxy cost pipeline, not here."""
        clauses, args = [], []
        if org_id:
            args.append(org_id)
            clauses.append(f"org_id=${len(args)}")
        if day:
            args.append(day)
            clauses.append(f"day=${len(args)}")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        async with self._acquire(org_id) as con:
            rows = await con.fetch(
                f"SELECT {self._USAGE_COLUMNS} FROM usage_daily {where} "
                "ORDER BY day DESC, org_id, user_id, model, origin",
                *args,
            )
        return [dict(r) for r in rows]

    _AUDIT_COLUMNS = "id, ts, user_id, org_id, actor, action, target, details"

    async def list_audit_log(self, org_id: str | None = None) -> list[dict]:
        """Admin audit read (§24.1) — append-only, ts DESC/id DESC (most-recent first).
        `details` is JSONB; asyncpg returns it as raw JSON text, so decode it here (same
        pattern as AuditSink.export_worm)."""
        clauses, args = [], []
        if org_id:
            args.append(org_id)
            clauses.append(f"org_id=${len(args)}")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        async with self._acquire(org_id) as con:
            rows = await con.fetch(
                f"SELECT {self._AUDIT_COLUMNS} FROM audit_log {where} ORDER BY ts DESC, id DESC",
                *args,
            )
        return [{**dict(r), "details": json.loads(r["details"]) if r["details"] else {}}
                for r in rows]

    # ------------------------------------------------------------- admin console reads (§24.2, 0001)
    # Only safe, non-secret columns: no role, no auth-service claims, and nothing from
    # oauth_tokens/sandboxes credentials-adjacent fields leaks through these selects.
    _USER_COLUMNS = "id, org_id, email, display_name AS name, status, created_at"

    async def list_users(self, org_id: str | None = None, status: str | None = None) -> list[dict]:
        """Admin user directory read (§24.2) — most-recent first. org_id=None (platform_admin
        only, resolved by the caller) returns every org; otherwise scoped to one org."""
        clauses, args = [], []
        if org_id:
            args.append(org_id)
            clauses.append(f"org_id=${len(args)}")
        if status:
            args.append(status)
            clauses.append(f"status=${len(args)}")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        async with self._acquire(org_id) as con:
            rows = await con.fetch(
                f"SELECT {self._USER_COLUMNS} FROM users {where} "
                "ORDER BY created_at DESC, id DESC",
                *args,
            )
        return [dict(r) for r in rows]

    async def list_scheduled_jobs_for_org(self, org_id: str | None = None) -> list[dict]:
        """Admin org-wide automations read (§24.2) — ALL jobs in the org (unlike
        list_scheduled_jobs, which is owner-scoped for the user-facing /automations route),
        most-recent first. Excludes soft-deleted rows, same as the owner-scoped read.
        org_id=None (platform_admin only, resolved by the caller) returns every org."""
        clauses, args = [], []
        if org_id:
            args.append(org_id)
            clauses.append(f"org_id=${len(args)}")
        extra = f"AND {clauses[0]}" if clauses else ""
        async with self._acquire(org_id) as con:
            rows = await con.fetch(
                f"SELECT {self._JOB_COLUMNS} FROM scheduled_jobs "
                f"WHERE status != 'deleted' {extra} ORDER BY created_at DESC, id DESC",
                *args,
            )
        return [dict(r) for r in rows]

    # ------------------------------------------------------------- tool policies (§2.6, 0001/0003)
    async def list_tool_policies(self, org_id: str, role: str) -> list[dict]:
        """The caller's enforced approval matrix for this org+role, tool_pattern ASC for stable
        rendering. tool_policies is not one of the 10 RLS-scoped tenant tables (0004), so this
        filters by org_id explicitly rather than relying on the session GUC."""
        async with self._pool.acquire() as con:
            rows = await con.fetch(
                "SELECT tool_pattern, effect, approver_group FROM tool_policies "
                "WHERE org_id=$1 AND role=$2 ORDER BY tool_pattern",
                org_id, role,
            )
        return [dict(r) for r in rows]

    # sandboxes (0001) has no org_id column (PK is user_id) — scope by joining through users.
    _SANDBOX_COLUMNS = "s.user_id, s.node, s.container_id, s.state, s.volume_id, s.last_active"

    async def list_sandboxes(self, org_id: str | None = None) -> list[dict]:
        """Admin sandbox read (§24.2, §10 declared-truth model) — most-recently-active first.
        org_id=None (platform_admin only, resolved by the caller) returns every org."""
        clauses, args = [], []
        if org_id:
            args.append(org_id)
            clauses.append(f"u.org_id=${len(args)}")
        where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        async with self._acquire(org_id) as con:
            rows = await con.fetch(
                f"SELECT {self._SANDBOX_COLUMNS} FROM sandboxes s "
                f"JOIN users u ON u.id = s.user_id {where} "
                "ORDER BY s.last_active DESC NULLS LAST, s.user_id",
                *args,
            )
        return [dict(r) for r in rows]
