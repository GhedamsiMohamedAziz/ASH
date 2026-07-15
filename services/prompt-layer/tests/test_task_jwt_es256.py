"""ES256 TASK JWT minting — config-gated seam (§13.4, ADR-012).

HS256 stays the default; ES256 is opt-in via TASK_JWT_ALG. The committed vector under
packages/shared-ts/test/fixtures is the SAME token the TS gateway suite verifies, proving
cross-language agreement on the P-256/JOSE ES256 bytes.
"""
from __future__ import annotations

import base64
import json
from pathlib import Path

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.asymmetric.utils import encode_dss_signature

from app import task_jwt
from olma_shared import jwt as hs_jwt

FIX = Path(__file__).resolve().parents[3] / "packages" / "shared-ts" / "test" / "fixtures"
PRIV = FIX / "task-jwt-es256.private.test.pem"
JWKS = json.loads((FIX / "task-jwt-es256.jwks.test.json").read_text())
VECTOR = json.loads((FIX / "task-jwt-es256.vector.test.json").read_text())

CLAIMS = {
    "sub": "usr_1", "org_id": "org_1",
    "iss": "olma-prompt-layer", "aud": "olma-mcp-gateway",
    "iat": 1000, "exp": 9999999999,
    "allowed_tools": ["github.search"], "approval_tools": [],
    "task_id": "t1", "origin": "interactive",
}


def _b64u_decode(s: str) -> bytes:
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _public_key_for_kid(kid: str) -> ec.EllipticCurvePublicKey:
    jwk = next(k for k in JWKS["keys"] if k["kid"] == kid)
    x = int.from_bytes(_b64u_decode(jwk["x"]), "big")
    y = int.from_bytes(_b64u_decode(jwk["y"]), "big")
    return ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1()).public_key()


def _verify_es256(token: str) -> dict:
    """Fail-closed ES256 verify against the fixture JWKS (JOSE raw R||S -> DER)."""
    h_seg, p_seg, s_seg = token.split(".")
    header = json.loads(_b64u_decode(h_seg))
    assert header["alg"] == "ES256"
    pub = _public_key_for_kid(header["kid"])
    raw = _b64u_decode(s_seg)
    r = int.from_bytes(raw[:32], "big")
    s = int.from_bytes(raw[32:], "big")
    der = encode_dss_signature(r, s)
    pub.verify(der, f"{h_seg}.{p_seg}".encode("ascii"), ec.ECDSA(hashes.SHA256()))
    return json.loads(_b64u_decode(p_seg))


# ---------------------------------------------------------------- default stays HS256
def test_default_alg_is_hs256(monkeypatch):
    monkeypatch.delenv("TASK_JWT_ALG", raising=False)
    assert task_jwt.alg() == "HS256"
    token = task_jwt.mint(dict(CLAIMS))
    header = json.loads(_b64u_decode(token.split(".")[0]))
    assert header["alg"] == "HS256"
    # Still verifiable with the shared-secret HS256 path (unchanged dev behaviour).
    claims = hs_jwt.verify(token, task_jwt.TASK_JWT_SECRET, iss="olma-prompt-layer",
                           aud="olma-mcp-gateway", now=1000)
    assert claims["sub"] == "usr_1"


# ---------------------------------------------------------------- ES256 mint round-trip
def _enable_es256(monkeypatch, kid="task-2026-07"):
    monkeypatch.setenv("TASK_JWT_ALG", "ES256")
    monkeypatch.setenv("TASK_JWT_EC_PRIVATE_KEY_PATH", str(PRIV))
    monkeypatch.setenv("TASK_JWT_KID", kid)


def test_es256_mint_and_self_verify(monkeypatch):
    _enable_es256(monkeypatch)
    assert task_jwt.alg() == "ES256"
    token = task_jwt.mint(dict(CLAIMS))
    header = json.loads(_b64u_decode(token.split(".")[0]))
    assert header == {"alg": "ES256", "typ": "JWT", "kid": "task-2026-07"}
    claims = _verify_es256(token)  # raises on any signature problem
    assert claims["sub"] == "usr_1"
    assert claims["allowed_tools"] == ["github.search"]


def test_es256_committed_vector_verifies(monkeypatch):
    # The vector was minted by this same production signer; verifying it here (and in the
    # TS suite) proves both languages agree on the identical bytes.
    claims = _verify_es256(VECTOR["token"])
    assert claims == VECTOR["claims"]
    assert json.loads(_b64u_decode(VECTOR["token"].split(".")[0]))["kid"] == VECTOR["kid"]


# ---------------------------------------------------------------- fail-closed config
def test_es256_requires_key_path(monkeypatch):
    monkeypatch.setenv("TASK_JWT_ALG", "ES256")
    monkeypatch.delenv("TASK_JWT_EC_PRIVATE_KEY_PATH", raising=False)
    monkeypatch.setenv("TASK_JWT_KID", "task-2026-07")
    with pytest.raises(ValueError):
        task_jwt.mint(dict(CLAIMS))


def test_es256_requires_kid(monkeypatch):
    monkeypatch.setenv("TASK_JWT_ALG", "ES256")
    monkeypatch.setenv("TASK_JWT_EC_PRIVATE_KEY_PATH", str(PRIV))
    monkeypatch.delenv("TASK_JWT_KID", raising=False)
    with pytest.raises(ValueError):
        task_jwt.mint(dict(CLAIMS))


def test_unsupported_alg_rejected(monkeypatch):
    monkeypatch.setenv("TASK_JWT_ALG", "none")
    with pytest.raises(ValueError):
        task_jwt.mint(dict(CLAIMS))
