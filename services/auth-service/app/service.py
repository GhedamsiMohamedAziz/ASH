"""AuthService — binds the key store to claim-minting and verification.

Exposes an importable `verify_token()` (§13.4 requirement) so other services can
verify a platform JWT in-process against the live JWKS without HTTP.
"""

from __future__ import annotations

import os
import time
import uuid
from typing import Any

from . import jwt_rs256
from .keys import KeyStore

DEFAULT_ISS = "olma-auth"
DEFAULT_AUD = "olma-internal"
DEFAULT_TTL = 15 * 60  # 15 min (§13.4)


class AuthService:
    def __init__(
        self,
        keys_dir: str | os.PathLike[str] | None = None,
        *,
        iss: str | None = None,
        aud: str | None = None,
        ttl_seconds: int | None = None,
    ) -> None:
        keys_dir = keys_dir or os.environ.get("AUTH_KEYS_DIR") or os.path.join(os.path.dirname(__file__), "..", "keys")
        self.keystore = KeyStore(keys_dir)
        self.iss = iss or os.environ.get("AUTH_ISS", DEFAULT_ISS)
        self.aud = aud or os.environ.get("AUTH_AUD", DEFAULT_AUD)
        self.ttl = ttl_seconds or int(os.environ.get("AUTH_TOKEN_TTL", DEFAULT_TTL))

    # ---------------------------------------------------------- issuance
    def mint(
        self,
        *,
        sub: str,
        org_id: str,
        role: str = "member",
        token_type: str = "access",
        iss: str | None = None,
        aud: str | None = None,
        allowed_tools: list[str] | None = None,
        approval_tools: list[str] | None = None,
        on_behalf_of: str | None = None,
        task_id: str | None = None,
        conversation_id: str | None = None,
        now: float | None = None,
    ) -> tuple[str, str, int]:
        """Return (token, kid, expires_in). Signs with the current key."""
        issued = int(now if now is not None else time.time())
        claims: dict[str, Any] = {
            "iss": iss or self.iss,
            "aud": aud or self.aud,
            "sub": sub,
            "org_id": org_id,
            "role": role,
            "iat": issued,
            "exp": issued + self.ttl,
            "jti": uuid.uuid4().hex,
            "token_type": token_type,
        }
        if token_type == "task":
            claims["allowed_tools"] = allowed_tools or []
            claims["approval_tools"] = approval_tools or []
            if on_behalf_of is not None:
                claims["on_behalf_of"] = on_behalf_of
            if task_id is not None:
                claims["task_id"] = task_id
            if conversation_id is not None:
                claims["conversation_id"] = conversation_id

        key = self.keystore.current
        token = jwt_rs256.sign(claims, kid=key.kid, private_key=key.private_key)
        return token, key.kid, self.ttl

    # ---------------------------------------------------------- verification
    def verify(self, token: str, *, leeway: int = 0, now: float | None = None) -> dict[str, Any]:
        """Fail-closed verify against the active JWKS. Raises jwt_rs256.JWTError."""
        return jwt_rs256.verify(
            token,
            public_keys=self.keystore.public_keys(),
            iss=self.iss,
            aud=self.aud,
            leeway=leeway,
            now=now,
        )

    def rotate(self):
        return self.keystore.rotate()

    def jwks(self) -> dict:
        return self.keystore.jwks()


# Module-level default instance for the importable verify path + the FastAPI app.
_default: AuthService | None = None


def get_service() -> AuthService:
    global _default
    if _default is None:
        _default = AuthService()
    return _default


def verify_token(token: str, *, leeway: int = 0) -> dict[str, Any]:
    """Importable fail-closed verifier for other services (§13.4)."""
    return get_service().verify(token, leeway=leeway)
