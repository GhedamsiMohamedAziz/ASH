"""Request identity (§13.4) + real /me connections + /connect gateway proxy.

Covers: header-less fallback to the dev identity (existing behavior preserved), a minted
auth-service RS256 token driving create_conversation/me, /me reflecting a mocked gateway
/v1/connections, and /connect proxying to the gateway. All offline + keyless.
"""

import pytest
from fastapi.testclient import TestClient

from app import main
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


def _bearer(sub: str, org_id: str) -> dict:
    token, _kid, _exp = get_auth_service().mint(sub=sub, org_id=org_id)
    return {"Authorization": f"Bearer {token}"}


# --------------------------------------------------------------- httpx gateway fake
class _FakeResp:
    def __init__(self, data): self._data = data
    def raise_for_status(self): pass
    def json(self): return self._data


class _FakeClient:
    """Stands in for httpx.Client; records the last call so proxying can be asserted."""
    last_get: tuple | None = None
    last_post: tuple | None = None

    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False

    def get(self, url, params=None):
        _FakeClient.last_get = (url, params)
        return _FakeResp({"connections": [{"provider": "github", "connected": True},
                                          {"provider": "slack", "connected": True}]})

    def post(self, url, json=None):
        _FakeClient.last_post = (url, json)
        return _FakeResp({"connected": True, "provider": json["provider"]})


# --------------------------------------------------------------- (1) header-less fallback
def test_no_auth_header_is_dev_user(client):
    # /me
    assert client.get("/api/v1/me").json()["user_id"] == "usr_dev"
    # create_conversation stamps the dev user (existing behavior preserved)
    conv = client.post("/api/v1/conversations", json={"channel": "web"}).json()
    assert conv["user_id"] == "usr_dev"


# --------------------------------------------------------------- (2) minted RS256 token
def test_minted_token_sets_identity(client):
    h = _bearer("usr_42", "org_9")
    conv = client.post("/api/v1/conversations", json={"channel": "web"}, headers=h).json()
    assert conv["user_id"] == "usr_42"
    # /me reports the same sub, and list is scoped to that user
    assert client.get("/api/v1/me", headers=h).json()["user_id"] == "usr_42"
    listed = client.get("/api/v1/conversations", headers=h).json()["items"]
    assert any(c["id"] == conv["id"] for c in listed)
    # A header-less list (dev user) does NOT see usr_42's conversation.
    dev_listed = client.get("/api/v1/conversations").json()["items"]
    assert all(c["id"] != conv["id"] for c in dev_listed)


def test_invalid_token_falls_back_to_dev(client):
    h = {"Authorization": "Bearer not.a.valid.token"}
    assert client.get("/api/v1/me", headers=h).json()["user_id"] == "usr_dev"


# --------------------------------------------------------------- (3) /me connections from gateway
def test_me_connected_reflects_gateway(client, monkeypatch):
    monkeypatch.setattr(main, "MCP_GATEWAY_URL", "http://gw.test")
    import httpx
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    body = client.get("/api/v1/me", headers=_bearer("usr_42", "org_9")).json()
    connected = {c["provider"]: c["connected"] for c in body["connections"]}
    assert connected["github"] is True and connected["slack"] is True
    assert connected["notion"] is False and connected["m365"] is False
    # The gateway was queried for THIS user.
    assert _FakeClient.last_get[1] == {"userId": "usr_42"}


def test_me_all_false_when_gateway_unset(client, monkeypatch):
    monkeypatch.setattr(main, "MCP_GATEWAY_URL", None)
    body = client.get("/api/v1/me").json()
    assert all(c["connected"] is False for c in body["connections"])


def test_me_all_false_when_gateway_down(client, monkeypatch):
    monkeypatch.setattr(main, "MCP_GATEWAY_URL", "http://127.0.0.1:1/")
    body = client.get("/api/v1/me").json()
    assert all(c["connected"] is False for c in body["connections"])


# --------------------------------------------------------------- (4) /connect proxy
def test_connect_proxies_to_gateway(client, monkeypatch):
    monkeypatch.setattr(main, "MCP_GATEWAY_URL", "http://gw.test")
    import httpx
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    r = client.post("/api/v1/connect", json={"provider": "github", "token": "ghp_x"},
                    headers=_bearer("usr_42", "org_9"))
    assert r.status_code == 200
    assert r.json() == {"connected": True, "provider": "github"}
    # Proxied with the current user + provider + token.
    url, payload = _FakeClient.last_post
    assert url == "http://gw.test/v1/connect"
    assert payload == {"userId": "usr_42", "provider": "github", "token": "ghp_x"}


def test_connect_graceful_when_gateway_unset(client, monkeypatch):
    monkeypatch.setattr(main, "MCP_GATEWAY_URL", None)
    r = client.post("/api/v1/connect", json={"provider": "slack", "token": "x"})
    assert r.status_code == 200
    assert r.json() == {"connected": False, "provider": "slack"}


# --------------------------------------------------------------- (5) /login (dev-login proxy, ADR-018)
class _LoginClient:
    """Stands in for httpx.Client hitting auth-service /oidc/dev-login."""
    last_post: tuple | None = None

    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False

    def post(self, url, json=None):
        _LoginClient.last_post = (url, json)
        return _FakeResp({"token": "rs256.header.payload", "kid": "k1",
                          "token_type": "access", "expires_in": 900})


def test_login_bad_input_400(client, monkeypatch):
    monkeypatch.setattr(main, "AUTH_SERVICE_URL", "http://auth.test")
    r = client.post("/api/v1/login", json={"org_id": "org_9"})  # no sub
    assert r.status_code == 400


def test_login_no_auth_service_url_502(client, monkeypatch):
    monkeypatch.setattr(main, "AUTH_SERVICE_URL", None)
    r = client.post("/api/v1/login", json={"sub": "usr_a", "org_id": "org_9"})
    assert r.status_code == 502


def test_login_proxies_dev_login_and_returns_token(client, monkeypatch):
    monkeypatch.setattr(main, "AUTH_SERVICE_URL", "http://auth.test")
    import httpx
    monkeypatch.setattr(httpx, "Client", _LoginClient)
    r = client.post("/api/v1/login", json={"sub": "usr_mehdi", "org_id": "org_9", "role": "admin"})
    assert r.status_code == 200
    assert r.json() == {"token": "rs256.header.payload", "user_id": "usr_mehdi", "org_id": "org_9"}
    url, payload = _LoginClient.last_post
    assert url == "http://auth.test/oidc/dev-login"
    assert payload == {"sub": "usr_mehdi", "org_id": "org_9", "role": "admin"}
