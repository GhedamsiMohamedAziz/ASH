"""Real OAuth 2.0 authorization-code flow for connector connections (§13.4, ADR-019).

Self-contained FastAPI router that replaces the paste-a-PAT flow for the personal
connectors (GitHub, Slack, Notion, Microsoft 365) with a genuine three-legged OAuth
handshake:

    /api/v1/connections/{provider}/start     → 302 to the provider's authorize URL
    /api/v1/connections/{provider}/callback  → exchanges the code, stores the token,
                                               302s the browser back to the web app

The obtained access token is stored EXACTLY like the existing dev /connect proxy: a
POST to the MCP Gateway's authenticated ``/v1/connect`` (X-Service-Token) — this module
never touches the gateway's storage directly, only its HTTP surface, so it stays honest
with the credential-mutation gate (§13.4).

CSRF is prevented with a SIGNED, short-lived ``state`` (HMAC over
{user_id, provider, nonce, exp}) using the shared HS256 helper (same primitive as the
TASK JWT / webhook signatures). A tampered or expired state is rejected fail-closed and
NEVER results in a stored token.

Providers with no ``*_CLIENT_ID`` configured fail HONESTLY at /start with a 400 — an
unconfigured provider is never faked as working.

Env:
- ``{PROVIDER}_CLIENT_ID`` / ``{PROVIDER}_CLIENT_SECRET`` — per provider OAuth app creds
  (GITHUB_*, SLACK_*, NOTION_*, MICROSOFT_* for m365).
- ``OAUTH_REDIRECT_BASE``  — public base of THIS service (default http://localhost:8000);
  the provider redirects back to {base}/api/v1/connections/{provider}/callback.
- ``OAUTH_WEB_APP_URL``    — the SPA to bounce back to (default http://localhost:5173);
  lands on {url}/connecteurs?connected=<p> or ?error=<code>.
- ``OAUTH_STATE_SECRET``   — HMAC secret for the state token (dev default; fail-closed in
  prod OLMA_ENV=prod when unset, mirroring TASK_JWT_SECRET's prod guard).
- ``MCP_GATEWAY_URL`` / ``GATEWAY_ADMIN_TOKEN`` — where/how the token is stored (same as
  backend-core's /connect proxy).
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import RedirectResponse

from olma_shared import jwt

from .identity import current_identity, verify_token

# --------------------------------------------------------------- provider table
@dataclass(frozen=True)
class ProviderConfig:
    """Static per-provider OAuth endpoints + the ENV prefix its creds are read from.

    Endpoints/scopes are fixed platform facts; client_id/client_secret are read from env at
    call time (see `_client_creds`) so an unconfigured provider fails honestly at /start.
    """
    key: str
    authorize_url: str
    token_url: str
    default_scope: str
    env_prefix: str


# GitHub is first-class (§13.4); the others carry sensible default scopes but are equally real.
PROVIDERS: dict[str, ProviderConfig] = {
    "github": ProviderConfig(
        key="github",
        authorize_url="https://github.com/login/oauth/authorize",
        token_url="https://github.com/login/oauth/access_token",
        default_scope="repo read:org",
        env_prefix="GITHUB",
    ),
    "slack": ProviderConfig(
        key="slack",
        authorize_url="https://slack.com/oauth/v2/authorize",
        token_url="https://slack.com/api/oauth.v2.access",
        default_scope="channels:read chat:write",
        env_prefix="SLACK",
    ),
    "notion": ProviderConfig(
        key="notion",
        authorize_url="https://api.notion.com/v1/oauth/authorize",
        token_url="https://api.notion.com/v1/oauth/token",
        default_scope="",
        env_prefix="NOTION",
    ),
    "m365": ProviderConfig(
        key="m365",
        authorize_url="https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
        token_url="https://login.microsoftonline.com/common/oauth2/v2.0/token",
        default_scope="offline_access User.Read Mail.Read",
        env_prefix="MICROSOFT",
    ),
}

_STATE_TTL = 600  # signed state lives ~10 min (§13.4) — long enough for a login, short for CSRF


# --------------------------------------------------------------- env-resolved config (call time)
def _provider(provider: str) -> ProviderConfig:
    cfg = PROVIDERS.get(provider)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"unknown provider: {provider}")
    return cfg


def _client_creds(cfg: ProviderConfig) -> tuple[str | None, str | None]:
    return (os.getenv(f"{cfg.env_prefix}_CLIENT_ID"),
            os.getenv(f"{cfg.env_prefix}_CLIENT_SECRET"))


def _redirect_base() -> str:
    return os.getenv("OAUTH_REDIRECT_BASE", "http://localhost:8000").rstrip("/")


def _web_app_url() -> str:
    return os.getenv("OAUTH_WEB_APP_URL", "http://localhost:5173").rstrip("/")


def _redirect_uri(provider: str) -> str:
    return f"{_redirect_base()}/api/v1/connections/{provider}/callback"


def _state_secret() -> str:
    """HMAC secret for the state token. Fail-closed in prod (mirrors TASK_JWT_SECRET): a prod
    deploy that forgot to set OAUTH_STATE_SECRET must NOT sign state with a guessable dev secret."""
    secret = os.getenv("OAUTH_STATE_SECRET")
    if secret:
        return secret
    if os.getenv("OLMA_ENV") == "prod":
        raise HTTPException(status_code=500, detail="OAUTH_STATE_SECRET must be set in prod")
    return "dev-oauth-state-secret"


# --------------------------------------------------------------- signed state (CSRF defence)
def sign_state(user_id: str, provider: str, *, ttl: int = _STATE_TTL) -> str:
    """Mint a signed, short-lived state binding {user_id, provider, nonce, exp}. HMAC-SHA256 via
    the shared HS256 helper — the same primitive as the TASK JWT, so a client can neither forge
    nor tamper it."""
    import time
    claims = {
        "user_id": user_id,
        "provider": provider,
        "nonce": uuid.uuid4().hex,
        "exp": int(time.time()) + ttl,
    }
    return jwt.sign(claims, _state_secret())


def verify_state(state: str, provider: str) -> dict:
    """Verify signature + expiry + provider binding. Raises jwt.JWTError on any problem (fail-
    closed) so the caller never stores a token off an unverified state."""
    claims = jwt.verify(state, _state_secret())
    if claims.get("provider") != provider:
        raise jwt.InvalidClaim("state provider mismatch")
    if not claims.get("user_id"):
        raise jwt.InvalidClaim("state missing user_id")
    return claims


# --------------------------------------------------------------- token exchange / storage
def _extract_token(data: dict) -> str | None:
    """Pull the user access token out of a provider token response. Most providers put it at
    ``access_token``; Slack v2 nests the *user* token under ``authed_user`` — accept either."""
    token = data.get("access_token")
    if not token and isinstance(data.get("authed_user"), dict):
        token = data["authed_user"].get("access_token")
    return token


def _exchange_code(cfg: ProviderConfig, code: str) -> dict:
    """Exchange the authorization code for tokens at the provider. Standard OAuth2:
    POST {client_id, client_secret, code, redirect_uri, grant_type=authorization_code}, JSON back."""
    client_id, client_secret = _client_creds(cfg)
    import httpx
    with httpx.Client(timeout=15) as http:
        r = http.post(cfg.token_url, data={
            "client_id": client_id,
            "client_secret": client_secret,
            "code": code,
            "redirect_uri": _redirect_uri(cfg.key),
            "grant_type": "authorization_code",
        }, headers={"Accept": "application/json"})
        r.raise_for_status()
        return r.json()


def _store_token(user_id: str, provider: str, token: str) -> bool:
    """Persist the access token via the Gateway's authenticated /v1/connect — the SAME call the
    dev /connect proxy makes (X-Service-Token). Returns True only on a gateway-confirmed connect."""
    gateway_url = os.getenv("MCP_GATEWAY_URL")
    if not gateway_url:
        return False
    admin_token = os.getenv("GATEWAY_ADMIN_TOKEN", "dev-gateway-admin-token")
    import httpx
    try:
        with httpx.Client(timeout=10) as http:
            r = http.post(f"{gateway_url}/v1/connect", json={
                "userId": user_id, "provider": provider, "token": token,
            }, headers={"X-Service-Token": admin_token})
            r.raise_for_status()
            return bool(r.json().get("connected", True))
    except Exception:  # noqa: BLE001 — a gateway failure is a store failure, reported to the caller
        return False


def refresh_token(provider: str, refresh_token: str) -> dict | None:
    """Best-effort refresh of an expired access token via the provider's refresh grant (used later
    by the oauth-refresh-sweep cron; wiring the cron is out of scope). Returns the parsed token
    response {access_token, refresh_token?, expires_in?, scope?} or None on any failure."""
    cfg = PROVIDERS.get(provider)
    if cfg is None:
        return None
    client_id, client_secret = _client_creds(cfg)
    if not client_id:
        return None
    import httpx
    try:
        with httpx.Client(timeout=15) as http:
            r = http.post(cfg.token_url, data={
                "client_id": client_id,
                "client_secret": client_secret,
                "grant_type": "refresh_token",
                "refresh_token": refresh_token,
            }, headers={"Accept": "application/json"})
            r.raise_for_status()
            data = r.json()
    except Exception:  # noqa: BLE001 — a refresh failure is best-effort; the sweep retries later
        return None
    return data if _extract_token(data) else None


# --------------------------------------------------------------- routes
# Mounted under backend-core's /api/v1 router by the parent (api.include_router(router)), so the
# public paths are /api/v1/connections/{provider}/start and .../callback.
router = APIRouter(prefix="/connections", tags=["connections"])


@router.get("/{provider}/start")
def start(provider: str, auth: str | None = Query(default=None),
          identity: tuple[str, str] = Depends(current_identity)) -> RedirectResponse:
    """Kick off the OAuth handshake: resolve the caller, build the provider authorize URL with a
    signed state, and 302 the browser to the provider (a full-page nav completes the redirect).

    Identity threading (§13.4): the SPA authenticates with a Bearer token, but this endpoint is
    reached by a full-page navigation that CANNOT carry that header — so the browser would otherwise
    arrive as the header-less dev user and the token would be stored under the wrong identity. The SPA
    therefore passes its token as `?auth=<jwt>`; we verify it here and bind THAT user into the signed
    state, so the callback stores the connection under the real logged-in user. Falls back to the
    header/dev identity when no `auth` is supplied (header-less callers, tests) — purely additive."""
    cfg = _provider(provider)
    client_id, _secret = _client_creds(cfg)
    if not client_id:
        raise HTTPException(status_code=400, detail="provider OAuth not configured")
    user_id, _org_id = identity
    if auth:
        try:
            user_id = verify_token(auth).get("sub") or user_id
        except Exception:  # noqa: BLE001 — an invalid ?auth token falls back to the header/dev identity
            pass
    state = sign_state(user_id, provider)
    params = {
        "client_id": client_id,
        "redirect_uri": _redirect_uri(provider),
        "response_type": "code",
        "scope": cfg.default_scope,
        "state": state,
    }
    return RedirectResponse(url=f"{cfg.authorize_url}?{urlencode(params)}", status_code=302)


def _fail(provider: str, code: str) -> RedirectResponse:
    """Fail-closed bounce back to the SPA with an error code — NEVER stores anything."""
    return RedirectResponse(
        url=f"{_web_app_url()}/connecteurs?error={code}&provider={provider}", status_code=302)


@router.get("/{provider}/callback")
def callback(provider: str, code: str | None = None, state: str | None = None,
             error: str | None = None) -> RedirectResponse:
    """Provider redirect target: verify state, exchange the code, store the token, and bounce the
    browser back to the web app with ?connected=<p> (or ?error=<code> on any failure). Fail-closed
    at every step — a bad state, a provider error, or a token-exchange/store failure stores nothing."""
    cfg = _provider(provider)
    # Provider-side denial (user declined / provider error) → honest error bounce, no exchange.
    if error or not code or not state:
        return _fail(provider, "provider_error")
    try:
        claims = verify_state(state, provider)
    except jwt.JWTError:
        return _fail(provider, "bad_state")  # tampered/expired/mismatched state — never store
    try:
        data = _exchange_code(cfg, code)
    except Exception:  # noqa: BLE001 — network / non-2xx from the provider token endpoint
        return _fail(provider, "exchange_failed")
    token = _extract_token(data)
    if not token:
        return _fail(provider, "no_token")
    if not _store_token(claims["user_id"], provider, token):
        return _fail(provider, "store_failed")
    return RedirectResponse(
        url=f"{_web_app_url()}/connecteurs?connected={provider}", status_code=302)
