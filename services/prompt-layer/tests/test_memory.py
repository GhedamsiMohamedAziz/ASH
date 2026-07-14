"""AX-042/043/047 memory tests (§9.1): working memory, dedup, hybrid ranking."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.memory import MemoryStore, WorkingMemory, cosine, embed  # noqa: E402


# ---------------------------------------------------------------- embeddings
def test_embed_similar_texts_have_high_cosine():
    a = embed("deploy the login fix to staging")
    b = embed("deploy login fix to staging please")
    c = embed("what is the weather today")
    assert cosine(a, b) > cosine(a, c)
    assert 0.99 < cosine(a, a) < 1.0001  # unit vector (float tolerance)


# The deterministic test embedder has a compressed cosine range vs a real model;
# ranking tests use a threshold matched to it (prod default is 0.55, §9.1).
def _store(**kw):
    return MemoryStore(recall_threshold=0.30, **kw)


# ---------------------------------------------------------------- working memory (type 1)
def test_working_memory_window_trims():
    wm = WorkingMemory(window=3, summary_every=100)
    for i in range(5):
        wm.add_turn(f"turn {i}")
    assert list(wm.turns) == ["turn 2", "turn 3", "turn 4"]  # last 3 only


def test_working_memory_summary_trigger():
    wm = WorkingMemory(window=30, summary_every=3)
    assert wm.add_turn("a") is False
    assert wm.add_turn("b") is False
    assert wm.add_turn("c") is True   # every 3rd turn → summary due
    assert wm.add_turn("d") is False  # counter reset


# ---------------------------------------------------------------- dedup (type 2)
def test_save_dedups_near_duplicates():
    s = MemoryStore()
    m1 = s.save("the deploy command is make deploy", "procedure", now=0)
    assert m1 is not None
    dup = s.save("the deploy command is make deploy", "procedure", now=1)
    assert dup is None                       # exact dup rejected
    assert len(s.all()) == 1
    assert s.all()[0].use_count == 1         # existing one reinforced


def test_distinct_facts_both_saved():
    s = MemoryStore()
    assert s.save("we deploy via ArgoCD", "fact", now=0) is not None
    assert s.save("our on-call rotates weekly", "fact", now=0) is not None
    assert len(s.all()) == 2


# ---------------------------------------------------------------- hybrid ranking (§9.1)
def test_search_returns_relevant_above_threshold():
    s = _store()
    s.save("deployment uses ArgoCD after CI passes", "fact", now=0)
    s.save("the cafeteria menu changes on Fridays", "fact", now=0)
    res = s.search("how do we deploy?", now=0)
    assert res
    assert "ArgoCD" in res[0][0].content  # most relevant first


def test_correction_gets_ranking_bonus():
    s = _store()
    s.save("never merge PRs on Friday", "correction", now=0)
    s.save("never merge PRs on Friday afternoon", "fact", now=0)
    res = s.search("friday merge policy", now=0)
    # the correction should outrank the plain fact of similar relevance
    assert res[0][0].kind == "correction"


def test_recency_decay_ranks_newer_higher():
    s = _store()
    old = s.save("staging api endpoint version one", "fact", now=0)
    new = s.save("production api endpoint upgraded recently", "fact", now=60 * 86400)  # 60d later
    assert old is not None and new is not None  # distinct enough to both save
    res = s.search("api endpoint", now=60 * 86400)
    ids = [m.id for m, _ in res]
    assert ids.index(new.id) < ids.index(old.id)  # newer ranks first


def test_expired_memory_purged_on_search():
    s = MemoryStore()
    s.save("on vacation until Aug 15", "fact", now=0, expires_at=100)
    assert len(s.all()) == 1
    res = s.search("vacation", now=200)  # past expiry
    assert res == []
    assert len(s.all()) == 0  # purged


# ---------------------------------------------------------------- update/forget (§9.1.1)
def test_update_and_forget():
    s = MemoryStore()
    m = s.save("prefers dark mode", "preference", now=0)
    assert s.update(m.id, "prefers light mode").content == "prefers light mode"
    assert s.forget(m.id) is True
    assert s.all() == []
