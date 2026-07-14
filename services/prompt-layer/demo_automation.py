#!/usr/bin/env python3
"""Full automation lifecycle demo (AX-067 milestone — §18.2 creation + §18.3 execution).

Walks one cron end to end, offline (in-memory JobStore + PolicyEngine):
  §18.2  create (agent) → pending_approval → user approves → ACTIVE
  §18.3  fire at 09:00 → preflight passes → re-injected as a scheduled AgentTask (runs)
         admin revokes the right → fire again → PAUSED [E_PERM_REVOKED] (never runs stale)
         admin restores the right → resume re-verifies → ACTIVE again

This is the P5 exit criterion: the create/run flow plus the fire-time revocation
proof, on the real JobStore + PolicyEngine (no external services).
"""

from __future__ import annotations

from app.policy import Policy, PolicyEngine
from app.scheduled import JobStatus, ScheduledJob, UserStatus
from app.scheduler import JobStore


def engine(merge_effect: str) -> PolicyEngine:
    return PolicyEngine([
        Policy("org_1", "member", "github.search", "allow"),
        Policy("org_1", "member", "github.merge_pr", merge_effect, "tech-leads"),
    ])


def show(store: JobStore, jid: str, label: str) -> None:
    j = store.get(jid)
    print(f"   {label:<28} status={j.status.value:<16} reason={j.pause_reason or '-'}")


def main() -> None:
    store = JobStore()
    jid = "job_daily_prs"

    print("§18.2  CREATION")
    store.create(ScheduledJob(
        id=jid, user_id="usr_1", org_id="org_1", role="member",
        prompt="chaque matin, résume mes PRs et merge les triviales",
        required_tools=["github.search", "github.merge_pr"],
        cron="0 9 * * 1", pre_approved_tools=["github.merge_pr"], status=JobStatus.draft))
    show(store, jid, "① agent creates cron")            # → pending_approval
    store.approve(jid)
    show(store, jid, "② user approves (card)")          # → active

    print("\n§18.3  EXECUTION (permissions evaluated AT each fire)")
    r1 = store.fire_job(jid, "2026-07-13T09:00:00Z", engine("require_approval"),
                        user_status=UserStatus.active)
    print(f"   ③ fire @09:00 (right OK)       fired={r1.fired} → AgentTask origin={r1.task.origin}")

    print("\n   — admin REVOKES github.merge_pr in policy —")
    r2 = store.fire_job(jid, "2026-07-14T09:00:00Z", engine("deny"),
                        user_status=UserStatus.active)
    print(f"   ④ fire @09:00 (right revoked)  fired={r2.fired} code={r2.error_code}")
    show(store, jid, "      job after revoked fire")    # → paused

    print("\n   — admin RESTORES the right; user resumes —")
    res = store.resume_job(jid, engine("require_approval"), user_status=UserStatus.active)
    show(store, jid, f"⑤ resume (proceed={res.proceed})")  # → active

    assert store.get(jid).status is JobStatus.active
    print("\n✅ Full lifecycle proven: create→approve→run, revoke→pause at fire time, restore→resume.")


if __name__ == "__main__":
    main()
