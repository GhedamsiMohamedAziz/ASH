"""Internal platform jobs — memory consolidation (instructions.md §9.1.3, §15.7).

The weekly `memory-consolidation` job keeps long-term memory as signal, not noise:
merge near-duplicates, decay memories never reused, purge expired. Without it,
memory becomes noise in ~6 months (§9.1.3). Other internal jobs (usage-rollup,
audit-export-worm, partition-roll, sandbox-reaper) are declared here as the
registry the scheduler runs; consolidation carries the substantive testable logic.
"""

from __future__ import annotations

from dataclasses import dataclass

from .memory import MemoryStore, cosine

# The declarative internal-job registry (§15.7). Cron + role; run by automation-service.
INTERNAL_JOBS = {
    "memory-consolidation": "0 4 * * 0",   # weekly
    "usage-rollup": "10 0 * * *",           # daily billing aggregate
    "oauth-refresh-sweep": "0 */6 * * *",   # every 6h
    "audit-export-worm": "0 1 * * *",       # daily WORM export
    "sandbox-reaper": "*/30 * * * *",       # idle hibernation
    "partition-roll": "0 2 1 * *",          # monthly audit_log partition
    "user-erasure": "on-demand",            # RGPD (§15.7)
}


@dataclass
class ConsolidationResult:
    merged: int
    decayed: int
    expired: int


def consolidate_memory(store: MemoryStore, now: float, *,
                       decay_after_days: float = 90.0,
                       merge_threshold: float = 0.95) -> ConsolidationResult:
    """Run the weekly consolidation on a user's memory store (§9.1.3)."""
    items = store.all()
    merged = decayed = 0

    # 1. expire — search() already purges expired; count them here explicitly.
    before = len(items)
    store._items = [m for m in items if m.expires_at is None or m.expires_at > now]  # type: ignore[attr-defined]
    expired = before - len(store._items)  # type: ignore[attr-defined]

    # 2. merge near-duplicates that slipped past save-time dedup (e.g. after edits).
    kept: list = []
    for m in store._items:  # type: ignore[attr-defined]
        dup = next((k for k in kept if cosine(m.embedding, k.embedding) > merge_threshold), None)
        if dup is not None:
            dup.use_count += m.use_count  # fold usage into the survivor
            merged += 1
        else:
            kept.append(m)
    store._items = kept  # type: ignore[attr-defined]

    # 3. decay — drop old memories that were never reused (use_count == 0), except
    #    corrections (weighted, kept longer, §9.1).
    survivors = []
    for m in store._items:  # type: ignore[attr-defined]
        age_days = (now - m.created_at) / 86400.0
        if m.use_count == 0 and age_days > decay_after_days and m.kind != "correction":
            decayed += 1
        else:
            survivors.append(m)
    store._items = survivors  # type: ignore[attr-defined]

    return ConsolidationResult(merged=merged, decayed=decayed, expired=expired)
