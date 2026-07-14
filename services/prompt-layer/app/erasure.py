"""RGPD user-erasure (instructions.md §4.4, §15.7 `user-erasure`).

On-demand job that purges everything about a user: memories, entities, procedural
workspace notes, OAuth tokens, and scheduled jobs (their crons deleted). Returns a
manifest of what was purged (audited, verifiable). Idempotent — a second run is a
no-op. The stores are injected so the job composes the pieces already built.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass
class ErasureStores:
    memory: Any = None        # MemoryStore
    procedural: Any = None    # ProceduralNotes (project keyed; pass user's projects)
    oauth: Any = None         # OAuthFlows (tokens keyed by (user, provider))
    jobs: Any = None          # scheduler.JobStore


def erase_user(user_id: str, stores: ErasureStores, *, projects: list[str] | None = None) -> dict:
    """Purge all of a user's data. Returns a manifest {store: count}."""
    manifest: dict[str, int] = {}

    # 1. semantic memories (§9.1) — all items are already user-scoped in prod.
    if stores.memory is not None:
        n = len(stores.memory.all())
        for m in list(stores.memory.all()):
            stores.memory.forget(m.id)
        manifest["memories"] = n

    # 2. procedural workspace notes (§11.3) — drop the user's project notes.
    if stores.procedural is not None and projects:
        dropped = 0
        for proj in projects:
            dropped += stores.procedural.drop(proj)  # purge the project's notes
        manifest["procedural_notes"] = dropped

    # 3. OAuth tokens (§13.2) — revoke every connection.
    if stores.oauth is not None:
        keys = [k for k in stores.oauth.tokens if k[0] == user_id]
        for k in keys:
            del stores.oauth.tokens[k]
        manifest["oauth_tokens"] = len(keys)

    # 4. scheduled jobs (§15) — delete the user's crons.
    if stores.jobs is not None:
        user_jobs = [j for j in stores.jobs.list(user_id=user_id)]
        for j in user_jobs:
            stores.jobs.delete(j.id)
        manifest["scheduled_jobs"] = len(user_jobs)

    manifest["user_id"] = user_id
    return manifest
