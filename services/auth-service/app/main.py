"""auth-service — RS256 JWT issuance/verification + JWKS (instructions.md §5, §8.1, §13.4).

Identity-first and fail-closed (§5): every verification path rejects on any
problem and never accepts `alg:none` or an unknown `kid`. Other services (API
Gateway, backend-core, MCP Gateway) verify platform tokens against the JWKS
published here — no shared secret.

OIDC against Entra ID (§7.1) / Slack (§7.2) needs external providers, so the
provider round-trip is STUBBED (`/oidc/dev-login`); see that handler.
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException
from fastapi.responses import JSONResponse

from . import jwt_rs256
from .models import (
    OidcDevLoginRequest,
    TokenRequest,
    TokenResponse,
    VerifyRequest,
    VerifyResponse,
)
from .service import get_service

app = FastAPI(title="olma auth-service", version="0.1.0")
auth = get_service()


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


# --------------------------------------------------------------- JWKS (§8.1)
@app.get("/.well-known/jwks.json")
def jwks() -> dict:
    """Public keys in JWK format. Includes current + previous during rotation."""
    return auth.jwks()


# --------------------------------------------------------------- issuance (§13.4)
@app.post("/token", response_model=TokenResponse)
def mint_token(body: TokenRequest) -> TokenResponse:
    token, kid, expires_in = auth.mint(
        sub=body.sub,
        org_id=body.org_id,
        role=body.role,
        token_type=body.token_type,
        iss=body.iss,
        aud=body.aud,
        allowed_tools=body.allowed_tools,
        approval_tools=body.approval_tools,
        on_behalf_of=body.on_behalf_of,
        task_id=body.task_id,
        conversation_id=body.conversation_id,
    )
    return TokenResponse(token=token, kid=kid, token_type=body.token_type, expires_in=expires_in)


# --------------------------------------------------------------- verification (§5)
@app.post("/verify", response_model=VerifyResponse)
def verify_token_endpoint(body: VerifyRequest) -> VerifyResponse:
    try:
        claims = auth.verify(body.token)
    except jwt_rs256.JWTError as e:
        # Fail-closed: any problem → 401, no claim details leaked.
        return JSONResponse(status_code=401, content={"valid": False, "error": type(e).__name__})
    return VerifyResponse(valid=True, claims=claims)


# --------------------------------------------------------------- key rotation (§13.4)
@app.post("/admin/rotate")
def rotate_keys() -> dict:
    """Dev-only: rotate signing keys. Old key stays in JWKS for the overlap window.

    Production restricts this to platform admins / an automated monthly job (§13.4).
    """
    new_key = auth.rotate()
    return {
        "rotated": True,
        "current_kid": new_key.kid,
        "jwks_kids": [k["kid"] for k in auth.jwks()["keys"]],
    }


# --------------------------------------------------------------- OIDC (STUB, §7.1/§7.2)
@app.post("/oidc/dev-login", response_model=TokenResponse)
def oidc_dev_login(body: OidcDevLoginRequest) -> TokenResponse:
    """STUB OIDC login: accepts a claimed identity and issues a session JWT.

    In production this endpoint is replaced by the real OIDC authorization-code
    flow against Entra ID (§7.1) or Slack (§7.2): redirect to the provider,
    receive the callback, validate the provider's id_token against ITS JWKS, map
    the verified claims (oid/email → sub, tenant → org_id), then mint the platform
    JWT below. We deliberately do NOT fake calls to real providers here; the
    verified-identity → mint step is what stays, so a real provider drops in
    cleanly. Fail-closed still holds: the issued token is a normal RS256 JWT.
    """
    if not body.sub or not body.org_id:
        raise HTTPException(status_code=400, detail="sub and org_id are required")
    token, kid, expires_in = auth.mint(sub=body.sub, org_id=body.org_id, role=body.role)
    return TokenResponse(token=token, kid=kid, token_type="access", expires_in=expires_in)
