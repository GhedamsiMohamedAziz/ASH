"""RS256 JWT sign/verify + JWK encoding (instructions.md §13.4, §8.1).

Asymmetric JWTs so any service can verify with the public JWKS and no shared
secret (unlike the HS256 `olma_shared.jwt`). Fail-closed everywhere: any
signature/claim/format problem raises; `alg:none` and unknown algs are rejected.
"""

from __future__ import annotations

import base64
import json
import time
from typing import Any

from cryptography.exceptions import InvalidSignature as _CryptoInvalidSignature
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey, RSAPublicKey

ALG = "RS256"


class JWTError(Exception):
    """Base for all token failures (fail-closed)."""


class InvalidSignature(JWTError):
    pass


class ExpiredToken(JWTError):
    pass


class InvalidClaim(JWTError):
    pass


class UnknownKey(JWTError):
    pass


# --------------------------------------------------------------- base64url
def b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def b64u_decode(s: str) -> bytes:
    pad = "=" * (-len(s) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _int_to_b64u(value: int) -> str:
    length = (value.bit_length() + 7) // 8
    return b64u_encode(value.to_bytes(length, "big"))


# --------------------------------------------------------------- JWK encoding
def public_key_to_jwk(public_key: RSAPublicKey, kid: str) -> dict[str, str]:
    """Encode an RSA public key as a standard JWK (RFC 7517 / 7518)."""
    numbers = public_key.public_numbers()
    return {
        "kty": "RSA",
        "use": "sig",
        "alg": ALG,
        "kid": kid,
        "n": _int_to_b64u(numbers.n),
        "e": _int_to_b64u(numbers.e),
    }


# --------------------------------------------------------------- sign
def sign(payload: dict[str, Any], *, kid: str, private_key: RSAPrivateKey) -> str:
    """Mint a compact RS256 JWT with `kid` in the header."""
    header = {"alg": ALG, "typ": "JWT", "kid": kid}
    seg = [
        b64u_encode(json.dumps(header, separators=(",", ":")).encode()),
        b64u_encode(json.dumps(payload, separators=(",", ":")).encode()),
    ]
    signing_input = ".".join(seg).encode("ascii")
    sig = private_key.sign(signing_input, padding.PKCS1v15(), hashes.SHA256())
    seg.append(b64u_encode(sig))
    return ".".join(seg)


# --------------------------------------------------------------- verify
def decode_header(token: str) -> dict[str, Any]:
    try:
        h_seg = token.split(".", 1)[0]
        return json.loads(b64u_decode(h_seg))
    except Exception as e:  # noqa: BLE001 — any decode problem is fatal, fail-closed
        raise JWTError("undecodable header") from e


def verify(
    token: str,
    *,
    public_keys: dict[str, RSAPublicKey],
    iss: str | None = None,
    aud: str | None = None,
    leeway: int = 0,
    now: float | None = None,
) -> dict[str, Any]:
    """Verify signature against the JWKS + standard claims. Raises on any problem.

    `public_keys` maps `kid` -> public key (the active JWKS). A token whose `kid`
    is not present is rejected (no fallback, §13.4). Returns the claims on success.
    """
    parts = token.split(".")
    if len(parts) != 3:
        raise JWTError("malformed token")
    h_seg, p_seg, s_seg = parts

    try:
        header = json.loads(b64u_decode(h_seg))
        claims = json.loads(b64u_decode(p_seg))
        given_sig = b64u_decode(s_seg)
    except Exception as e:  # noqa: BLE001
        raise JWTError("undecodable token") from e

    if header.get("alg") != ALG:  # never accept 'none' or an unexpected alg
        raise JWTError(f"unexpected alg: {header.get('alg')!r}")

    kid = header.get("kid")
    if not kid or kid not in public_keys:  # unknown kid → fail-closed
        raise UnknownKey(f"unknown kid: {kid!r}")

    signing_input = f"{h_seg}.{p_seg}".encode("ascii")
    try:
        public_keys[kid].verify(given_sig, signing_input, padding.PKCS1v15(), hashes.SHA256())
    except _CryptoInvalidSignature as e:
        raise InvalidSignature("signature mismatch") from e

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


def new_rsa_keypair() -> RSAPrivateKey:
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)
