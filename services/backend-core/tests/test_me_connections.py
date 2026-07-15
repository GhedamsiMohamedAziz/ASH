"""Tests for GET /me connection status and GET /memories prompt-layer proxy."""

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app, store


@pytest.fixture(autouse=True)
def _reset():
    store.conversations.clear()
    store.idempotency.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


def test_me_lists_all_providers_disconnected(client):
    body = client.get("/api/v1/me").json()
    assert body["user_id"] == "usr_dev"
    conns = body["connections"]
    providers = {c["provider"] for c in conns}
    assert providers == {"github", "m365", "slack", "notion", "database"}
    # No OAuth tokens exist yet — every provider is honestly connected:False.
    assert all(c["connected"] is False for c in conns)
    # Each entry carries a human label for the web panel.
    assert all(c["label"] for c in conns)


def test_memories_empty_when_prompt_layer_unset(client, monkeypatch):
    monkeypatch.setattr(main, "PROMPT_LAYER_URL", None)
    assert client.get("/api/v1/memories").json() == {"memories": []}


def test_memories_empty_when_prompt_layer_down(client, monkeypatch):
    # PROMPT_LAYER_URL points at a host that is not listening → graceful empty list,
    # keeping make test-all offline + keyless.
    monkeypatch.setattr(main, "PROMPT_LAYER_URL", "http://127.0.0.1:1/")
    assert client.get("/api/v1/memories").json() == {"memories": []}
