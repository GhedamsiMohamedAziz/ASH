"""Tests for the connector-token durability fix (§13.2): POST/GET /internal/oauth-tokens.

The MCP Gateway persists a SEALED (AES-256-GCM ciphertext) token here so a gateway restart can
rehydrate connections. backend-core stores ONLY ciphertext — it never sees plaintext. Both routes
are service-token gated (like /internal/automations). Offline assertions run without a DB; the
round-trip over real oauth_tokens rows skips gracefully when DATABASE_URL is unset (matching
test_automations.py / test_rls_isolation.py).
"""

import base64
import os
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app, store
from app.identity import get_auth_service


@pytest.fixture(autouse=True)
def _reset():
    store.conversations.clear()
    store.idempotency.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _bearer(sub: str, org_id: str, role: str = "member") -> dict:
    token, _kid, _exp = get_auth_service().mint(sub=sub, org_id=org_id, role=role)
    return {"Authorization": f"Bearer {token}"}


_SEALED = base64.b64encode(b'{"iv":"00","tag":"11","ct":"deadbeef"}').decode()


# --------------------------------------------------------------- service-token gating (no DB)
def test_upsert_rejects_user_jwt(client):
    r = client.post("/internal/oauth-tokens",
                    json={"user_id": "usr_1", "provider": "github", "sealed_token": _SEALED},
                    headers=_bearer("usr_1", "org_1"))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_PERM_TOOL_DENIED"


def test_upsert_rejects_missing_token(client):
    r = client.post("/internal/oauth-tokens",
                    json={"user_id": "usr_1", "provider": "github", "sealed_token": _SEALED})
    assert r.status_code == 403


def test_upsert_rejects_wrong_service_token(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", "s3cr3t")
    r = client.post("/internal/oauth-tokens",
                    json={"user_id": "usr_1", "provider": "github", "sealed_token": _SEALED},
                    headers={"X-Service-Token": "wrong"})
    assert r.status_code == 403


def test_upsert_denies_when_token_unconfigured(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", None)
    r = client.post("/internal/oauth-tokens",
                    json={"user_id": "usr_1", "provider": "github", "sealed_token": _SEALED},
                    headers={"X-Service-Token": "anything"})
    assert r.status_code == 403


def test_list_rejects_missing_token(client):
    r = client.get("/internal/oauth-tokens")
    assert r.status_code == 403


def test_list_rejects_user_jwt(client):
    r = client.get("/internal/oauth-tokens", headers=_bearer("usr_1", "org_1"))
    assert r.status_code == 403


# --------------------------------------------------------------- degrade without a DB
def test_upsert_503_without_database(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", "s3cr3t")
    r = client.post("/internal/oauth-tokens",
                    json={"user_id": "usr_1", "provider": "github", "sealed_token": _SEALED},
                    headers={"X-Service-Token": "s3cr3t"})
    # No DATABASE_URL in the offline suite → honest 503, never a fabricated persist.
    assert r.status_code == 503


def test_list_empty_without_database(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", "s3cr3t")
    r = client.get("/internal/oauth-tokens", headers={"X-Service-Token": "s3cr3t"})
    assert r.status_code == 200
    assert r.json() == {"tokens": []}


def test_upsert_rejects_bad_base64(client, monkeypatch):
    from app import main
    # A real DB isn't needed — base64 validation runs before persistence... but the 503 guard fires
    # first without a DB. Point store.db at a stub so we reach the base64 decode branch.
    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", "s3cr3t")

    class _StubDb:
        async def upsert_oauth_token(self, *a, **k):  # pragma: no cover - must not be reached
            raise AssertionError("bad base64 must be rejected before persistence")

        async def ensure_dev_user(self, *a, **k):
            pass

    monkeypatch.setattr(store, "db", _StubDb())
    try:
        r = client.post("/internal/oauth-tokens",
                        json={"user_id": "usr_1", "provider": "github", "sealed_token": "not base64!!"},
                        headers={"X-Service-Token": "s3cr3t"})
        assert r.status_code == 400
        assert r.json()["error"]["code"] == "E_VALIDATION"
    finally:
        monkeypatch.setattr(store, "db", None)


# --------------------------------------------------------------- live round-trip (real Postgres)
@pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="requires DATABASE_URL (live Postgres)")
def test_upsert_then_list_round_trips_sealed_blob(monkeypatch):
    """Seed a sealed blob through the endpoint, then read it back — the ciphertext survives the
    round-trip byte-for-byte, proving durable persistence of exactly what the gateway sealed."""
    from app import main

    dsn = os.environ["DATABASE_URL"]
    user_id = f"usr_oauth_{uuid.uuid4().hex[:8]}"
    provider = "github"
    raw_blob = f'{{"iv":"aa","tag":"bb","ct":"{uuid.uuid4().hex}"}}'.encode()
    sealed_b64 = base64.b64encode(raw_blob).decode()

    async def cleanup():
        import asyncpg
        con = await asyncpg.connect(dsn)
        try:
            await con.execute("DELETE FROM oauth_tokens WHERE user_id=$1", user_id)
            await con.execute("DELETE FROM users WHERE id=$1", user_id)
        finally:
            await con.close()

    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", "s3cr3t")
    with TestClient(app) as c:  # lifespan wires store.db from DATABASE_URL
        try:
            up = c.post("/internal/oauth-tokens",
                        json={"user_id": user_id, "provider": provider,
                              "sealed_token": sealed_b64, "org_id": "org_dev",
                              "scopes": ["repo", "read:org"]},
                        headers={"X-Service-Token": "s3cr3t"})
            assert up.status_code == 204

            ls = c.get("/internal/oauth-tokens", headers={"X-Service-Token": "s3cr3t"})
            assert ls.status_code == 200
            rows = ls.json()["tokens"]
            mine = [t for t in rows if t["user_id"] == user_id and t["provider"] == provider]
            assert len(mine) == 1, "the seeded token did not round-trip"
            assert mine[0]["sealed_token"] == sealed_b64, "ciphertext was not preserved byte-for-byte"
            assert mine[0]["scopes"] == ["repo", "read:org"]

            # Upsert is idempotent on (user_id, provider): a second POST updates, not duplicates.
            new_blob = base64.b64encode(b'{"iv":"cc","tag":"dd","ct":"beef"}').decode()
            up2 = c.post("/internal/oauth-tokens",
                         json={"user_id": user_id, "provider": provider,
                               "sealed_token": new_blob, "org_id": "org_dev"},
                         headers={"X-Service-Token": "s3cr3t"})
            assert up2.status_code == 204
            ls2 = c.get("/internal/oauth-tokens", headers={"X-Service-Token": "s3cr3t"})
            mine2 = [t for t in ls2.json()["tokens"] if t["user_id"] == user_id]
            assert len(mine2) == 1, "upsert duplicated instead of updating"
            assert mine2[0]["sealed_token"] == new_blob
        finally:
            # Clean up on a fresh loop (the TestClient lifespan loop is closed by now).
            import asyncio
            loop = asyncio.new_event_loop()
            try:
                loop.run_until_complete(cleanup())
            finally:
                loop.close()
