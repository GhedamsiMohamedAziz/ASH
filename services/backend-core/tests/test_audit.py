"""AX-039 audit persistence + WORM export tests."""

import asyncio
import os

import pytest

from app.audit import AuditRecord, AuditSink


def test_memory_write_and_export():
    sink = AuditSink()

    async def go():
        await sink.write(AuditRecord(actor="agent", action="tool.call", target="github.search",
                                     ts="2026-07-13T09:00:00Z", org_id="org_1"))
        await sink.write(AuditRecord(actor="user", action="approval.decision",
                                     ts="2026-07-13T10:00:00Z", on_behalf_of="usr_mehdi"))
        return await sink.export_worm("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z")

    rows = asyncio.get_event_loop().run_until_complete(go())
    assert len(rows) == 2
    assert rows[0]["action"] == "tool.call"
    assert rows[1]["details"]["on_behalf_of"] == "usr_mehdi"  # both parties captured


def test_export_range_filters():
    sink = AuditSink()

    async def go():
        await sink.write(AuditRecord(actor="a", action="x", ts="2026-07-10T00:00:00Z"))
        await sink.write(AuditRecord(actor="a", action="y", ts="2026-07-13T00:00:00Z"))
        return await sink.export_worm("2026-07-12T00:00:00Z", "2026-07-14T00:00:00Z")

    rows = asyncio.get_event_loop().run_until_complete(go())
    assert [r["action"] for r in rows] == ["y"]  # only the in-range record


def test_ts_autofilled_when_absent():
    sink = AuditSink()
    asyncio.get_event_loop().run_until_complete(
        sink.write(AuditRecord(actor="system", action="cron.run")))
    assert sink.memory[0].ts is not None


@pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="requires DATABASE_URL")
def test_persist_and_export_live_postgres():
    import asyncpg
    from datetime import datetime, timezone
    from app.audit import ensure_month_partition

    dsn = os.environ["DATABASE_URL"]

    async def go():
        pool = await asyncpg.create_pool(dsn, min_size=1, max_size=2)
        sink = AuditSink(pool)
        await ensure_month_partition(pool, datetime(2026, 7, 13, tzinfo=timezone.utc))
        await sink.write(AuditRecord(actor="agent", action="tool.call",
                                     target="github.merge_pr", org_id="org_1",
                                     on_behalf_of="usr_x", ts="2026-07-13T12:00:00Z"))
        rows = await sink.export_worm("2026-07-13T00:00:00Z", "2026-07-14T00:00:00Z")
        await pool.close()
        return rows

    rows = asyncio.get_event_loop().run_until_complete(go())
    assert any(r["action"] == "tool.call" and r["target"] == "github.merge_pr" for r in rows)
