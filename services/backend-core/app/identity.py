"""Request identity for backend-core (§5, §13.4).

Unifies on auth-service's RS256 verifier: an inbound `Authorization: Bearer <token>`
is verified against the auth-service JWKS in-process (no HTTP, no shared secret),
and its `sub`/`org_id` become the request identity. Absent OR invalid tokens fall
back to the dev identity so the no-login web app and the existing (header-less)
tests keep working unchanged.

auth-service ships its own package literally named `app` (same as this service),
so a plain `import app` would collide. We load it under a synthetic package name
via a light importlib shim — an offline file read, no edit to auth-service — which
gives us its importable `verify_token()` (§13.4) and `mint()` (for tests).
"""

from __future__ import annotations

import importlib
import importlib.util
import sys
from pathlib import Path

from fastapi import Header

DEV_USER = "usr_dev"  # fallback identity when no/invalid bearer token (§13.4)
DEV_ORG = "org_1"     # org with seeded tool_policies (§9.4)

# --------------------------------------------------------------- auth-service shim
_SHIM_PKG = "_olma_auth_service"
_AUTH_APP_DIR = Path(__file__).resolve().parents[3] / "services" / "auth-service" / "app"


def _auth_service_module():
    """Load auth-service's `app` package under a synthetic name and return its
    `service` module (which exposes `verify_token`, `get_service`, `AuthService`)."""
    svc_name = f"{_SHIM_PKG}.service"
    if svc_name in sys.modules:
        return sys.modules[svc_name]
    if _SHIM_PKG not in sys.modules:
        spec = importlib.util.spec_from_file_location(
            _SHIM_PKG,
            _AUTH_APP_DIR / "__init__.py",
            submodule_search_locations=[str(_AUTH_APP_DIR)],
        )
        pkg = importlib.util.module_from_spec(spec)
        sys.modules[_SHIM_PKG] = pkg
        spec.loader.exec_module(pkg)  # type: ignore[union-attr]
    return importlib.import_module(svc_name)


def verify_token(token: str) -> dict:
    """Fail-closed RS256 verify via auth-service. Raises on any problem."""
    return _auth_service_module().verify_token(token)


def get_auth_service():
    """The auth-service default AuthService instance (mint/verify) — used by tests."""
    return _auth_service_module().get_service()


class AuthError(Exception):
    """Raised by verify on any token problem; unified alias for the RS256 verifier's error."""


# Bind AuthError to the real jwt_rs256.JWTError so callers can `except AuthError`.
def _auth_error_type():
    return _auth_service_module().jwt_rs256.JWTError


# --------------------------------------------------------------- FastAPI dependency
def current_identity(authorization: str | None = Header(default=None)) -> tuple[str, str]:
    """Resolve (user_id, org_id) from a Bearer token, or fall back to the dev identity.

    Present + valid auth-service RS256 token -> (sub, org_id).
    Absent OR invalid -> (DEV_USER, DEV_ORG) so header-less callers keep working.
    """
    if authorization and authorization.startswith("Bearer "):
        token = authorization[7:].strip()
        try:
            claims = verify_token(token)
        except Exception:  # noqa: BLE001 — any token problem => dev fallback (§13.4)
            return DEV_USER, DEV_ORG
        sub = claims.get("sub")
        if sub:
            return sub, claims.get("org_id") or DEV_ORG
    return DEV_USER, DEV_ORG
