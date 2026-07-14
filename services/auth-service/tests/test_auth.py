"""auth-service tests: mint/verify, JWKS, fail-closed rejects, rotation, TASK JWT.

Each test uses a throwaway keys dir (tmp_path) so nothing touches the dev keys.
"""

from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient

from app import jwt_rs256
from app.jwt_rs256 import b64u_decode, b64u_encode
from app.service import AuthService


@pytest.fixture
def svc(tmp_path):
    return AuthService(keys_dir=tmp_path / "keys", iss="olma-auth", aud="olma-internal", ttl_seconds=900)


@pytest.fixture
def client(tmp_path, monkeypatch):
    """TestClient whose app is backed by an isolated tmp keystore."""
    from app import main

    isolated = AuthService(keys_dir=tmp_path / "http-keys")
    monkeypatch.setattr(main, "auth", isolated)
    return TestClient(main.app)


# --------------------------------------------------------------- roundtrip
def test_mint_verify_roundtrip(svc):
    token, kid, expires_in = svc.mint(sub="usr_1", org_id="org_a", role="admin")
    assert expires_in == 900
    claims = svc.verify(token)
    assert claims["sub"] == "usr_1"
    assert claims["org_id"] == "org_a"
    assert claims["role"] == "admin"
    assert claims["iss"] == "olma-auth"
    assert claims["aud"] == "olma-internal"
    assert claims["exp"] - claims["iat"] == 900
    # kid rides in the header
    assert jwt_rs256.decode_header(token)["kid"] == kid
    assert jwt_rs256.decode_header(token)["alg"] == "RS256"


def test_ttl_is_15_minutes(svc):
    token, _, _ = svc.mint(sub="usr_1", org_id="org_a")
    claims = svc.verify(token)
    assert claims["exp"] - claims["iat"] == 15 * 60


# --------------------------------------------------------------- JWKS
def test_jwks_contains_signing_kid(svc):
    token, kid, _ = svc.mint(sub="usr_1", org_id="org_a")
    jwks = svc.jwks()
    kids = [k["kid"] for k in jwks["keys"]]
    assert kid in kids
    jwk = next(k for k in jwks["keys"] if k["kid"] == kid)
    assert jwk["kty"] == "RSA"
    assert jwk["use"] == "sig"
    assert jwk["alg"] == "RS256"
    assert jwk["n"] and jwk["e"]


# --------------------------------------------------------------- fail-closed
def test_verify_rejects_expired_token(svc):
    token, _, _ = svc.mint(sub="usr_1", org_id="org_a", now=time.time() - 10_000)
    with pytest.raises(jwt_rs256.ExpiredToken):
        svc.verify(token)


def test_verify_rejects_wrong_issuer(svc):
    token, _, _ = svc.mint(sub="usr_1", org_id="org_a", iss="evil")
    with pytest.raises(jwt_rs256.InvalidClaim):
        svc.verify(token)


def test_verify_rejects_wrong_audience(svc):
    token, _, _ = svc.mint(sub="usr_1", org_id="org_a", aud="someone-else")
    with pytest.raises(jwt_rs256.InvalidClaim):
        svc.verify(token)


def test_verify_rejects_alg_none(svc):
    """A crafted alg:none token (unsigned) must never be accepted (§5)."""
    kid = svc.keystore.current.kid
    header = {"alg": "none", "typ": "JWT", "kid": kid}
    payload = {"iss": "olma-auth", "aud": "olma-internal", "sub": "attacker", "org_id": "org_a", "exp": time.time() + 999}
    forged = (
        b64u_encode(json.dumps(header).encode())
        + "."
        + b64u_encode(json.dumps(payload).encode())
        + "."
    )
    with pytest.raises(jwt_rs256.JWTError):
        svc.verify(forged)


def test_verify_rejects_unknown_kid(svc):
    """A token whose kid isn't in the JWKS is rejected — no fallback (§13.4)."""
    token, _, _ = svc.mint(sub="usr_1", org_id="org_a")
    h_seg, p_seg, s_seg = token.split(".")
    header = json.loads(b64u_decode(h_seg))
    header["kid"] = "auth-does-not-exist"
    tampered = b64u_encode(json.dumps(header).encode()) + "." + p_seg + "." + s_seg
    with pytest.raises(jwt_rs256.UnknownKey):
        svc.verify(tampered)


def test_verify_rejects_wrong_key_signature(tmp_path):
    """A token signed by a different keypair (right kid, wrong key) fails signature."""
    svc_a = AuthService(keys_dir=tmp_path / "a")
    token, kid, _ = svc_a.mint(sub="usr_1", org_id="org_a")
    # Build a second store, then verify svc_a's token against ONLY svc_b's key but
    # under the attacker-supplied kid so the lookup succeeds and signature fails.
    svc_b = AuthService(keys_dir=tmp_path / "b")
    other_pub = svc_b.keystore.current.public_key
    with pytest.raises(jwt_rs256.InvalidSignature):
        jwt_rs256.verify(token, public_keys={kid: other_pub}, iss=svc_a.iss, aud=svc_a.aud)


def test_verify_rejects_tampered_payload(svc):
    token, _, _ = svc.mint(sub="usr_1", org_id="org_a", role="member")
    h_seg, p_seg, s_seg = token.split(".")
    claims = json.loads(b64u_decode(p_seg))
    claims["role"] = "admin"  # privilege escalation attempt
    tampered = h_seg + "." + b64u_encode(json.dumps(claims).encode()) + "." + s_seg
    with pytest.raises(jwt_rs256.InvalidSignature):
        svc.verify(tampered)


# --------------------------------------------------------------- rotation
def test_rotation_old_token_still_verifies_and_jwks_has_two_keys(svc):
    old_token, old_kid, _ = svc.mint(sub="usr_1", org_id="org_a")
    assert len(svc.jwks()["keys"]) == 1

    new_key = svc.rotate()
    assert new_key.kid != old_kid

    # JWKS now advertises both the new (current) and old (previous) key.
    kids = [k["kid"] for k in svc.jwks()["keys"]]
    assert len(kids) == 2
    assert new_key.kid in kids and old_kid in kids

    # The token minted BEFORE rotation still verifies during the overlap window.
    claims = svc.verify(old_token)
    assert claims["sub"] == "usr_1"

    # New tokens are signed with the new kid.
    new_token, kid, _ = svc.mint(sub="usr_2", org_id="org_a")
    assert kid == new_key.kid
    assert jwt_rs256.decode_header(new_token)["kid"] == new_key.kid


def test_second_rotation_drops_oldest_key(svc):
    tok1, kid1, _ = svc.mint(sub="usr_1", org_id="org_a")
    svc.rotate()  # kid1 -> previous
    svc.rotate()  # kid1 falls out of the overlap window
    kids = [k["kid"] for k in svc.jwks()["keys"]]
    assert kid1 not in kids
    with pytest.raises(jwt_rs256.UnknownKey):
        svc.verify(tok1)


# --------------------------------------------------------------- TASK JWT
def test_task_jwt_carries_tool_scopes_and_on_behalf_of(svc):
    token, _, _ = svc.mint(
        sub="agent-org@org_a",
        org_id="org_a",
        role="agent",
        token_type="task",
        allowed_tools=["github.*", "browser.read_*"],
        approval_tools=["github.merge_pr"],
        on_behalf_of="usr_mehdi",
        task_id="task_01H8",
        conversation_id="conv_9b2c",
    )
    claims = svc.verify(token)
    assert claims["token_type"] == "task"
    assert claims["allowed_tools"] == ["github.*", "browser.read_*"]
    assert claims["approval_tools"] == ["github.merge_pr"]
    assert claims["on_behalf_of"] == "usr_mehdi"
    assert claims["task_id"] == "task_01H8"
    assert claims["conversation_id"] == "conv_9b2c"


def test_importable_verify_token(tmp_path, monkeypatch):
    """The module-level verify_token() uses the default service (§13.4)."""
    from app import service

    monkeypatch.setattr(service, "_default", AuthService(keys_dir=tmp_path / "keys"))
    token, _, _ = service.get_service().mint(sub="usr_1", org_id="org_a")
    claims = service.verify_token(token)
    assert claims["sub"] == "usr_1"


# --------------------------------------------------------------- HTTP surface
def test_http_jwks_mint_verify_rotate_flow(client):
    jwks = client.get("/.well-known/jwks.json").json()
    assert len(jwks["keys"]) == 1
    assert jwks["keys"][0]["kty"] == "RSA"

    minted = client.post("/token", json={"sub": "usr_1", "org_id": "org_a", "role": "admin"}).json()
    old_token = minted["token"]

    verified = client.post("/verify", json={"token": old_token})
    assert verified.status_code == 200
    assert verified.json()["claims"]["sub"] == "usr_1"

    rotated = client.post("/admin/rotate").json()
    assert rotated["rotated"] is True
    assert len(rotated["jwks_kids"]) == 2

    # Old token still verifies after rotation.
    reverified = client.post("/verify", json={"token": old_token})
    assert reverified.status_code == 200
    assert reverified.json()["claims"]["sub"] == "usr_1"

    # JWKS endpoint now lists 2 kids.
    assert len(client.get("/.well-known/jwks.json").json()["keys"]) == 2


def test_http_verify_rejects_garbage_fail_closed(client):
    r = client.post("/verify", json={"token": "not.a.jwt"})
    assert r.status_code == 401
    assert r.json()["valid"] is False


def test_http_oidc_dev_login_issues_valid_token(client):
    r = client.post("/oidc/dev-login", json={"sub": "usr_slack_1", "org_id": "org_a", "email": "a@b.co"})
    assert r.status_code == 200
    token = r.json()["token"]
    assert client.post("/verify", json={"token": token}).status_code == 200
