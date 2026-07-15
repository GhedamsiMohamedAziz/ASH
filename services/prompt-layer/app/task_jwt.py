"""TASK JWT minting — config-gated HS256 (dev default) / ES256 (opt-in) seam.

instructions.md §13.4, ADR-012 (§0.7). The prompt-layer mints the short-lived TASK
JWT the sandbox presents to the MCP Gateway. HS256 with the shared dev secret stays
the DEFAULT so the offline/keyless dev + test path is unchanged; setting
``TASK_JWT_ALG=ES256`` switches minting to P-256 ECDSA (JOSE ES256) using a PEM private
key, and stamps ``kid`` in the header so the Gateway can select the verifying key from
its JWKS (2-key current+next rotation, §13.4).

Fail-closed: a misconfigured ES256 mode raises — it never silently falls back to HS256.
Wire-compatible with ``packages/shared-ts/src/jwt.ts`` (the Gateway verifier). ES256 uses
the same ``cryptography`` library the auth-service already uses for RS256 — no new dep.

Env:
- ``TASK_JWT_ALG``                 — ``HS256`` (default) | ``ES256``
- ``TASK_JWT_EC_PRIVATE_KEY_PATH`` — PEM P-256 private key (required for ES256)
- ``TASK_JWT_KID``                 — key id stamped in the header (required for ES256)
"""

from __future__ import annotations

import base64
import json
import os

from olma_shared import jwt

# Dev signing secret for the internal TASK JWT (HS256 default). Prod opts into ES256 +
# JWKS (§13.4); the claims set is identical across algorithms.
TASK_JWT_SECRET = "dev-task-jwt-secret"


def alg() -> str:
    return os.environ.get("TASK_JWT_ALG", "HS256")


def _b64u_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def mint(claims: dict) -> str:
    """Sign the TASK JWT under the configured algorithm. Default HS256; ES256 opt-in."""
    a = alg()
    if a == "HS256":
        return jwt.sign(claims, TASK_JWT_SECRET)
    if a == "ES256":
        return _sign_es256(claims)
    raise ValueError(f"unsupported TASK_JWT_ALG: {a}")  # fail-closed, no fallback


def _sign_es256(claims: dict) -> str:
    """Mint a compact ES256 (P-256 / ECDSA SHA-256) JWT with `kid` in the header.

    `cryptography` produces a DER-encoded ECDSA signature; JOSE ES256 requires the raw
    R||S (IEEE P1363, 64 bytes) form, so we re-encode. Imported lazily so the default
    HS256 path carries no crypto dependency at import time.
    """
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature

    key_path = os.environ.get("TASK_JWT_EC_PRIVATE_KEY_PATH")
    kid = os.environ.get("TASK_JWT_KID")
    if not key_path:
        raise ValueError("TASK_JWT_EC_PRIVATE_KEY_PATH must be set when TASK_JWT_ALG=ES256")
    if not kid:
        raise ValueError("TASK_JWT_KID must be set when TASK_JWT_ALG=ES256")

    with open(key_path, "rb") as fh:
        private_key = serialization.load_pem_private_key(fh.read(), password=None)
    if not isinstance(private_key, ec.EllipticCurvePrivateKey) or private_key.curve.name != "secp256r1":
        raise ValueError("TASK_JWT_EC_PRIVATE_KEY_PATH must be a P-256 (secp256r1) EC private key")

    header = {"alg": "ES256", "typ": "JWT", "kid": kid}
    seg = [
        _b64u_encode(json.dumps(header, separators=(",", ":")).encode()),
        _b64u_encode(json.dumps(claims, separators=(",", ":")).encode()),
    ]
    signing_input = ".".join(seg).encode("ascii")
    der_sig = private_key.sign(signing_input, ec.ECDSA(hashes.SHA256()))
    r, s = decode_dss_signature(der_sig)
    raw_sig = r.to_bytes(32, "big") + s.to_bytes(32, "big")  # JOSE R||S, fixed 32-byte halves
    seg.append(_b64u_encode(raw_sig))
    return ".".join(seg)
