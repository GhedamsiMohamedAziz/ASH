"""Tests for automations (§16.1), the admin console gate (§24.1-24.3), and the
internal scheduled-run intake (PLAN-DEV §3.2) — GET/PATCH/DELETE /api/v1/automations,
GET .../runs, GET /api/v1/admin/*, POST /internal/scheduled-runs.

DB-backed assertions (owner scoping over real scheduled_jobs rows) skip gracefully when
DATABASE_URL is unset, matching test_bus_pg.py / test_rls_isolation.py.
"""

import os
import uuid

import pytest
from fastapi.testclient import TestClient

from app.main import app, store
from app.identity import get_auth_service


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


# --------------------------------------------------------------- automations (no DB required)
def test_automations_list_well_formed_empty_without_database(client):
    r = client.get("/api/v1/automations", headers=_bearer("usr_1", "org_1"))
    assert r.status_code == 200
    assert r.json() == {"items": [], "next_cursor": None}


def test_automation_runs_well_formed_empty_without_database(client):
    r = client.get("/api/v1/automations/job_nope/runs", headers=_bearer("usr_1", "org_1"))
    assert r.status_code == 200
    assert r.json() == {"items": [], "next_cursor": None}


def test_automation_patch_not_found_without_database(client):
    r = client.patch("/api/v1/automations/job_nope", json={"status": "paused"},
                     headers=_bearer("usr_1", "org_1"))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


def test_automation_delete_not_found_without_database(client):
    r = client.delete("/api/v1/automations/job_nope", headers=_bearer("usr_1", "org_1"))
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "E_NOT_FOUND"


# --------------------------------------------------------------- admin console gating
def test_admin_route_requires_bearer_token(client):
    r = client.get("/api/v1/admin/users")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_admin_route_rejects_member_role(client):
    r = client.get("/api/v1/admin/users", headers=_bearer("usr_1", "org_1", role="member"))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_PERM_TOOL_DENIED"


def test_admin_route_allows_admin_role(client):
    r = client.get("/api/v1/admin/users", headers=_bearer("usr_a", "org_1", role="admin"))
    assert r.status_code == 200
    assert r.json() == {"items": [], "next_cursor": None}


@pytest.mark.parametrize("path", ["users", "sandboxes", "audit", "usage", "automations"])
def test_all_admin_collections_exist_and_are_gated(client, path):
    denied = client.get(f"/api/v1/admin/{path}", headers=_bearer("usr_1", "org_1", role="member"))
    assert denied.status_code == 403
    allowed = client.get(f"/api/v1/admin/{path}", headers=_bearer("usr_a", "org_1", role="admin"))
    assert allowed.status_code == 200
    assert allowed.json() == {"items": [], "next_cursor": None}


# --------------------------------------------------------------- /internal/scheduled-runs
def test_internal_scheduled_runs_rejects_normal_user_jwt(client):
    """A regular user Bearer token must never pass — only the dedicated service token does."""
    r = client.post(
        "/internal/scheduled-runs",
        json={"job_id": "job_1", "user_id": "usr_1", "org_id": "org_1", "text": "run it"},
        headers=_bearer("usr_1", "org_1"),
    )
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_PERM_TOOL_DENIED"


def test_internal_scheduled_runs_rejects_missing_token(client):
    r = client.post(
        "/internal/scheduled-runs",
        json={"job_id": "job_1", "user_id": "usr_1", "org_id": "org_1", "text": "run it"},
    )
    assert r.status_code == 403


def test_internal_scheduled_runs_rejects_wrong_service_token(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", "s3cr3t")
    r = client.post(
        "/internal/scheduled-runs",
        json={"job_id": "job_1", "user_id": "usr_1", "org_id": "org_1", "text": "run it"},
        headers={"X-Service-Token": "wrong"},
    )
    assert r.status_code == 403


def test_internal_scheduled_runs_denies_when_token_unconfigured(client, monkeypatch):
    from app import main
    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", None)
    r = client.post(
        "/internal/scheduled-runs",
        json={"job_id": "job_1", "user_id": "usr_1", "org_id": "org_1", "text": "run it"},
        headers={"X-Service-Token": "anything"},
    )
    assert r.status_code == 403


def test_internal_scheduled_runs_accepts_valid_service_token_and_publishes(client, monkeypatch):
    from app import main
    from app import bus as busmod

    monkeypatch.setattr(main, "INTERNAL_SERVICE_TOKEN", "s3cr3t")
    seen = []

    async def spy(msg):
        seen.append(msg)

    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        r = client.post(
            "/internal/scheduled-runs",
            json={"job_id": "job_1", "user_id": "usr_1", "org_id": "org_1",
                  "text": "run it", "scheduled_for": "2026-07-15T09:00:00Z"},
            headers={"X-Service-Token": "s3cr3t"},
        )
    finally:
        unsub()
    assert r.status_code == 202
    body = r.json()
    assert body["message_id"] and body["task_id"]
    assert body["stream"] == "/api/v1/conversations/cron_job_1/stream"
    assert seen, "no InboundMessage published to the bus"
    published = seen[-1].data
    assert published["channel"] == "scheduler"
    assert published["job_id"] == "job_1"
    assert published["conversation_id"] == "cron_job_1"


# --------------------------------------------------------------- owner scoping (live Postgres)
@pytest.mark.skipif(not os.getenv("DATABASE_URL"), reason="requires DATABASE_URL (live Postgres)")
def test_automations_list_is_owner_scoped():
    import asyncio
    import asyncpg

    dsn = os.environ["DATABASE_URL"]
    job_id = f"job_test_{uuid.uuid4().hex[:8]}"

    async def seed():
        con = await asyncpg.connect(dsn)
        try:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES ('org_1','org_1') ON CONFLICT DO NOTHING")
            await con.execute(
                "INSERT INTO users(id, org_id, email, role) VALUES "
                "('usr_auto_a','org_1','auto_a@x.co','member'),"
                "('usr_auto_b','org_1','auto_b@x.co','member') ON CONFLICT (id) DO NOTHING")
            await con.execute(
                "INSERT INTO scheduled_jobs(id, user_id, org_id, name, prompt, cron, "
                "delivery, per_run_budget, created_by, status) VALUES "
                "($1,'usr_auto_a','org_1','A job','do a','0 9 * * 1','{}','{}','user','active')",
                job_id,
            )
        finally:
            await con.close()

    async def cleanup():
        con = await asyncpg.connect(dsn)
        try:
            await con.execute("DELETE FROM scheduled_jobs WHERE id=$1", job_id)
            await con.execute("DELETE FROM users WHERE id IN ('usr_auto_a','usr_auto_b')")
        finally:
            await con.close()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(seed())
        try:
            with TestClient(app) as c:
                token_a, _, _ = get_auth_service().mint(sub="usr_auto_a", org_id="org_1")
                token_b, _, _ = get_auth_service().mint(sub="usr_auto_b", org_id="org_1")
                ra = c.get("/api/v1/automations", headers={"Authorization": f"Bearer {token_a}"})
                rb = c.get("/api/v1/automations", headers={"Authorization": f"Bearer {token_b}"})
                assert any(j["id"] == job_id for j in ra.json()["items"]), \
                    "owner did not see their own automation"
                assert all(j["id"] != job_id for j in rb.json()["items"]), \
                    "a different user saw another user's automation (owner-scoping leak)"
        finally:
            loop.run_until_complete(cleanup())
    finally:
        loop.close()
