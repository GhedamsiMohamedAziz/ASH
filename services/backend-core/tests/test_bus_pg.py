"""AX-012 tests: bus decoupling + optional Postgres persistence.

The Postgres test only runs when DATABASE_URL is set (CI/local with the compose
db up); otherwise it is skipped so the default suite needs no external infra.
"""

import os
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app, store
from app import bus as busmod


@pytest.fixture(autouse=True)
def _reset():
    store.conversations.clear()
    store.idempotency.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


def test_post_publishes_inbound_to_bus(client, monkeypatch):
    """POST /messages must publish an InboundMessage on `inbound.messages` (§8.2)."""
    seen = []

    async def spy(msg):
        seen.append(msg)

    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        conv = client.post("/api/v1/conversations", json={}).json()
        client.post(f"/api/v1/conversations/{conv['id']}/messages",
                    json={"text": "hi"}, headers={"Idempotency-Key": str(uuid.uuid4())})
    finally:
        unsub()
    assert seen, "no InboundMessage published to the bus"
    published = seen[-1]
    assert published.subject == "inbound.messages"
    assert published.data["conversation_id"] == conv["id"]
    assert published.data["text"] == "hi"


def test_bus_dedupe_guard_drops_repeats():
    """At-least-once delivery is deduped by message_id (§21)."""
    from olma_shared.bus import DedupeGuard
    g = DedupeGuard()
    assert g.is_duplicate("job:2026") is False
    assert g.is_duplicate("job:2026") is True


@pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="requires DATABASE_URL (live Postgres)")
def test_messages_persist_to_postgres():
    """With DATABASE_URL set, conversations + messages land in Postgres rows (§16.1)."""
    import asyncpg
    import asyncio

    # Use the lifespan so PgStore connects and seeds the dev user.
    with TestClient(app) as c:
        conv = c.post("/api/v1/conversations", json={"title": "pg"}).json()
        cid = conv["id"]
        with c.websocket_connect(f"/api/v1/conversations/{cid}/stream") as ws:
            ws.send_json({"type": "subscribe", "last_seq": 0})
            c.post(f"/api/v1/conversations/{cid}/messages",
                   json={"text": "persist me"}, headers={"Idempotency-Key": str(uuid.uuid4())})
            while ws.receive_json()["type"] != "agent.done":
                pass

        async def check():
            con = await asyncpg.connect(os.environ["DATABASE_URL"])
            try:
                crow = await con.fetchrow("SELECT id,title FROM conversations WHERE id=$1", cid)
                roles = await con.fetch(
                    "SELECT role FROM messages WHERE conversation_id=$1 ORDER BY created_at", cid)
            finally:
                await con.close()
            return crow, [r["role"] for r in roles]

        crow, roles = asyncio.get_event_loop().run_until_complete(check())
        assert crow is not None and crow["title"] == "pg"
        assert "user" in roles and "assistant" in roles
