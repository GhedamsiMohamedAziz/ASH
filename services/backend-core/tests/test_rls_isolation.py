"""DB-enforced tenant isolation — the org_A/org_B traversal test (CLAUDE.md invariant #3, §16.4).

Runs against a live Postgres with all migrations applied (0004 adds org_id + RLS FORCE +
the tenant_isolation policy). Skips when DATABASE_URL is unset, like the other DB tests.

The whole test runs inside ONE transaction that is ROLLED BACK, so it seeds/mutates nothing
durable — DDL (DISABLE/ENABLE RLS) is transactional in Postgres, so even the "prove the policy
is load-bearing" step leaves no trace.

Critical property proven:
  1. A session scoped to org_B sees ZERO of org_A's rows.
  2. WITH CHECK blocks forging a row stamped with a foreign org_id.
  3. A session sees its OWN org's rows.
  4. The test is load-bearing: DISABLE the RLS and the cross-tenant leak appears — i.e. this
     test FAILS if the protection is removed (the contract's "prouve-le en la retirant").
"""
from __future__ import annotations

import asyncio
import os

import pytest

DSN = os.getenv("DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="requires DATABASE_URL (live Postgres + migrations)")


async def _run():
    import asyncpg
    con = await asyncpg.connect(DSN)
    tr = con.transaction()
    await tr.start()
    try:
        # Seed two orgs + a user each (rolled back).
        await con.execute("INSERT INTO orgs (id,name) VALUES ('org_A','A'),('org_B','B') ON CONFLICT DO NOTHING")
        await con.execute("INSERT INTO users (id,org_id,email) VALUES "
                          "('u_a','org_A','rls_a@x.co'),('u_b','org_B','rls_b@x.co') ON CONFLICT DO NOTHING")

        # Drop to the non-superuser app role so RLS actually applies (superuser bypasses it).
        await con.execute("SET ROLE olma_app")

        # org_A writes a conversation.
        await con.execute("SET app.org_id = 'org_A'")
        await con.execute("INSERT INTO conversations (id,user_id,channel,org_id) "
                          "VALUES ('c_rls_a','u_a','web','org_A')")

        # 1. org_B must see ZERO of org_A's rows.
        await con.execute("SET app.org_id = 'org_B'")
        seen_b = await con.fetchval("SELECT count(*) FROM conversations WHERE id = 'c_rls_a'")
        assert seen_b == 0, f"tenant leak: org_B saw {seen_b} of org_A's rows"

        # 2. WITH CHECK blocks forging a row stamped with a foreign org_id. Use a SAVEPOINT so
        #    the expected error only rolls back this attempt, not the whole test transaction.
        forge_blocked = False
        sp = con.transaction()
        await sp.start()
        try:
            await con.execute("INSERT INTO conversations (id,user_id,channel,org_id) "
                              "VALUES ('c_forge','u_a','web','org_A')")
            await sp.rollback()  # if it somehow succeeded, undo it
        except asyncpg.PostgresError:
            forge_blocked = True
            await sp.rollback()
        assert forge_blocked, "WITH CHECK did NOT block a cross-org insert"

        # 3. org_A sees its own row.
        await con.execute("SET app.org_id = 'org_A'")
        seen_a = await con.fetchval("SELECT count(*) FROM conversations WHERE id = 'c_rls_a'")
        assert seen_a == 1, f"org_A could not see its own row (saw {seen_a})"

        # 4. Load-bearing proof: with RLS disabled the leak appears. If this did NOT leak, the
        #    isolation above would be an illusion (some other filter), so we assert the leak.
        await con.execute("RESET ROLE")
        await con.execute("ALTER TABLE conversations DISABLE ROW LEVEL SECURITY")
        await con.execute("SET ROLE olma_app")
        await con.execute("SET app.org_id = 'org_B'")
        leaked = await con.fetchval("SELECT count(*) FROM conversations WHERE id = 'c_rls_a'")
        assert leaked == 1, "removing RLS did NOT leak — the test is not actually gated by RLS"
    finally:
        await tr.rollback()   # undoes seeds, inserts, AND the DISABLE RLS
        await con.close()


def test_org_traversal_isolated_by_rls():
    asyncio.run(_run())
