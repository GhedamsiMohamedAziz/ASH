"""Tests for GET /api/v1/admin/audit and GET /api/v1/admin/usage (§24.1, §24.3) — the two
admin console collections backed by REAL tables already owned by backend-core (audit_log,
usage_daily from db/migrations/0001_init.sql), as opposed to users/sandboxes/automations
which stay well-formed-empty pending cross-service sources.

DB-backed assertions (seeded audit_log/usage_daily rows come back paginated) skip
gracefully when DATABASE_URL is unset, matching test_automations.py / test_rls_isolation.py.
"""

import os
import uuid

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


# --------------------------------------------------------------- gating (no DB required)
def test_admin_audit_requires_bearer_token(client):
    r = client.get("/api/v1/admin/audit")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_admin_audit_rejects_member_role(client):
    r = client.get("/api/v1/admin/audit", headers=_bearer("usr_1", "org_1", role="member"))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_PERM_TOOL_DENIED"


def test_admin_audit_well_formed_empty_without_database(client):
    r = client.get("/api/v1/admin/audit", headers=_bearer("usr_a", "org_1", role="admin"))
    assert r.status_code == 200
    assert r.json() == {"items": [], "next_cursor": None}


def test_admin_usage_requires_bearer_token(client):
    r = client.get("/api/v1/admin/usage")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_admin_usage_rejects_member_role(client):
    r = client.get("/api/v1/admin/usage", headers=_bearer("usr_1", "org_1", role="member"))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_PERM_TOOL_DENIED"


def test_admin_usage_well_formed_empty_without_database(client):
    r = client.get("/api/v1/admin/usage", headers=_bearer("usr_a", "org_1", role="admin"))
    assert r.status_code == 200
    assert r.json() == {"items": [], "next_cursor": None}


# --------------------------------------------------------------- real reads (live Postgres)
@pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres)")
def test_admin_audit_returns_seeded_row_paginated():
    import asyncio
    import asyncpg

    prefix = f"github.merge_pr_{uuid.uuid4().hex[:8]}"
    target1, target2 = f"{prefix}_1", f"{prefix}_2"

    async def seed():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES ('org_1','org_1') ON CONFLICT DO NOTHING")
            # Two rows (distinct ts) so limit=1 has a real second page to round-trip to.
            await con.execute(
                """INSERT INTO audit_log(ts, user_id, org_id, actor, action, target, details)
                   VALUES(now() - interval '1 second','usr_1','org_1','user','tool.call',
                          $1,'{"status":"ok"}'::jsonb)""",
                target1,
            )
            await con.execute(
                """INSERT INTO audit_log(user_id, org_id, actor, action, target, details)
                   VALUES('usr_1','org_1','user','tool.call',$1,'{"status":"ok"}'::jsonb)""",
                target2,
            )
        finally:
            await con.close()

    async def cleanup():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute("DELETE FROM audit_log WHERE target IN ($1,$2)", target1, target2)
        finally:
            await con.close()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(seed())
        try:
            with TestClient(app) as c:
                token, _, _ = get_auth_service().mint(sub="usr_a", org_id="org_1", role="admin")
                r = c.get("/api/v1/admin/audit", headers={"Authorization": f"Bearer {token}"})
                assert r.status_code == 200
                body = r.json()
                assert any(row["target"] == target1 for row in body["items"]), \
                    "seeded audit_log row not returned"
                seeded = next(row for row in body["items"] if row["target"] == target2)
                assert seeded["details"] == {"status": "ok"}
                # ts DESC, id DESC: the later-inserted row (target2) comes first.
                idx1 = next(i for i, row in enumerate(body["items"]) if row["target"] == target1)
                idx2 = next(i for i, row in enumerate(body["items"]) if row["target"] == target2)
                assert idx2 < idx1, "audit rows not ordered most-recent first"
                # limit=1 forces a second page — the offset cursor must round-trip.
                r1 = c.get("/api/v1/admin/audit?limit=1",
                          headers={"Authorization": f"Bearer {token}"})
                assert len(r1.json()["items"]) == 1
                next_cursor = r1.json()["next_cursor"]
                assert next_cursor is not None
                r2 = c.get(f"/api/v1/admin/audit?limit=1&cursor={next_cursor}",
                          headers={"Authorization": f"Bearer {token}"})
                assert len(r2.json()["items"]) == 1
                assert r2.json()["items"][0]["target"] != r1.json()["items"][0]["target"]
        finally:
            loop.run_until_complete(cleanup())
    finally:
        loop.close()


@pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres)")
def test_admin_usage_returns_seeded_row_paginated():
    import asyncio
    import asyncpg

    model = f"gpt-test-{uuid.uuid4().hex[:8]}"

    async def seed():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES ('org_1','org_1') ON CONFLICT DO NOTHING")
            await con.execute(
                "INSERT INTO users(id, org_id, email, role) VALUES "
                "('usr_usage_a','org_1','usage_a@x.co','member') ON CONFLICT (id) DO NOTHING")
            await con.execute(
                """INSERT INTO usage_daily(day, org_id, user_id, model, origin, tokens_in,
                   tokens_out, cost_usd, tool_calls, sandbox_seconds)
                   VALUES(CURRENT_DATE, 'org_1', 'usr_usage_a', $1, 'interactive',
                   100, 50, 0.0123, 2, 30)""",
                model,
            )
        finally:
            await con.close()

    async def cleanup():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute("DELETE FROM usage_daily WHERE model=$1", model)
            await con.execute("DELETE FROM users WHERE id='usr_usage_a'")
        finally:
            await con.close()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(seed())
        try:
            with TestClient(app) as c:
                token, _, _ = get_auth_service().mint(sub="usr_a", org_id="org_1", role="admin")
                r = c.get("/api/v1/admin/usage", headers={"Authorization": f"Bearer {token}"})
                assert r.status_code == 200
                body = r.json()
                assert any(row["model"] == model for row in body["items"]), \
                    "seeded usage_daily row not returned"
                seeded = next(row for row in body["items"] if row["model"] == model)
                assert seeded["tokens_in"] == 100
                assert seeded["tool_calls"] == 2
                # org filter narrows to the seeded org.
                rf = c.get("/api/v1/admin/usage?org=org_1",
                          headers={"Authorization": f"Bearer {token}"})
                assert any(row["model"] == model for row in rf.json()["items"])
        finally:
            loop.run_until_complete(cleanup())
    finally:
        loop.close()
