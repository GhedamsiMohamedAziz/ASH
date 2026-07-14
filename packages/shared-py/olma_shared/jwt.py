"""Dependency-free HS256 JWT sign/verify (instructions.md §13.4).

Used for internal service-to-service and TASK JWTs in dev. Fail-closed: any
signature/claim problem raises, never returns a partial result. The auth-service
(AX-006) issues the production RS256 tokens with JWKS; this HS256 helper covers
dev and the shared verify path.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import time


class JWTError(Exception):
    """Base for all token failures (fail-closed)."""


class InvalidSignature(JWTError):
    pass


class ExpiredToken(JWTError):
    pass


class InvalidClaim(JWTError):
    pass


def _b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def sign(payload: dict, secret: str, *, alg: str = "HS256") -> str:
    if alg != "HS256":
        raise JWTError(f"unsupported alg: {alg}")
    header = {"alg": alg, "typ": "JWT"}
    seg = [
        _b64u_encode(json.dumps(header, separators=(",", ":")).encode()),
        _b64u_encode(json.dumps(payload, separators=(",", ":")).encode()),
    ]
    signing_input = ".".join(seg).encode("ascii")
    sig = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    seg.append(_b64u_encode(sig))
    return ".".join(seg)


def verify(
    token: str,
    secret: str,
    *,
    iss: str | None = None,
    aud: str | None = None,
    leeway: int = 0,
    now: float | None = None,
) -> dict:
    """Verify signature + standard claims. Raises on any problem; returns claims."""
    try:
        h_seg, p_seg, s_seg = token.split(".")
    except ValueError as e:
        raise JWTError("malformed token") from e

    signing_input = f"{h_seg}.{p_seg}".encode("ascii")
    try:
        header = json.loads(_b64u_decode(h_seg))
        claims = json.loads(_b64u_decode(p_seg))
        given_sig = _b64u_decode(s_seg)
    except Exception as e:
        raise JWTError("undecodable token") from e

    if header.get("alg") != "HS256":
        raise JWTError(f"unexpected alg: {header.get('alg')}")  # no 'none' bypass

    expected = hmac.new(secret.encode(), signing_input, hashlib.sha256).digest()
    if not hmac.compare_digest(expected, given_sig):
        raise InvalidSignature("signature mismatch")

    ts = time.time() if now is None else now
    if "exp" in claims and ts > float(claims["exp"]) + leeway:
        raise ExpiredToken("token expired")
    if "nbf" in claims and ts + leeway < float(claims["nbf"]):
        raise InvalidClaim("token not yet valid")
    if iss is not None and claims.get("iss") != iss:
        raise InvalidClaim("issuer mismatch")
    if aud is not None and claims.get("aud") != aud:
        raise InvalidClaim("audience mismatch")
    return claims
