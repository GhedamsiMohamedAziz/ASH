"""Redis-backed TaintLedger (§4.4 "Reste à faire", ADR-012 config-gated seam).

Shares the same Redis instance as the Gateway's RedisTaint (services/mcp-gateway/src/taint.ts) so a
scheduled run's taint flag — set by the Gateway on untrusted ingest (§17.6) — is visible to this
process too when it stamps `source_trust` on a memory write (§9.1.4).

Imported lazily: only reached from main.py's `if REDIS_URL:` branch, so the offline/keyless default
path never needs the `redis` package installed — mirrors pgstore.py's `import asyncpg`, which is
only loaded inside backend-core's `if DATABASE_URL:` branch.
"""

from __future__ import annotations

import redis

# Same TTL as the TASK JWT lifetime (TASK_JWT_TTL, pipeline.py §13.4) — the taint flag naturally
# expires with the task it was set for, rather than living in Redis forever.
DEFAULT_TTL_SECONDS = 900


class RedisTaint:
    """TaintLedger backed by Redis, keyed `taint:{task_id}`.

    Monotone (§17.6.3): `taint` sets the key with NX so an already-tainted task's flag is never
    refreshed or cleared by a later call — first write wins, same as the in-memory Set default.
    """

    def __init__(self, url: str, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> None:
        self._client = redis.Redis.from_url(url)
        self._ttl = ttl_seconds

    def is_tainted(self, task_id: str) -> bool:
        return bool(self._client.exists(_key(task_id)))

    def taint(self, task_id: str) -> None:
        self._client.set(_key(task_id), "1", nx=True, ex=self._ttl)


def _key(task_id: str) -> str:
    return f"taint:{task_id}"
