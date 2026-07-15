"""AX-044 Memory MCP tests (§9.1.1, §9.1.3 hygiene guards)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.memory import MemoryStore  # noqa: E402
from app.memory_mcp import InMemoryTaint, MemoryGuardBlocked, MemoryMcp, check_write  # noqa: E402


def _mcp(taint=None):
    return MemoryMcp(MemoryStore(recall_threshold=0.30), taint=taint)


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


@pytest.mark.parametrize("secret", [
    "remember gho_" + "a" * 36,                                   # GitHub OAuth token
    "anthropic key sk-ant-api03-" + "a" * 40,                     # Anthropic
    "openai key sk-" + "a" * 48,                                  # OpenAI
    "token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dozjgNryP4J3", # JWT (3-segment)
    "gitlab token glpat-abcdefghij1234567890",                    # GitLab PAT
    "google api key AIzaSyD-1234567890abcdefghijklmnopqrstuv",    # Google API key
    "connect to https://admin:hunter2@internal.example.com/db",   # user:pass@host URL creds
])
def test_new_secret_shapes_blocked(secret):
    with pytest.raises(MemoryGuardBlocked):
        check_write(secret)


@pytest.mark.parametrize("tp", [
    "Éric cherche un autre job",              # accented name
    "Léa va partir en fin d'année",
    "mon collègue cherche un autre job",      # leading word is not a proper noun
    "cherche un autre job dès que possible",  # no subject at all — predicate stands alone
    "Y est en burnout",
    "Z va être licencié",
    "Karim est en dépression",
    "Sophie touche une prime de 10k",
])
def test_extended_third_party_predicates_blocked(tp):
    with pytest.raises(MemoryGuardBlocked):
        check_write(tp)


def test_ordinary_facts_pass_the_guard():
    # A normal team fact is fine — only secrets + third-party-private are blocked.
    check_write("the team uses Slack for standups")
    check_write("deployment is gated on green CI")


def test_name_without_sensitive_predicate_passes():
    # The IGNORECASE fix: a proper noun alone no longer fires — only the private
    # predicate does. Legitimate self-referential / benign memories must pass.
    check_write("Marie is a great colleague")
    check_write("Tom presented the roadmap today")
    check_write("our api key rotation policy is quarterly")
    check_write("I keep my token in a password manager")


# ---------------------------------------------------------------- source_trust (§9.1.4, invariant #9)
def test_untainted_save_is_trusted():
    m = _mcp()
    r = m.save("we deploy with ArgoCD", "fact", now=0, task_id="task_clean")
    assert r["source_trust"] == "trusted"
    assert m.store._items[-1].source_trust == "trusted"


def test_tainted_turn_writes_only_untrusted():
    taint = InMemoryTaint()
    taint.taint("task_dirty")                       # the Gateway would set this on untrusted ingest
    m = _mcp(taint)
    r = m.save("the repo README claims X", "fact", now=0, task_id="task_dirty")
    assert r["stored"] and r["source_trust"] == "untrusted"
    assert m.store._items[-1].source_trust == "untrusted"


def test_no_task_id_defaults_trusted():
    m = _mcp(InMemoryTaint())
    r = m.save("a plain user preference", "preference", now=0)  # no task context
    assert r["source_trust"] == "trusted"


def test_audit_records_source_trust():
    taint = InMemoryTaint(); taint.taint("t")
    m = _mcp(taint)
    m.save("something read from an untrusted page", "fact", now=0, task_id="t")
    assert m.audit[-1]["source_trust"] == "untrusted"


def test_trusted_confirmation_promotes_a_duplicate_but_untrusted_never_demotes():
    taint = InMemoryTaint(); taint.taint("dirty")
    m = _mcp(taint)
    m.save("deploy uses ArgoCD", "fact", now=0, task_id="dirty")       # untrusted first
    assert m.store._items[-1].source_trust == "untrusted"
    m.save("deploy uses ArgoCD", "fact", now=1, task_id="task_clean")  # trusted dup → promote
    assert m.store._items[-1].source_trust == "trusted"
