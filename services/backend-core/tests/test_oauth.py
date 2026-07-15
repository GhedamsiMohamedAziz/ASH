"""Tests for the OAuth 2.0 authorization-code flow (app/oauth.py, §13.4, ADR-019).

The router is not yet included in the main app, so we mount it on a tiny FastAPI app under
the SAME /api/v1 prefix the parent will use (api.include_router(router)) — this exercises the
real public paths /api/v1/connections/{provider}/{start,callback}. httpx is faked exactly like
test_identity.py (a _FakeClient recording calls), keeping the suite offline + keyless.
"""

import time

import pytest
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient

from app import oauth
from app.oauth import PROVIDERS, refresh_token, sign_state, verify_state
from olma_shared import jwt


@pytest.fixture
def client():
    app = FastAPI()
    api = APIRouter(prefix="/api/v1")
    api.include_router(oauth.router)
    app.include_router(api)
    # follow_redirects=False so we can assert on the 302 Location the flow returns.
    return TestClient(app, follow_redirects=False)


@pytest.fixture(autouse=True)
def _state_secret(monkeypatch):
    monkeypatch.setenv("OAUTH_STATE_SECRET", "test-secret")
    monkeypatch.setenv("OAUTH_REDIRECT_BASE", "http://localhost:8000")
    monkeypatch.setenv("OAUTH_WEB_APP_URL", "http://localhost:5173")


# --------------------------------------------------------------- state sign/verify
def test_state_round_trip():
    s = sign_state("usr_1", "github")
    claims = verify_state(s, "github")
    assert claims["user_id"] == "usr_1"
    assert claims["provider"] == "github"
    assert claims["nonce"]


def test_state_tamper_rejected():
    s = sign_state("usr_1", "github")
    tampered = s[:-2] + ("aa" if not s.endswith("aa") else "bb")
    with pytest.raises(jwt.JWTError):
        verify_state(tampered, "github")


def test_state_wrong_provider_rejected():
    s = sign_state("usr_1", "github")
    with pytest.raises(jwt.JWTError):
        verify_state(s, "slack")


def test_state_expiry_rejected():
    s = sign_state("usr_1", "github", ttl=-1)  # already expired
    with pytest.raises(jwt.ExpiredToken):
        verify_state(s, "github")


# --------------------------------------------------------------- /start
def test_start_configured_redirects_to_authorize(client, monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "gh_client")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "gh_secret")
    r = client.get("/api/v1/connections/github/start")
    assert r.status_code == 302
    loc = r.headers["location"]
    assert loc.startswith("https://github.com/login/oauth/authorize?")
    assert "client_id=gh_client" in loc
    assert "response_type=code" in loc
    assert "scope=repo" in loc  # "repo read:org" url-encoded
    assert "state=" in loc
    assert "redirect_uri=http%3A%2F%2Flocalhost%3A8000%2Fapi%2Fv1%2Fconnections%2Fgithub%2Fcallback" in loc


def test_start_unconfigured_provider_is_400(client, monkeypatch):
    monkeypatch.delenv("SLACK_CLIENT_ID", raising=False)
    r = client.get("/api/v1/connections/slack/start")
    assert r.status_code == 400
    assert "not configured" in r.json()["detail"]


def test_start_unknown_provider_is_404(client):
    r = client.get("/api/v1/connections/bogus/start")
    assert r.status_code == 404


# --------------------------------------------------------------- callback
class _FakeResp:
    def __init__(self, data): self._data = data
    def raise_for_status(self): pass
    def json(self): return self._data


class _FakeClient:
    """Fakes httpx.Client for BOTH the provider token endpoint and the gateway /v1/connect,
    routing by URL. Records the gateway store call so we can assert it fired (or did NOT)."""
    store_call: tuple | None = None
    token_response: dict = {"access_token": "gho_live_token", "scope": "repo"}

    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False

    def post(self, url, data=None, json=None, headers=None):
        if url.endswith("/v1/connect"):
            _FakeClient.store_call = (url, json, headers)
            return _FakeResp({"connected": True, "provider": json["provider"]})
        # provider token endpoint
        return _FakeResp(_FakeClient.token_response)


@pytest.fixture
def _reset_fake():
    _FakeClient.store_call = None
    _FakeClient.token_response = {"access_token": "gho_live_token", "scope": "repo"}
    yield


def test_callback_happy_path_stores_and_redirects(client, monkeypatch, _reset_fake):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "gh_client")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "gh_secret")
    monkeypatch.setenv("MCP_GATEWAY_URL", "http://gw.test")
    monkeypatch.setenv("GATEWAY_ADMIN_TOKEN", "dev-gateway-admin-token")
    import httpx
    monkeypatch.setattr(httpx, "Client", _FakeClient)

    state = sign_state("usr_42", "github")
    r = client.get(f"/api/v1/connections/github/callback?code=abc&state={state}")
    assert r.status_code == 302
    assert r.headers["location"] == "http://localhost:5173/connecteurs?connected=github"
    # Token was stored via the gateway with the verified user + real access token.
    url, body, headers = _FakeClient.store_call
    assert url == "http://gw.test/v1/connect"
    assert body == {"userId": "usr_42", "provider": "github", "token": "gho_live_token"}
    assert headers["X-Service-Token"] == "dev-gateway-admin-token"


def test_callback_bad_state_rejected_no_store(client, monkeypatch, _reset_fake):
    monkeypatch.setenv("MCP_GATEWAY_URL", "http://gw.test")
    import httpx
    monkeypatch.setattr(httpx, "Client", _FakeClient)

    r = client.get("/api/v1/connections/github/callback?code=abc&state=forged.state.token")
    assert r.status_code == 302
    assert "error=bad_state" in r.headers["location"]
    assert _FakeClient.store_call is None  # never stored off an unverified state


def test_callback_provider_error_no_store(client, monkeypatch, _reset_fake):
    import httpx
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    r = client.get("/api/v1/connections/github/callback?error=access_denied")
    assert r.status_code == 302
    assert "error=provider_error" in r.headers["location"]
    assert _FakeClient.store_call is None


def test_callback_store_failure_bounces_error(client, monkeypatch, _reset_fake):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "gh_client")
    monkeypatch.delenv("MCP_GATEWAY_URL", raising=False)  # no gateway → store fails honestly
    import httpx
    monkeypatch.setattr(httpx, "Client", _FakeClient)
    state = sign_state("usr_42", "github")
    r = client.get(f"/api/v1/connections/github/callback?code=abc&state={state}")
    assert r.status_code == 302
    assert "error=store_failed" in r.headers["location"]


# --------------------------------------------------------------- refresh helper
class _RefreshClient:
    last_data: dict | None = None

    def __init__(self, *a, **k): pass
    def __enter__(self): return self
    def __exit__(self, *a): return False

    def post(self, url, data=None, json=None, headers=None):
        _RefreshClient.last_data = data
        return _FakeResp({"access_token": "gho_refreshed", "refresh_token": "r2", "expires_in": 3600})


def test_refresh_token_uses_refresh_grant(monkeypatch):
    monkeypatch.setenv("GITHUB_CLIENT_ID", "gh_client")
    monkeypatch.setenv("GITHUB_CLIENT_SECRET", "gh_secret")
    import httpx
    monkeypatch.setattr(httpx, "Client", _RefreshClient)
    out = refresh_token("github", "old_refresh")
    assert out["access_token"] == "gho_refreshed"
    assert _RefreshClient.last_data["grant_type"] == "refresh_token"
    assert _RefreshClient.last_data["refresh_token"] == "old_refresh"


def test_refresh_token_unconfigured_returns_none(monkeypatch):
    monkeypatch.delenv("GITHUB_CLIENT_ID", raising=False)
    assert refresh_token("github", "x") is None


def test_all_four_user_providers_present():
    assert set(PROVIDERS) == {"github", "slack", "notion", "m365"}
