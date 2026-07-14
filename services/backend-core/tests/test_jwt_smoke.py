"""AX-009 end-to-end JWT smoke: adapter → signed JWT → protected route (§5, §8.1)."""
import sys, time; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages" / "shared-py"))
from fastapi.testclient import TestClient
from app.main import app
from olma_shared import jwt

client = TestClient(app)
SECRET = "dev-session-secret"

def _token(**over):
    now = int(time.time())
    claims = {"sub": "usr_7", "org_id": "org_1", "iss": "olma-auth", "aud": "olma-internal",
              "iat": now, "exp": now + 900}
    claims.update(over)
    return jwt.sign(claims, SECRET)

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
