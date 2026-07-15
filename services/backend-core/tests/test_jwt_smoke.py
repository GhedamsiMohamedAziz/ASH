"""AX-009 end-to-end JWT smoke: auth-service RS256 mint → protected route (§5, §8.1).

/whoami is unified on auth-service's RS256 verifier (no shared secret); tokens are
minted here by the SAME auth-service, offline, against its on-disk JWKS.
"""
from fastapi.testclient import TestClient
from app.main import app
from app.identity import get_auth_service

client = TestClient(app)
_auth = get_auth_service()


def _token(**over):
    token, _kid, _exp = _auth.mint(
        sub=over.get("sub", "usr_7"), org_id=over.get("org_id", "org_1"),
        iss=over.get("iss"), aud=over.get("aud"),
    )
    return token


def test_valid_jwt_authorizes():
    r = client.get("/api/v1/whoami", headers={"Authorization": f"Bearer {_token()}"})
    assert r.status_code == 200 and r.json()["user_id"] == "usr_7"


def test_missing_token_rejected():
    assert client.get("/api/v1/whoami").status_code == 401


def test_forged_token_rejected():
    bad = _token()[:-4] + "aaaa"
    assert client.get("/api/v1/whoami", headers={"Authorization": f"Bearer {bad}"}).status_code == 401


def test_wrong_issuer_rejected():
    r = client.get("/api/v1/whoami", headers={"Authorization": f"Bearer {_token(iss='evil')}"})
    assert r.status_code == 401
