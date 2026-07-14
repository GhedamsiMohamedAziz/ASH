"""AX-055 job CRUD + AX-057 fire pivot tests (§15.4, §18.3)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.policy import Policy, PolicyEngine  # noqa: E402
from app.scheduled import JobStatus, ScheduledJob, UserStatus  # noqa: E402
from app.scheduler import JobError, JobStore  # noqa: E402


def _job(jid="job_1", **kw):
    base = dict(id=jid, user_id="usr_1", org_id="org_1", role="member",
                prompt="chaque matin résume mes PRs", required_tools=["github.search"],
                cron="0 9 * * 1", status=JobStatus.draft, pre_approved_tools=[])
    base.update(kw)
    return ScheduledJob(**base)


def _engine(merge="allow"):
    return PolicyEngine([
        Policy("org_1", "member", "github.search", "allow"),
        Policy("org_1", "member", "github.create_pr", "allow"),
        Policy("org_1", "member", "github.merge_pr", merge),
        Policy("org_1", "member", "scheduler.list_crons", "allow"),
        Policy("org_1", "member", "database.read", "allow"),
    ])


# ------------------------------------------------------------------ lifecycle (AX-055, §15.4)
def test_create_starts_pending_approval():
    s = JobStore()
    j = s.create(_job())
    assert j.status is JobStatus.pending_approval  # agent-created → needs approval


def test_approve_activates():
    s = JobStore()
    s.create(_job())
    assert s.approve("job_1").status is JobStatus.active


def test_pause_resume_delete():
    s = JobStore()
    s.create(_job()); s.approve("job_1")
    assert s.pause("job_1").status is JobStatus.paused
    r = s.resume_job("job_1", _engine(), user_status=UserStatus.active)
    assert r.proceed and s.get("job_1").status is JobStatus.active
    s.delete("job_1")
    assert s.get("job_1").status is JobStatus.deleted


def test_list_excludes_deleted():
    s = JobStore()
    s.create(_job("job_1")); s.approve("job_1")
    s.create(_job("job_2")); s.delete("job_2")
    ids = [j.id for j in s.list(user_id="usr_1")]
    assert ids == ["job_1"]


def test_unknown_job_raises():
    with pytest.raises(JobError):
        JobStore().approve("nope")


# ------------------------------------------------------------------ fire pivot (AX-057, §18.3)
def test_fire_active_job_reinjects_scheduled_task():
    s = JobStore()
    s.create(_job()); s.approve("job_1")
    out = s.fire_job("job_1", "2026-07-13T09:00:00Z", _engine(), user_status=UserStatus.active)
    assert out.fired and out.status == "running"
    assert out.task is not None
    assert out.task.origin == "scheduled"          # same pipeline, scheduler channel
    assert out.task.task_jwt                        # signed TASK JWT emitted


def test_fire_with_revoked_right_pauses_and_skips():
    """The revocation demo, now on the real job store (§18.3)."""
    s = JobStore()
    s.create(_job(required_tools=["github.merge_pr"], pre_approved_tools=["github.merge_pr"]))
    s.approve("job_1")
    out = s.fire_job("job_1", "2026-07-13T09:00:00Z", _engine(merge="deny"),
                     user_status=UserStatus.active)
    assert not out.fired
    assert out.error_code == "E_PERM_REVOKED"
    assert s.get("job_1").status is JobStatus.paused


def test_fire_is_idempotent_per_scheduled_for():
    s = JobStore()
    s.create(_job()); s.approve("job_1")
    first = s.fire_job("job_1", "2026-07-13T09:00:00Z", _engine(), user_status=UserStatus.active)
    dup = s.fire_job("job_1", "2026-07-13T09:00:00Z", _engine(), user_status=UserStatus.active)
    assert first.fired and not dup.fired
    assert dup.status == "skipped" and "idempotency" in dup.reason


def test_dedup_goes_through_the_pluggable_runs_store():
    """Prod injects a Postgres-backed RunsStore; the fire must consult IT, not a private set,
    and record the key only on a successful fire (§16.1)."""
    from app.scheduler import InMemoryRuns
    runs = InMemoryRuns()
    s = JobStore(runs=runs)
    s.create(_job()); s.approve("job_1")
    key = ("job_1", "2026-07-13T09:00:00Z")
    assert not runs.seen(key)
    s.fire_job("job_1", "2026-07-13T09:00:00Z", _engine(), user_status=UserStatus.active)
    assert runs.seen(key)  # marked in the injected store, so a DB-backed one would persist it


def test_build_failure_does_not_burn_the_idempotency_key():
    """If build_task raises, the key must NOT be recorded — a retry re-attempts, never silently
    drops the fire (the pre-fix bug)."""
    from app.scheduler import InMemoryRuns
    runs = InMemoryRuns()
    s = JobStore(runs=runs)
    s.create(_job()); s.approve("job_1")
    key = ("job_1", "2026-07-13T09:00:00Z")

    # A real engine (so preflight PASSES on evaluate), but compute_tools — called inside
    # build_task, after preflight — blows up. This is the exact "fails during build" case.
    eng = _engine()
    def boom(*a, **k):
        raise RuntimeError("build blew up after preflight")
    eng.compute_tools = boom

    with pytest.raises(RuntimeError):
        s.fire_job("job_1", "2026-07-13T09:00:00Z", eng, user_status=UserStatus.active)
    assert not runs.seen(key)  # NOT burned — the occurrence stays retryable


def test_fire_offboarded_creator_skips():
    s = JobStore()
    s.create(_job()); s.approve("job_1")
    out = s.fire_job("job_1", "2026-07-13T09:00:00Z", _engine(),
                     user_status=UserStatus.offboarded)
    assert not out.fired and s.get("job_1").status is JobStatus.paused
