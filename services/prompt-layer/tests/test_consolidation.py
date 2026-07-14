"""AX-065 internal jobs — memory consolidation tests (§9.1.3, §15.7)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.consolidation import INTERNAL_JOBS, consolidate_memory  # noqa: E402
from app.memory import Memory, MemoryStore, embed  # noqa: E402

DAY = 86400.0


def test_internal_job_registry_has_the_platform_jobs():
    assert "memory-consolidation" in INTERNAL_JOBS
    assert INTERNAL_JOBS["user-erasure"] == "on-demand"
    assert INTERNAL_JOBS["memory-consolidation"] == "0 4 * * 0"  # weekly


def test_expired_memories_purged():
    s = MemoryStore()
    s.save("temporary note", "fact", now=0, expires_at=100)
    s.save("durable note", "fact", now=0)
    r = consolidate_memory(s, now=200)
    assert r.expired == 1
    assert len(s.all()) == 1


def test_never_reused_old_memory_decays():
    s = MemoryStore()
    s.save("stale unused fact", "fact", now=0)  # use_count 0, created at t0
    s.save("fresh fact", "fact", now=100 * DAY)
    r = consolidate_memory(s, now=100 * DAY, decay_after_days=90)
    assert r.decayed == 1
    assert all("stale" not in m.content for m in s.all())


def test_corrections_are_not_decayed():
    s = MemoryStore()
    s.save("never merge on friday", "correction", now=0)  # old + unused but a correction
    r = consolidate_memory(s, now=200 * DAY, decay_after_days=90)
    assert r.decayed == 0
    assert len(s.all()) == 1


def test_reused_memory_survives():
    s = MemoryStore()
    m = s.save("frequently used fact", "fact", now=0)
    m.use_count = 5
    r = consolidate_memory(s, now=200 * DAY, decay_after_days=90)
    assert r.decayed == 0


def test_near_duplicates_merged():
    s = MemoryStore()
    # inject two near-identical memories directly (bypass save-time dedup)
    e = embed("deploy with argocd after ci passes")
    s._items = [
        Memory("m1", "deploy with argocd after ci passes", "fact", e, created_at=0, use_count=1),
        Memory("m2", "deploy with argocd after ci passes", "fact", e, created_at=0, use_count=2),
    ]
    r = consolidate_memory(s, now=0)
    assert r.merged == 1
    assert len(s.all()) == 1
    assert s.all()[0].use_count == 3  # usage folded into the survivor
