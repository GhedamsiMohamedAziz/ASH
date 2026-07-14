"""Memory MCP — memory as an audited tool (instructions.md §9.1.1, §9.1.3).

The agent deliberately decides what to remember (better precision than passive
extraction, which stays as a safety net). Every write goes through AuthZ + audit
like any tool. Hygiene guards (§9.1.3) block, BEFORE anything is stored:
  • secrets/tokens (same DLP as §13.5),
  • third-party facts drawn from read content ("Karim cherche un autre job") —
    the agent that reads mail never stores facts about other people.
`forget` is user self-serve (the §4.4 Mémoires page + user-erasure).
"""

from __future__ import annotations

import re

from .memory import MemoryStore

# Secret shapes (mirror the gateway DLP, §13.5). A hit blocks the memory write.
_SECRET = re.compile(
    r"(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{36}|xox[baprs]-[A-Za-z0-9-]{10,}|"
    r"-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(password|secret|api[_-]?key)\s*[:=]\s*\S+)",
    re.IGNORECASE)

# Third-party-fact heuristic (§9.1.3): a statement about a *named other person*'s
# private situation (job hunting, health, salary...) learned from read content.
_THIRD_PARTY = re.compile(
    r"\b([A-Z][a-z]+)\b.{0,40}\b(cherche un autre job|looking for another job|"
    r"is quitting|va démissionner|is sick|est malade|salaire|salary|"
    r"cherche un nouveau|wants to leave|va partir)\b", re.IGNORECASE)


class MemoryGuardBlocked(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def check_write(content: str) -> None:
    """Raise MemoryGuardBlocked if the content must never be stored (§9.1.3)."""
    if _SECRET.search(content):
        raise MemoryGuardBlocked("secret/token — never stored in memory")
    if _THIRD_PARTY.search(content):
        raise MemoryGuardBlocked("third-party private fact — not stored")


class MemoryMcp:
    """The memory.save/search/update/forget tools (§9.1.1). Audited by the Gateway."""

    def __init__(self, store: MemoryStore) -> None:
        self.store = store
        self.audit: list[dict] = []

    def _log(self, op: str, **kw) -> None:
        # args_hash-style audit (§9.1.1: writes journalized), never the raw secret.
        self.audit.append({"op": op, **kw})

    def save(self, content: str, kind: str, now: float, expires_at: float | None = None) -> dict:
        check_write(content)  # hygiene guards first — fail-closed
        mem = self.store.save(content, kind, now, expires_at=expires_at)
        self._log("save", kind=kind, stored=mem is not None,
                  memory_id=mem.id if mem else None)
        if mem is None:
            return {"stored": False, "reason": "duplicate of an existing memory"}
        return {"stored": True, "memory_id": mem.id}

    def search(self, query: str, now: float, kinds: list[str] | None = None) -> dict:
        hits = self.store.search(query, now, kinds=kinds)
        self._log("search", n=len(hits))
        return {"results": [{"memory_id": m.id, "content": m.content, "kind": m.kind,
                             "score": round(sc, 3)} for m, sc in hits]}

    def update(self, memory_id: str, content: str) -> dict:
        check_write(content)
        m = self.store.update(memory_id, content)
        self._log("update", memory_id=memory_id, found=m is not None)
        return {"updated": m is not None}

    def forget(self, memory_id: str) -> dict:
        ok = self.store.forget(memory_id)
        self._log("forget", memory_id=memory_id, removed=ok)
        return {"forgotten": ok}
