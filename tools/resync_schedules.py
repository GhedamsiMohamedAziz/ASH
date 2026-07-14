#!/usr/bin/env python3
"""Resync Trigger.dev schedules from scheduled_jobs (AX-086, instructions.md §23).

scheduled_jobs is OUR source of truth (§16.2); after a Trigger.dev datastore loss,
this rebuilds every active schedule idempotently via a deduplicationKey
(job_id) — re-running never creates duplicates. The DR guarantee: no run lost,
no run duplicated. The Trigger.dev client is injected so it's testable offline.
"""
from __future__ import annotations
from dataclasses import dataclass, field

@dataclass
class ScheduleClient:
    """Stand-in for @trigger.dev/sdk schedules API. dedup by deduplicationKey."""
    _schedules: dict = field(default_factory=dict)  # dedup_key -> spec
    def upsert(self, dedup_key: str, cron: str, timezone: str) -> str:
        created = dedup_key not in self._schedules
        self._schedules[dedup_key] = {"cron": cron, "tz": timezone}
        return "created" if created else "updated"

def resync(active_jobs: list[dict], client: ScheduleClient) -> dict:
    """Rebuild schedules for active jobs. Idempotent (dedup by job_id)."""
    summary = {"created": 0, "updated": 0}
    for j in active_jobs:
        if j["status"] != "active":
            continue
        action = client.upsert(j["id"], j["cron"], j.get("timezone", "UTC"))
        summary[action] += 1
    return summary
