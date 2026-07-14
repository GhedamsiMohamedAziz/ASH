#!/usr/bin/env python3
"""Fire-time revocation demo (instructions.md §18.3) — the governance moat, live.

Story:
  1. A cron needs github.merge_pr; the org policy allows it (pre-approved). It fires → proceeds.
  2. A right is REVOKED in the database (merge_pr → deny) — as if an admin changed policy
     or the user was rétrogradé.
  3. The SAME cron fires again. Permissions are re-evaluated AT THE FIRE against the current
     database. The run does not proceed with stale rights — the job auto-pauses (E_PERM_REVOKED).

Run against a live Postgres that has the migrations applied:
    DATABASE_URL=postgresql://olma:olma@localhost:PORT/olma python3 demo_revocation.py
"""

from __future__ import annotations

import asyncio
import os
import sys

sys.path.insert(0, ".")

from app.policy import load_from_postgres, PolicyEngine  # noqa: E402
from app.scheduled import JobStatus, ScheduledJob, UserStatus, fire  # noqa: E402

DSN = os.environ.get("DATABASE_URL")


async def _set_effect(dsn: str, tool: str, effect: str) -> None:
    import asyncpg
    con = await asyncpg.connect(dsn)
    try:
        await con.execute(
            "UPDATE tool_policies SET effect=$1 WHERE org_id='org_1' AND role='member' "
            "AND tool_pattern=$2", effect, tool)
    finally:
        await con.close()


async def _fire_with_current_policy(job: ScheduledJob) -> None:
    engine = PolicyEngine(await load_from_postgres(DSN, "org_1"))  # re-load AT the fire
    result = fire(job, engine, user_status=UserStatus.active)
    verdict = "▶ PROCEED" if result.proceed else f"⏸ PAUSED [{result.code}] — {result.reason}"
    print(f"   fire → {verdict}   (job.status={job.status.value})")


async def main() -> None:
    if not DSN:
        sys.exit("set DATABASE_URL to a Postgres with migrations applied")

    job = ScheduledJob(
        id="job_demo", user_id="usr_1", org_id="org_1", role="member",
        prompt="chaque matin, résume mes PRs et merge les triviales",
        required_tools=["github.search", "github.merge_pr"], cron="0 9 * * 1",
        pre_approved_tools=["github.merge_pr"])

    print("① Policy allows merge_pr (pre-approved). Cron fires:")
    await _set_effect(DSN, "github.merge_pr", "require_approval")
    await _fire_with_current_policy(job)

    print("\n② Admin REVOKES the right in the DB: github.merge_pr → deny")
    await _set_effect(DSN, "github.merge_pr", "deny")

    print("\n③ The SAME cron fires again — permissions re-evaluated at the fire:")
    await _fire_with_current_policy(job)

    assert job.status is JobStatus.paused, "expected the job to auto-pause"
    print("\n✅ The automation degraded to PAUSED at fire time — never ran with a revoked right.")
    # restore for idempotency
    await _set_effect(DSN, "github.merge_pr", "require_approval")


if __name__ == "__main__":
    asyncio.run(main())
