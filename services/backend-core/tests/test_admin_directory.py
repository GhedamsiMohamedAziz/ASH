"""Tests for GET /api/v1/admin/users, GET /api/v1/admin/automations (org-wide), and
GET /api/v1/admin/sandboxes (§24.2) — the three admin console collections that were
well-formed-empty TODOs, now wired to real tables owned by backend-core: users and
sandboxes (db/migrations/0001_init.sql), scheduled_jobs (db/migrations/0002_automations.sql).

DB-backed assertions (seeded rows come back paginated + org-scoped) skip gracefully when
DATABASE_URL is unset, matching test_admin_data.py / test_automations.py.
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
@pytest.mark.parametrize("path", ["users", "automations", "sandboxes"])
def test_admin_directory_requires_bearer_token(client, path):
    r = client.get(f"/api/v1/admin/{path}")
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


@pytest.mark.parametrize("path", ["users", "automations", "sandboxes"])
def test_admin_directory_rejects_member_role(client, path):
    r = client.get(f"/api/v1/admin/{path}", headers=_bearer("usr_1", "org_1", role="member"))
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "E_PERM_TOOL_DENIED"


@pytest.mark.parametrize("path", ["users", "automations", "sandboxes"])
def test_admin_directory_well_formed_empty_without_database(client, path):
    r = client.get(f"/api/v1/admin/{path}", headers=_bearer("usr_a", "org_1", role="admin"))
    assert r.status_code == 200
    assert r.json() == {"items": [], "next_cursor": None}


# --------------------------------------------------------------- real reads (live Postgres)
@pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres)")
def test_admin_users_returns_seeded_rows_org_scoped_and_no_secret_columns():
    import asyncio
    import asyncpg

    suffix = uuid.uuid4().hex[:8]
    org_a, org_b = f"org_dir_a_{suffix}", f"org_dir_b_{suffix}"
    user_a, user_b = f"usr_dir_a_{suffix}", f"usr_dir_b_{suffix}"

    async def seed():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES ($1,$1),($2,$2) ON CONFLICT DO NOTHING",
                org_a, org_b,
            )
            await con.execute(
                "INSERT INTO users(id, org_id, email, display_name, role, status) VALUES "
                "($1,$3,$5,'Dir A','member','active'),"
                "($2,$4,$6,'Dir B','member','active') ON CONFLICT (id) DO NOTHING",
                user_a, user_b, org_a, org_b,
                f"{user_a}@x.co", f"{user_b}@x.co",
            )
        finally:
            await con.close()

    async def cleanup():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute("DELETE FROM users WHERE id IN ($1,$2)", user_a, user_b)
            await con.execute("DELETE FROM orgs WHERE id IN ($1,$2)", org_a, org_b)
        finally:
            await con.close()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(seed())
        try:
            with TestClient(app) as c:
                token_a, _, _ = get_auth_service().mint(sub="usr_admin_a", org_id=org_a, role="admin")
                r = c.get("/api/v1/admin/users", headers={"Authorization": f"Bearer {token_a}"})
                assert r.status_code == 200
                body = r.json()
                assert any(u["id"] == user_a for u in body["items"]), \
                    "seeded users row for org_a not returned"
                assert all(u["id"] != user_b for u in body["items"]), \
                    "org_a admin saw org_b's user (org-scoping leak)"
                seeded = next(u for u in body["items"] if u["id"] == user_a)
                # Safe-column confirmation: exactly id/org_id/email/name/status/created_at —
                # no password/token/secret column.
                assert set(seeded.keys()) == {"id", "org_id", "email", "name", "status", "created_at"}
                assert seeded["name"] == "Dir A"
                assert seeded["org_id"] == org_a

                token_b, _, _ = get_auth_service().mint(sub="usr_admin_b", org_id=org_b, role="admin")
                rb = c.get("/api/v1/admin/users", headers={"Authorization": f"Bearer {token_b}"})
                assert all(u["id"] != user_a for u in rb.json()["items"]), \
                    "org_b admin saw org_a's user (org-scoping leak)"
        finally:
            loop.run_until_complete(cleanup())
    finally:
        loop.close()


@pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres)")
def test_admin_automations_is_org_wide_not_owner_scoped():
    import asyncio
    import asyncpg

    suffix = uuid.uuid4().hex[:8]
    org_a, org_b = f"org_auto_a_{suffix}", f"org_auto_b_{suffix}"
    user_a1, user_a2, user_b = (
        f"usr_auto_a1_{suffix}", f"usr_auto_a2_{suffix}", f"usr_auto_b_{suffix}",
    )
    job_a1, job_a2, job_b = f"job_a1_{suffix}", f"job_a2_{suffix}", f"job_b_{suffix}"

    async def seed():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES ($1,$1),($2,$2) ON CONFLICT DO NOTHING",
                org_a, org_b,
            )
            await con.execute(
                "INSERT INTO users(id, org_id, email, role) VALUES "
                "($1,$4,$6,'member'),($2,$4,$7,'member'),($3,$5,$8,'member') "
                "ON CONFLICT (id) DO NOTHING",
                user_a1, user_a2, user_b, org_a, org_b,
                f"{user_a1}@x.co", f"{user_a2}@x.co", f"{user_b}@x.co",
            )
            for job_id, uid, oid in ((job_a1, user_a1, org_a), (job_a2, user_a2, org_a),
                                     (job_b, user_b, org_b)):
                await con.execute(
                    "INSERT INTO scheduled_jobs(id, user_id, org_id, name, prompt, cron, "
                    "delivery, per_run_budget, created_by, status) VALUES "
                    "($1,$2,$3,'a job','do a','0 9 * * 1','{}','{}','user','active')",
                    job_id, uid, oid,
                )
        finally:
            await con.close()

    async def cleanup():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute("DELETE FROM scheduled_jobs WHERE id IN ($1,$2,$3)",
                              job_a1, job_a2, job_b)
            await con.execute("DELETE FROM users WHERE id IN ($1,$2,$3)",
                              user_a1, user_a2, user_b)
            await con.execute("DELETE FROM orgs WHERE id IN ($1,$2)", org_a, org_b)
        finally:
            await con.close()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(seed())
        try:
            with TestClient(app) as c:
                # An admin sees BOTH job_a1 (owned by user_a1) and job_a2 (owned by user_a2) —
                # proving this is org-wide, not owner-scoped like GET /automations.
                token_admin, _, _ = get_auth_service().mint(
                    sub="usr_admin_a", org_id=org_a, role="admin")
                r = c.get("/api/v1/admin/automations",
                         headers={"Authorization": f"Bearer {token_admin}"})
                assert r.status_code == 200
                ids = {j["id"] for j in r.json()["items"]}
                assert job_a1 in ids and job_a2 in ids, \
                    "org admin did not see all jobs in their org (not org-wide)"
                assert job_b not in ids, "org_a admin saw org_b's job (org-scoping leak)"

                # The user-facing /automations route stays owner-scoped (unbroken).
                token_a1, _, _ = get_auth_service().mint(sub=user_a1, org_id=org_a)
                ro = c.get("/api/v1/automations", headers={"Authorization": f"Bearer {token_a1}"})
                owner_ids = {j["id"] for j in ro.json()["items"]}
                assert job_a1 in owner_ids
                assert job_a2 not in owner_ids, \
                    "owner-scoped /automations regressed to an org-wide view"
        finally:
            loop.run_until_complete(cleanup())
    finally:
        loop.close()


@pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres)")
def test_admin_sandboxes_returns_seeded_rows_org_scoped():
    import asyncio
    import asyncpg

    suffix = uuid.uuid4().hex[:8]
    org_a, org_b = f"org_sbx_a_{suffix}", f"org_sbx_b_{suffix}"
    user_a, user_b = f"usr_sbx_a_{suffix}", f"usr_sbx_b_{suffix}"

    async def seed():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute(
                "INSERT INTO orgs(id, name) VALUES ($1,$1),($2,$2) ON CONFLICT DO NOTHING",
                org_a, org_b,
            )
            await con.execute(
                "INSERT INTO users(id, org_id, email, role) VALUES "
                "($1,$3,$5,'member'),($2,$4,$6,'member') ON CONFLICT (id) DO NOTHING",
                user_a, user_b, org_a, org_b, f"{user_a}@x.co", f"{user_b}@x.co",
            )
            await con.execute(
                "INSERT INTO sandboxes(user_id, node, container_id, state, volume_id, "
                "last_active) VALUES "
                "($1,'node-1','c-1','running','vol-1', now()),"
                "($2,'node-2','c-2','running','vol-2', now())",
                user_a, user_b,
            )
        finally:
            await con.close()

    async def cleanup():
        con = await asyncpg.connect(DSN)
        try:
            await con.execute("DELETE FROM sandboxes WHERE user_id IN ($1,$2)", user_a, user_b)
            await con.execute("DELETE FROM users WHERE id IN ($1,$2)", user_a, user_b)
            await con.execute("DELETE FROM orgs WHERE id IN ($1,$2)", org_a, org_b)
        finally:
            await con.close()

    loop = asyncio.new_event_loop()
    try:
        loop.run_until_complete(seed())
        try:
            with TestClient(app) as c:
                token_a, _, _ = get_auth_service().mint(
                    sub="usr_admin_a", org_id=org_a, role="admin")
                r = c.get("/api/v1/admin/sandboxes",
                         headers={"Authorization": f"Bearer {token_a}"})
                assert r.status_code == 200
                body = r.json()
                assert any(s["user_id"] == user_a for s in body["items"]), \
                    "seeded sandbox row for org_a not returned"
                assert all(s["user_id"] != user_b for s in body["items"]), \
                    "org_a admin saw org_b's sandbox (org-scoping leak)"
        finally:
            loop.run_until_complete(cleanup())
    finally:
        loop.close()
