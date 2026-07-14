"""Idempotency-key store (instructions.md §21, Principle #8).

Every write carries an Idempotency-Key; a retry must never produce a duplicate.
Prod backs this with Redis (24h TTL, §16.2); this module defines the interface
and a process-local implementation for dev/tests.
"""

from __future__ import annotations

import time
from typing import Any, Protocol


class IdempotencyStore(Protocol):
    def remember(self, key: str, value: Any, ttl: float = 86400) -> bool: ...
    def get(self, key: str) -> Any | None: ...
    def seen(self, key: str) -> bool: ...


class InMemoryStore:
    """Process-local store with TTL. Not shared across replicas (dev only)."""

    def __init__(self) -> None:
        self._data: dict[str, tuple[float, Any]] = {}

    def _purge(self, now: float) -> None:
        expired = [k for k, (exp, _) in self._data.items() if exp <= now]
        for k in expired:
            del self._data[k]

    def remember(self, key: str, value: Any, ttl: float = 86400) -> bool:
        """Store value for key if absent. Returns True if newly stored, False if it existed."""
        now = time.time()
        self._purge(now)
        if key in self._data:
            return False
        self._data[key] = (now + ttl, value)
        return True

    def get(self, key: str) -> Any | None:
        now = time.time()
        entry = self._data.get(key)
        if entry is None:
            return None
        exp, value = entry
        if exp <= now:
            del self._data[key]
            return None
        return value

    def seen(self, key: str) -> bool:
        return self.get(key) is not None

    def clear(self) -> None:
        self._data.clear()
