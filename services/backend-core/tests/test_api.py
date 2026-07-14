"""End-to-end tests for backend-core: REST contract + WS streaming/replay."""

import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app, store


@pytest.fixture(autouse=True)
def _reset():
    store.conversations.clear()
    store.idempotency.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


def test_health_and_me(client):
    assert client.get("/healthz").json() == {"status": "ok"}
    assert client.get("/api/v1/me").json()["user_id"] == "usr_dev"


def test_create_and_list_conversation(client):
    r = client.post("/api/v1/conversations", json={"channel": "web", "title": "T"})
    assert r.status_code == 201
    conv = r.json()
    assert conv["id"].startswith("conv_")
    listed = client.get("/api/v1/conversations").json()
    assert any(c["id"] == conv["id"] for c in listed["items"])


def test_send_message_requires_idempotency_key(client):
    conv = client.post("/api/v1/conversations", json={}).json()
    r = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"text": "hi"})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "E_IDEMPOTENCY_KEY_REQUIRED"


def test_send_message_is_idempotent(client):
    conv = client.post("/api/v1/conversations", json={}).json()
    key = str(uuid.uuid4())
    h = {"Idempotency-Key": key}
    r1 = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"text": "hi"}, headers=h)
    r2 = client.post(f"/api/v1/conversations/{conv['id']}/messages", json={"text": "hi"}, headers=h)
    assert r1.status_code == r2.status_code == 202
    assert r1.json()["message_id"] == r2.json()["message_id"]  # same result, no dup


def test_send_message_unknown_conversation(client):
    r = client.post(
        "/api/v1/conversations/conv_nope/messages",
        json={"text": "hi"},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_CONV_NOT_FOUND"


def test_stream_delivers_ordered_events_ending_in_done(client):
    conv = client.post("/api/v1/conversations", json={}).json()
    with client.websocket_connect(f"/api/v1/conversations/{conv['id']}/stream") as ws:
        ws.send_json({"type": "subscribe", "last_seq": 0})
        client.post(
            f"/api/v1/conversations/{conv['id']}/messages",
            json={"text": "bonjour"},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        seqs, types = [], []
        while True:
            ev = ws.receive_json()
            seqs.append(ev["seq"])
            types.append(ev["type"])
            if ev["type"] == "agent.done":
                break
    assert seqs == sorted(seqs) and len(seqs) == len(set(seqs))  # monotonic, no dup
    assert types[0] == "agent.thinking"
    assert "agent.text.delta" in types
    assert types[-1] == "agent.done"


def test_stream_replays_missed_events_on_resume(client):
    """A late subscriber with last_seq=0 still gets the full turn from the log (§8.3)."""
    conv = client.post("/api/v1/conversations", json={}).json()
    client.post(
        f"/api/v1/conversations/{conv['id']}/messages",
        json={"text": "salut"},
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    # Connect AFTER the turn has run — replay must still deliver agent.done.
    with client.websocket_connect(f"/api/v1/conversations/{conv['id']}/stream") as ws:
        ws.send_json({"type": "subscribe", "last_seq": 0})
        got_done = False
        for _ in range(50):
            ev = ws.receive_json()
            if ev["type"] == "agent.done":
                got_done = True
                break
    assert got_done


def test_assistant_message_persisted(client):
    conv = client.post("/api/v1/conversations", json={}).json()
    with client.websocket_connect(f"/api/v1/conversations/{conv['id']}/stream") as ws:
        ws.send_json({"type": "subscribe", "last_seq": 0})
        client.post(
            f"/api/v1/conversations/{conv['id']}/messages",
            json={"text": "ping"},
            headers={"Idempotency-Key": str(uuid.uuid4())},
        )
        while ws.receive_json()["type"] != "agent.done":
            pass
    msgs = client.get(f"/api/v1/conversations/{conv['id']}/messages").json()["items"]
    roles = [m["role"] for m in msgs]
    assert "user" in roles and "assistant" in roles
