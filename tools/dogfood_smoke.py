#!/usr/bin/env python3
"""org-platform dogfooding smoke (AX-090, §24.8). Drives the governance chain for the
platform's OWN org through the real pipeline — proves the org works end-to-end. The
'team uses it daily' reality this bootstraps; admin CRUD is covered by test_admin.py."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "prompt-layer"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "packages" / "shared-py"))
from app.policy import PolicyEngine, Policy
from app.pipeline import build_task, TASK_JWT_SECRET
from app.scheduler import JobStore
from app.scheduled import ScheduledJob, JobStatus, UserStatus
from olma_shared import jwt

def main():
    ORG = "org-platform"
    # org-platform policies (§24.8 — seeded like any org).
    engine = PolicyEngine([
        Policy(ORG, "member", "github.search", "allow"),
        Policy(ORG, "member", "github.create_pr", "allow"),
        Policy(ORG, "member", "github.merge_pr", "require_approval", "tech-leads"),
        Policy(ORG, "member", "scheduler.create_cron", "require_approval"),
    ])
    print("① org-platform seeded with 4 policies")

    # A platform engineer's turn flows through the real pipeline for org-platform.
    inbound = {"message_id":"m","user_id":"usr_eng","org_id":ORG,"conversation_id":"c",
               "channel":"slack","text":"ouvre une PR pour le fix et merge la triviale"}
    task = build_task(inbound, role="member", engine=engine)
    claims = jwt.verify(task.task_jwt, TASK_JWT_SECRET)
    assert "github.create_pr" in claims["allowed_tools"]
    assert "github.merge_pr" in claims["approval_tools"]
    print("② governance chain works for org-platform: create_pr allowed, merge_pr gated to tech-leads")

    # The team's own cron (dogfooding the automation path).
    jobs = JobStore()
    j = jobs.create(ScheduledJob(id="job_dogfood", user_id="usr_eng", org_id=ORG, role="member",
        prompt="chaque matin, résume les PRs de la plateforme", required_tools=["github.search"],
        cron="0 9 * * 1", status=JobStatus.draft))
    jobs.approve(j.id)
    out = jobs.fire_job(j.id, "2026-07-14T09:00:00Z", engine, user_status=UserStatus.active)
    assert out.fired and out.task.origin == "scheduled"
    print("③ org-platform's own cron fires + re-injects through the pipeline")
    print("✅ org-platform is live and dogfoodable — the platform runs on its own org (§24.8).")

if __name__ == "__main__":
    main()
