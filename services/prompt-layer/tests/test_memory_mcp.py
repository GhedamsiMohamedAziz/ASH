"""AX-044 Memory MCP tests (§9.1.1, §9.1.3 hygiene guards)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.memory import MemoryStore  # noqa: E402
from app.memory_mcp import MemoryGuardBlocked, MemoryMcp, check_write  # noqa: E402


def _mcp():
    return MemoryMcp(MemoryStore(recall_threshold=0.30))


# ---------------------------------------------------------------- tools (§9.1.1)
def test_save_search_roundtrip():
    m = _mcp()
    r = m.save("we deploy with ArgoCD after CI", "procedure", now=0)
    assert r["stored"] and r["memory_id"]
    res = m.search("how do we deploy?", now=0)
    assert any("ArgoCD" in h["content"] for h in res["results"])


def test_save_dedup_reported():
    m = _mcp()
    m.save("on-call rotates weekly", "fact", now=0)
    r = m.save("on-call rotates weekly", "fact", now=1)
    assert r["stored"] is False and "duplicate" in r["reason"]


def test_update_and_forget():
    m = _mcp()
    mid = m.save("prefers dark mode", "preference", now=0)["memory_id"]
    assert m.update(mid, "prefers light mode")["updated"]
    assert m.forget(mid)["forgotten"]


def test_writes_are_audited():
    m = _mcp()
    m.save("we use trunk-based development", "fact", now=0)
    m.search("branching", now=0)
    ops = [a["op"] for a in m.audit]
    assert "save" in ops and "search" in ops


# ---------------------------------------------------------------- hygiene guards (§9.1.3)
def test_secret_is_never_stored():
    with pytest.raises(MemoryGuardBlocked):
        check_write("the deploy token is ghp_" + "a" * 36)
    m = _mcp()
    with pytest.raises(MemoryGuardBlocked):
        m.save("aws key AKIA" + "A" * 16, "fact", now=0)
    assert m.store.all() == []  # nothing stored


def test_third_party_private_fact_blocked():
    with pytest.raises(MemoryGuardBlocked):
        check_write("Karim cherche un autre job d'après son mail")
    with pytest.raises(MemoryGuardBlocked):
        check_write("Sarah is looking for another job")


def test_ordinary_facts_pass_the_guard():
    # A normal team fact is fine — only secrets + third-party-private are blocked.
    check_write("the team uses Slack for standups")
    check_write("deployment is gated on green CI")
