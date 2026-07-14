"""Audit log persistence + export (instructions.md §16.1, §16.3, §15.7 audit-export-worm).

Append-only writes to the monthly-partitioned `audit_log` table: who (actor,
on_behalf_of), what (action, target), when (ts), result (details JSONB). Export
produces a WORM-style artifact (immutable JSON lines) for a date range — the
`audit-export-worm` job ships this to S3 object-lock in prod. In-memory sink is
used when no DATABASE_URL, so tests need no DB.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import datetime, timezone


def _dt(iso: str) -> datetime:
    """Parse an ISO-8601 string to an aware datetime (3.10 rejects a 'Z' suffix)."""
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


@dataclass
class AuditRecord:
    actor: str                    # agent|user|admin|system|scheduler
    action: str                   # tool.call|cron.created|approval.decision|...
    target: str | None = None
    user_id: str | None = None
    org_id: str | None = None
    on_behalf_of: str | None = None
    details: dict = field(default_factory=dict)
    ts: str | None = None

    def normalized(self) -> "AuditRecord":
        if self.ts is None:
            self.ts = datetime.now(timezone.utc).isoformat()
        return self


class AuditSink:
    """Append-only audit writer. Persists to Postgres when a pool is provided."""

    def __init__(self, pool=None) -> None:
        self._pool = pool          # asyncpg pool, or None → memory only
        self.memory: list[AuditRecord] = []

    async def write(self, rec: AuditRecord) -> None:
        rec = rec.normalized()
        self.memory.append(rec)
        if self._pool is not None:
            async with self._pool.acquire() as con:
                await con.execute(
                    """INSERT INTO audit_log(ts, user_id, org_id, actor, action, target, details)
                       VALUES($1, $2, $3, $4, $5, $6, $7::jsonb)""",
                    _dt(rec.ts), rec.user_id, rec.org_id, rec.actor, rec.action, rec.target,
                    json.dumps({**rec.details, "on_behalf_of": rec.on_behalf_of}),
                )

    async def export_worm(self, since: str, until: str) -> list[dict]:
        """Immutable JSON-lines export for a time range (§15.7). Read-only."""
        if self._pool is not None:
            async with self._pool.acquire() as con:
                rows = await con.fetch(
                    "SELECT ts, actor, action, target, user_id, org_id, details "
                    "FROM audit_log WHERE ts >= $1 AND ts < $2 ORDER BY ts, id",
                    _dt(since), _dt(until))
            return [{**dict(r), "details": json.loads(r["details"]) if r["details"] else {}}
                    for r in rows]
        return [
            {"ts": r.ts, "actor": r.actor, "action": r.action, "target": r.target,
             "user_id": r.user_id, "org_id": r.org_id,
             "details": {**r.details, "on_behalf_of": r.on_behalf_of}}
            for r in self.memory if since <= (r.ts or "") < until
        ]


async def ensure_month_partition(pool, when: datetime) -> str:
    """Create the audit_log partition covering `when`'s month if missing (§16.3).

    Partition naming: audit_log_YYYY_MM, range [month_start, next_month_start).
    Idempotent — safe to call before each write / from a monthly job.
    """
    start = when.replace(day=1, hour=0, minute=0, second=0, microsecond=0, tzinfo=timezone.utc)
    nxt = (start.replace(year=start.year + 1, month=1) if start.month == 12
           else start.replace(month=start.month + 1))
    name = f"audit_log_{start:%Y_%m}"
    async with pool.acquire() as con:
        await con.execute(
            f"CREATE TABLE IF NOT EXISTS {name} PARTITION OF audit_log "
            f"FOR VALUES FROM ('{start.isoformat()}') TO ('{nxt.isoformat()}')")
    return name
