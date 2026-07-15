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
from typing import Protocol

from .memory import MemoryStore


class TaintLedger(Protocol):
    """Per-task taint flag (§17.6.3). The Gateway sets it (TS side) when a turn ingests untrusted
    content; the memory writer reads it here to stamp source_trust. In prod both point at the
    same Redis; the in-memory default keeps the offline path keyless (mirrors the RunsStore seam)."""

    def is_tainted(self, task_id: str) -> bool: ...


class InMemoryTaint:
    """Default TaintLedger — a set. Injected shared-Redis-backed in prod."""

    def __init__(self) -> None:
        self._t: set[str] = set()

    def is_tainted(self, task_id: str) -> bool:
        return task_id in self._t

    def taint(self, task_id: str) -> None:
        self._t.add(task_id)  # monotonic: never clears (§17.6.3)

# Secret shapes (mirror the gateway DLP, §13.5 — same shape set as dlp.ts). A hit
# blocks the memory write. Kept aligned to the gateway list; the gateway is not edited.
_SECRET = re.compile(
    r"(AKIA[0-9A-Z]{16}"
    r"|gh[posur]_[A-Za-z0-9]{36,}"                      # ghp_/gho_/ghs_/ghu_/ghr_
    r"|github_pat_[A-Za-z0-9_]{22,}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}"                    # Slack
    r"|sk-ant-[A-Za-z0-9_-]{20,}"                       # Anthropic
    r"|sk-proj-[A-Za-z0-9_-]{20,}"                      # OpenAI project key (proj breaks the sk- rule)
    r"|sk-[A-Za-z0-9]{20,}"                             # OpenAI
    r"|(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{10,}"        # Stripe secret/restricted keys (underscore form)
    r"|glpat-[A-Za-z0-9_-]{20,}"                        # GitLab PAT
    r"|AIza[0-9A-Za-z_-]{35,}"                          # Google API key
    r"|ya29\.[A-Za-z0-9_-]{20,}"                        # Google OAuth access token
    r"|eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+"  # JWT (3-segment)
    r"|[a-z][a-z0-9+.-]*://[^/\s:@]+:[^/\s:@]+@"        # user:pass@host URL creds
    r"|-----BEGIN [A-Z ]*PRIVATE KEY-----"
    # Label rule: broadened + no leading \b so underscored labels (AWS_SECRET_ACCESS_KEY=...) hit too.
    r"|(?:password|secret|api[_-]?key|access[_-]?key)\w*\s*[:=]\s*\S+)",
    re.IGNORECASE)

# Third-party-fact heuristic (§9.1.3): a statement about *another person*'s private
# situation (job hunting, health, salary, layoff, bonus...) learned from read content.
# The sensitive predicate is necessary but NOT sufficient: a bare predicate about
# ONESELF ("I'm dealing with burnout", "Track my salary review date") is a legitimate
# self-referential memory and must pass. So a predicate blocks only when it carries a
# third-party SUBJECT (a role noun like "collègue") OR when no first-person marker is
# present at all (bare "cherche un autre job dès que possible", or a named subject
# "Karim …" / "David's salary …" which never carries a first-person marker).
_THIRD_PARTY_PREDICATE = re.compile(
    r"(cherche un autre job|cherche un nouveau|looking for another job|wants to leave|"
    r"is quitting|is sick|va démissionner|va partir|est malade|"
    r"salaire|salary|touche une prime|"
    r"burnout|dépression|depression|être licencié|licenciement)",
    re.IGNORECASE)

# An explicit other-person subject — forces a block even when a first-person possessive
# is nearby ("mon collègue est en burnout": "mon" is first-person but "collègue" is not).
_THIRD_PARTY_SUBJECT = re.compile(
    r"\b(coll[èe]gues?|colleagues?|co-?workers?|managers?|boss|patron|voisins?)\b",
    re.IGNORECASE)

# First-person markers (EN + FR): a bare sensitive predicate about oneself must not block.
_FIRST_PERSON = re.compile(r"\b(I|I'm|my|me|mon|ma|mes|je|j')\b", re.IGNORECASE)


def _is_third_party_private(content: str) -> bool:
    if not _THIRD_PARTY_PREDICATE.search(content):
        return False
    if _THIRD_PARTY_SUBJECT.search(content):
        return True  # explicit other-person subject → third-party fact
    # No explicit other-person subject: block unless it is clearly about oneself.
    return _FIRST_PERSON.search(content) is None


class MemoryGuardBlocked(Exception):
    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def check_write(content: str) -> None:
    """Raise MemoryGuardBlocked if the content must never be stored (§9.1.3)."""
    if _SECRET.search(content):
        raise MemoryGuardBlocked("secret/token — never stored in memory")
    if _is_third_party_private(content):
        raise MemoryGuardBlocked("third-party private fact — not stored")


class MemoryMcp:
    """The memory.save/search/update/forget tools (§9.1.1). Audited by the Gateway."""

    def __init__(self, store: MemoryStore, taint: TaintLedger | None = None) -> None:
        self.store = store
        self.taint = taint or InMemoryTaint()
        self.audit: list[dict] = []

    def _log(self, op: str, **kw) -> None:
        # args_hash-style audit (§9.1.1: writes journalized), never the raw secret.
        self.audit.append({"op": op, **kw})

    def save(self, content: str, kind: str, now: float, expires_at: float | None = None,
             task_id: str | None = None) -> dict:
        check_write(content)  # hygiene guards first — fail-closed
        # Invariant #9 (§9.1.4): a contaminated turn produces ONLY untrusted memory. The taint is
        # derived from the task's flag, never inferred from the content — detection isn't a boundary.
        source_trust = "untrusted" if (task_id and self.taint.is_tainted(task_id)) else "trusted"
        mem = self.store.save(content, kind, now, expires_at=expires_at, source_trust=source_trust)
        self._log("save", kind=kind, stored=mem is not None,
                  memory_id=mem.id if mem else None, source_trust=source_trust)
        if mem is None:
            return {"stored": False, "reason": "duplicate of an existing memory"}
        return {"stored": True, "memory_id": mem.id, "source_trust": source_trust}

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
