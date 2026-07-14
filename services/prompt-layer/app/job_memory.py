"""Per-job memory between runs (instructions.md §9.1, §15). scheduled_jobs.job_memory
JSONB. Lets a cron dedup alerts it already reported and mark intelligent no_op runs
so delivery can suppress noise (§15.5)."""
from __future__ import annotations
from dataclasses import dataclass, field

@dataclass
class JobMemory:
    seen_keys: set = field(default_factory=set)   # dedup already-reported items
    last_no_op: bool = False

    def is_new(self, key: str) -> bool:
        """True the first time a key is seen (e.g. a Sentry issue id); dedups after."""
        if key in self.seen_keys:
            return False
        self.seen_keys.add(key)
        return True

    def mark_no_op(self, no_op: bool) -> None:
        self.last_no_op = no_op

    def to_json(self) -> dict:
        return {"seen_keys": sorted(self.seen_keys), "last_no_op": self.last_no_op}

    @classmethod
    def from_json(cls, d: dict) -> "JobMemory":
        return cls(seen_keys=set(d.get("seen_keys", [])), last_no_op=bool(d.get("last_no_op", False)))
