"""Job store + fire pivot (AX-055, AX-057 — instructions.md §15.2-15.4, §18.3, ADR 005).

The security half of automations lives in `scheduled.py` (fire-time preflight). This
adds the two pieces around it:

  • JobStore (AX-055): CRUD over scheduled_jobs with the §15.4 lifecycle
    (draft→pending_approval→active→paused→deleted). In-memory + optional asyncpg.
  • fire_job (AX-057): the pivot. On a scheduled fire it runs the preflight (AX-060);
    if it proceeds, it re-injects the job's prompt as a scheduler-channel InboundMessage
    through the SAME pipeline (build_task) — one security path for humans and crons
    (ADR 005). Idempotent per (job_id, scheduled_for), matching the scheduled_runs
    UNIQUE constraint (§16.1).

The Trigger.dev worker (automation-service, TS) is the scheduling ENGINE that fires
on the cron clock and calls fire_job; this module is the durable business logic it
drives, with scheduled_jobs as the source of truth (§16.2).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

from .pipeline import AgentTask, build_task
from .policy import PolicyEngine
from .scheduled import JobStatus, ScheduledJob, UserStatus, fire, resume


class JobError(Exception):
    pass


class RunsStore(Protocol):
    """Idempotency ledger for (job_id, scheduled_for) fires (§15.6, §16.1).

    The default is in-memory (dev/test). Production injects a Postgres-backed store whose
    `mark` INSERTs into `scheduled_runs` (UNIQUE(job_id, scheduled_for)) — so dedup survives a
    process restart and is enforced by the database, matching the durable design (§16.1).
    """

    def seen(self, key: tuple[str, str]) -> bool: ...
    def mark(self, key: tuple[str, str]) -> None: ...


class InMemoryRuns:
    """Default RunsStore — a set. Loses state on restart; fine for dev/test (§16.1)."""

    def __init__(self) -> None:
        self._s: set[tuple[str, str]] = set()

    def seen(self, key: tuple[str, str]) -> bool:
        return key in self._s

    def mark(self, key: tuple[str, str]) -> None:
        self._s.add(key)


@dataclass
class FireOutcome:
    job_id: str
    scheduled_for: str
    fired: bool                 # did a run actually happen
    status: str                 # queued|running|success|failed|skipped
    task: AgentTask | None = None
    error_code: str | None = None
    reason: str | None = None


class JobStore:
    """CRUD + lifecycle over scheduled_jobs (§15.4). `db` = optional asyncpg pool."""

    def __init__(self, db=None, runs: RunsStore | None = None) -> None:
        self.jobs: dict[str, ScheduledJob] = {}
        # Idempotency ledger — swappable: inject a Postgres-backed RunsStore in prod for durable,
        # restart-surviving dedup (scheduled_runs UNIQUE); defaults to in-memory for dev/test.
        self.runs: RunsStore = runs or InMemoryRuns()
        self.db = db

    # -- lifecycle -------------------------------------------------
    def create(self, job: ScheduledJob) -> ScheduledJob:
        # An agent-created cron starts pending_approval (§15.4, require_approval default).
        if job.status is JobStatus.draft:
            job.status = JobStatus.pending_approval
        self.jobs[job.id] = job
        return job

    def approve(self, job_id: str) -> ScheduledJob:
        job = self._require(job_id)
        if job.status is not JobStatus.pending_approval:
            raise JobError(f"cannot approve a {job.status.value} job")
        job.status = JobStatus.active
        return job

    def pause(self, job_id: str, reason: str = "user") -> ScheduledJob:
        job = self._require(job_id)
        if job.status is JobStatus.active:
            job.status = JobStatus.paused
            job.pause_reason = reason
        return job

    def resume_job(self, job_id: str, engine: PolicyEngine, *, user_status: UserStatus,
                   org_automations_enabled: bool = True):
        # Resume re-verifies quotas + policy before reactivating (§15.4). The org kill-switch
        # must be forwarded — otherwise a paused job resumes to active even while automations
        # are halted, and only the next fire-time preflight would catch it.
        return resume(self._require(job_id), engine, user_status=user_status,
                      org_automations_enabled=org_automations_enabled)

    def delete(self, job_id: str) -> None:
        job = self._require(job_id)
        job.status = JobStatus.deleted

    def get(self, job_id: str) -> ScheduledJob | None:
        return self.jobs.get(job_id)

    def list(self, *, user_id: str | None = None, status: JobStatus | None = None):
        return [j for j in self.jobs.values()
                if (user_id is None or j.user_id == user_id)
                and (status is None or j.status is status)
                and j.status is not JobStatus.deleted]

    def _require(self, job_id: str) -> ScheduledJob:
        job = self.jobs.get(job_id)
        if job is None:
            raise JobError(f"no such job {job_id}")
        return job

    # -- the pivot (AX-057) ----------------------------------------
    def fire_job(self, job_id: str, scheduled_for: str, engine: PolicyEngine, *,
                 user_status: UserStatus, org_automations_enabled: bool = True) -> FireOutcome:
        job = self._require(job_id)

        # Idempotency: a retry of the same fire never double-runs (§15.6, Principle #8).
        # The key is recorded ONLY after the pivot is successfully built (dedup-on-success).
        # Recording it earlier would permanently skip a fire whose build_task throws
        # (e.g. a prompt that trips the injection guard) — the Trigger.dev retry would hit
        # the duplicate branch and drop the occurrence forever.
        key = (job_id, scheduled_for)
        if self.runs.seen(key):
            return FireOutcome(job_id, scheduled_for, fired=False, status="skipped",
                               reason="duplicate fire (idempotency)")

        # Fire-time preflight (AX-060): re-evaluate perms/creator/kill-switch NOW.
        pf = fire(job, engine, user_status=user_status,
                  org_automations_enabled=org_automations_enabled)
        if not pf.proceed:
            # A preflight skip (revoked right, kill-switch) is not recorded — a later retry
            # re-evaluates against current policy rather than being frozen as "handled".
            return FireOutcome(job_id, scheduled_for, fired=False, status="skipped",
                               error_code=pf.code, reason=pf.reason)

        # Re-inject as a scheduler-channel message through the SAME pipeline (ADR 005).
        inbound = {
            "message_id": f"{job_id}:{scheduled_for}", "user_id": job.user_id,
            "org_id": job.org_id, "conversation_id": f"cron:{job_id}", "channel": "scheduler",
            "text": job.prompt, "scheduled_for": scheduled_for,
            "idempotency_key": f"{job_id}:{scheduled_for}",
        }
        task = build_task(inbound, role=job.role, engine=engine)  # may raise — key not yet set
        self.runs.mark(key)  # record only now: the fire genuinely produced a task
        return FireOutcome(job_id, scheduled_for, fired=True, status="running", task=task)
