"""Tests for GET /api/v1/tool_policies (§2.6) — the caller's REAL enforced approval matrix,
replacing the frontend's previous hardcoded org_1 literal (agentConfig.ts). Mirrors
test_admin_data.py's DB-backed/graceful-empty split: seeded rows come back for a real org+role
when DATABASE_URL is set (live Postgres, db/migrations/0003_seed_policies.sql seeds org_1); a
well-formed empty list otherwise.
"""

import os

import pytest
from fastapi.testclient import TestClient

from app.main import app, store
from app.identity import get_auth_service

DSN = os.getenv("DATABASE_URL")


@pytest.fixture(autouse=True)
def _reset():
    store.conversations.clear()
    store.idempotency.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


def _bearer(sub: str, org_id: str, role: str = "member") -> dict:
    token, _kid, _exp = get_auth_service().mint(sub=sub, org_id=org_id, role=role)
    return {"Authorization": f"Bearer {token}"}


def test_tool_policies_well_formed_empty_without_database(client):
    r = client.get("/api/v1/tool_policies", headers=_bearer("usr_1", "org_1", role="member"))
    assert r.status_code == 200
    assert r.json() == {"items": []}


def test_tool_policies_empty_without_database_for_header_less_dev_identity(client):
    # No bearer token -> dev identity (usr_dev/org_1) + default role 'member' — still tolerant.
    r = client.get("/api/v1/tool_policies")
    assert r.status_code == 200
    assert r.json() == {"items": []}


@pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres)")
def test_tool_policies_returns_seeded_rows_for_org_1_member():
    with TestClient(app) as c:
        r = c.get("/api/v1/tool_policies", headers=_bearer("usr_a", "org_1", role="member"))
        assert r.status_code == 200
        items = r.json()["items"]
        by_tool = {row["tool_pattern"]: row for row in items}
        # Seeded by db/migrations/0003_seed_policies.sql (org_1, member).
        assert by_tool["github.merge_pr"]["effect"] == "require_approval"
        assert by_tool["github.merge_pr"]["approver_group"] == "tech-leads"
        assert by_tool["database.write"]["effect"] == "deny"
        assert by_tool["scheduler.create_cron"]["effect"] == "require_approval"
        # Ordered by tool_pattern ASC.
        patterns = [row["tool_pattern"] for row in items]
        assert patterns == sorted(patterns)


@pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres)")
def test_tool_policies_scoped_to_caller_org_and_role():
    with TestClient(app) as c:
        # power_user sees the power_user matrix, not the member one (github.* allow, not
        # github.merge_pr require_approval as the ONLY github rule).
        r = c.get("/api/v1/tool_policies", headers=_bearer("usr_a", "org_1", role="power_user"))
        assert r.status_code == 200
        by_tool = {row["tool_pattern"]: row for row in r.json()["items"]}
        assert by_tool["github.*"]["effect"] == "allow"
        assert "github.search" not in by_tool  # that's a member-role row, not power_user

        # An org with no seeded rows at all -> well-formed empty, not a fallback to org_1.
        r2 = c.get("/api/v1/tool_policies", headers=_bearer("usr_z", "org_zzz_nope", role="member"))
        assert r2.status_code == 200
        assert r2.json() == {"items": []}
