"""prompt-layer memory API (§9.1) — internal list/save over the shared MemoryMcp.

Backs the §4.4 Mémoires page: backend-core proxies /internal/memory/list, and a
deliberate write lands via /internal/memory/save. Offline + keyless (deterministic embedder).
"""

import sys
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402

client = TestClient(app)


def test_list_returns_the_seeded_memories_including_one_untrusted():
    r = client.get("/internal/memory/list")
    assert r.status_code == 200
    memories = r.json()["memories"]
    contents = {m["content"] for m in memories}
    assert "on déploie via ArgoCD après CI" in contents
    assert "jamais de merge le vendredi" in contents
    assert "les PR passent par une review" in contents
    # every row carries the shared contract fields
    for m in memories:
        assert set(m) == {"id", "content", "kind", "source_trust"}
    # the seed written under a tainted task is stamped untrusted (§9.1.4)
    trusts = {m["content"]: m["source_trust"] for m in memories}
    assert trusts["les PR passent par une review"] == "untrusted"
    assert trusts["on déploie via ArgoCD après CI"] == "trusted"


def test_save_adds_a_memory():
    before = len(client.get("/internal/memory/list").json()["memories"])
    r = client.post("/internal/memory/save",
                    json={"content": "les incidents sont postmortem sous 48h",
                          "kind": "procedure"})
    assert r.status_code == 200
    body = r.json()
    assert body["stored"] is True
    assert body["memory_id"]
    assert body["source_trust"] == "trusted"
    listing = client.get("/internal/memory/list").json()["memories"]
    assert len(listing) == before + 1
    assert any(m["content"] == "les incidents sont postmortem sous 48h" for m in listing)
