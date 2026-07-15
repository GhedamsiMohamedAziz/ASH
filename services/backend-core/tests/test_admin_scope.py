"""Cross-tenant scoping for GET /admin/audit and /admin/usage (§24.1, §24.3).

The defect (FIX 1): the routes discarded the verified claims and passed the raw ?org= query
param straight to the store, letting an org admin read ANY org's audit_log/usage_daily via
?org=org_B (or omit → all orgs). These tests pin the fix: an org admin is ALWAYS forced to
their own org; only a platform_admin may target another org (or all orgs).

No live Postgres needed — a capture-DB stands in for store.db and records the org_id filter the
route actually passes down, which is exactly what the vulnerability turned on.
"""

import pytest
from fastapi.testclient import TestClient

from app import main
from app.main import app, store
from app.identity import get_auth_service


class _CaptureDB:
    """Stands in for PgStore; records the org_id filter each admin read is called with."""

    def __init__(self) -> None:
        self.audit_org = "__unset__"
        self.usage_org = "__unset__"

    async def list_audit_log(self, org_id=None):
        self.audit_org = org_id
        return []

    async def list_usage_daily(self, org_id=None, day=None):
        self.usage_org = org_id
        return []


@pytest.fixture
def capture_db(monkeypatch):
    db = _CaptureDB()
    monkeypatch.setattr(store, "db", db)
    return db


@pytest.fixture
def client():
    return TestClient(app)


def _admin(sub: str, org: str) -> dict:
    token, _kid, _exp = get_auth_service().mint(sub=sub, org_id=org, role="admin")
    return {"Authorization": f"Bearer {token}"}


def _platform_admin(monkeypatch):
    # mint() carries no platform_admin claim, so stub the verifier for this dedicated claim (§24.1).
    monkeypatch.setattr(main, "verify_token", lambda tok: {
        "sub": "usr_root", "org_id": "org_platform", "role": "admin", "platform_admin": True})
    return {"Authorization": "Bearer platform"}


# --------------------------------------------------------------- org admin is forced to own org
def test_org_admin_cannot_target_other_org_audit(client, capture_db):
    r = client.get("/api/v1/admin/audit?org=org_B", headers=_admin("usr_a", "org_A"))
    assert r.status_code == 200
    assert capture_db.audit_org == "org_A", "org admin's ?org=org_B must be ignored (own org only)"


def test_org_admin_omitting_org_is_not_all_orgs_audit(client, capture_db):
    r = client.get("/api/v1/admin/audit", headers=_admin("usr_a", "org_A"))
    assert r.status_code == 200
    assert capture_db.audit_org == "org_A", "org admin omitting ?org must NOT read all orgs (None)"


def test_org_admin_cannot_target_other_org_usage(client, capture_db):
    r = client.get("/api/v1/admin/usage?org=org_B", headers=_admin("usr_a", "org_A"))
    assert r.status_code == 200
    assert capture_db.usage_org == "org_A"


def test_org_admin_omitting_org_is_not_all_orgs_usage(client, capture_db):
    r = client.get("/api/v1/admin/usage", headers=_admin("usr_a", "org_A"))
    assert r.status_code == 200
    assert capture_db.usage_org == "org_A"


# --------------------------------------------------------------- platform_admin may span orgs
def test_platform_admin_can_target_another_org(client, capture_db, monkeypatch):
    h = _platform_admin(monkeypatch)
    r = client.get("/api/v1/admin/audit?org=org_B", headers=h)
    assert r.status_code == 200
    assert capture_db.audit_org == "org_B", "platform_admin may target another org"


def test_platform_admin_omitting_org_sees_all(client, capture_db, monkeypatch):
    h = _platform_admin(monkeypatch)
    r = client.get("/api/v1/admin/usage", headers=h)
    assert r.status_code == 200
    assert capture_db.usage_org is None, "platform_admin omitting ?org reads all orgs (None)"
