"""Fire-time preflight tests (AX-060, §15.6, §18.3) — the revocation demo."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.policy import Policy, PolicyEngine  # noqa: E402
from app.scheduled import (  # noqa: E402
    JobStatus,
    ScheduledJob,
    UserStatus,
    fire,
    preflight,
    resume,
)


def _job(**kw):
    base = dict(id="job_1", user_id="usr_1", org_id="org_1", role="member",
                prompt="chaque matin résume mes PRs et merge les triviales",
                required_tools=["github.search", "github.merge_pr"], cron="0 9 * * 1",
                pre_approved_tools=["github.merge_pr"])
    base.update(kw)
    return ScheduledJob(**base)


def _engine_full():
    # merge_pr require_approval; the job pre-approved it, so it may run.
    return PolicyEngine([
        Policy("org_1", "member", "github.search", "allow"),
        Policy("org_1", "member", "github.merge_pr", "require_approval", "tech-leads"),
    ])


def _engine_revoked():
    # merge_pr is now denied (right removed since job creation).
    return PolicyEngine([
        Policy("org_1", "member", "github.search", "allow"),
        Policy("org_1", "member", "github.merge_pr", "deny"),
    ])


# ------------------------------------------------------------------ happy path
def test_active_job_with_rights_proceeds():
    r = preflight(_job(), _engine_full(), user_status=UserStatus.active)
    assert r.proceed is True and r.code is None


# ------------------------------------------------------------------ THE DEMO (§18.3)
def test_revoked_permission_pauses_job_at_fire_time():
    job = _job()
    assert job.status is JobStatus.active
    r = fire(job, _engine_revoked(), user_status=UserStatus.active)
    assert r.proceed is False
    assert r.code == "E_PERM_REVOKED"
    assert job.status is JobStatus.paused           # job auto-paused
    assert "github.merge_pr" in job.pause_reason


def test_permission_downgraded_to_approval_without_preapproval_revokes():
    job = _job(pre_approved_tools=[])  # merge_pr NOT pre-approved
    r = fire(job, _engine_full(), user_status=UserStatus.active)  # merge_pr require_approval
    assert r.code == "E_PERM_REVOKED" and job.status is JobStatus.paused


# ------------------------------------------------------------------ other fire-time guards
def test_offboarded_creator_pauses():
    job = _job()
    r = fire(job, _engine_full(), user_status=UserStatus.offboarded)
    assert r.code == "E_PERM_REVOKED" and job.status is JobStatus.paused


def test_org_kill_switch_pauses():
    job = _job()
    r = fire(job, _engine_full(), user_status=UserStatus.active, org_automations_enabled=False)
    assert r.proceed is False and job.status is JobStatus.paused


def test_three_failures_auto_pause():
    job = _job(consecutive_failures=3)
    r = fire(job, _engine_full(), user_status=UserStatus.active)
    assert r.proceed is False and job.status is JobStatus.paused


def test_already_paused_job_does_not_fire():
    job = _job(status=JobStatus.paused)
    r = preflight(job, _engine_full(), user_status=UserStatus.active)
    assert r.proceed is False and r.code == "E_SCHED_JOB_PAUSED"


# ------------------------------------------------------------------ resume re-verifies (§15.4)
def test_resume_blocked_while_right_still_revoked():
    job = _job(status=JobStatus.paused)
    r = resume(job, _engine_revoked(), user_status=UserStatus.active)
    assert r.proceed is False and job.status is JobStatus.paused   # stays paused


def test_resume_succeeds_once_right_restored():
    job = _job(status=JobStatus.paused, pause_reason="permission for github.merge_pr is now 'deny'")
    r = resume(job, _engine_full(), user_status=UserStatus.active)
    assert r.proceed is True and job.status is JobStatus.active
    assert job.pause_reason is None
