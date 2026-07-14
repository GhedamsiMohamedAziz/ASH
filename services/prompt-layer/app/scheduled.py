"""Fire-time preflight for scheduled runs (instructions.md §9.4, §15.6, §18.3, ADR 006).

A cron carries NO tokens and NO frozen permissions (Principle #7). At each fire the
platform re-evaluates, against the CURRENT state:
  1. the creator's status (SCIM) — offboarded/suspended → pause,
  2. the org kill-switch (`automations.enabled`) — off → pause,
  3. the permissions the job needs — any tool now denied → E_PERM_REVOKED, pause,
  4. consecutive failures — ≥ 3 → auto-pause.
Only if all pass does the scheduled run re-enter the standard pipeline (§9). A user
who loses a right sees the automation degrade or pause, never the reverse.

This is the prompt-layer half of the automation subsystem; the Trigger.dev
scheduler (automation-service, TS) fires jobs and calls this preflight before
re-injecting the InboundMessage into backend-core /internal/scheduled-runs.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum

from .policy import ALLOW, REQUIRE_APPROVAL, PolicyEngine

MAX_CONSECUTIVE_FAILURES = 3


class JobStatus(str, Enum):
    draft = "draft"
    pending_approval = "pending_approval"
    active = "active"
    paused = "paused"
    deleted = "deleted"


class UserStatus(str, Enum):
    active = "active"
    suspended = "suspended"
    offboarded = "offboarded"


@dataclass
class ScheduledJob:
    id: str
    user_id: str
    org_id: str
    role: str
    prompt: str
    required_tools: list[str]           # tools the job's prompt needs
    cron: str
    status: JobStatus = JobStatus.active
    consecutive_failures: int = 0
    pre_approved_tools: list[str] = field(default_factory=list)
    pause_reason: str | None = None


@dataclass
class PreflightResult:
    proceed: bool
    code: str | None = None            # taxonomy §21 when paused
    reason: str | None = None
    pause: bool = False


def preflight(
    job: ScheduledJob,
    engine: PolicyEngine,
    *,
    user_status: UserStatus,
    org_automations_enabled: bool = True,
) -> PreflightResult:
    """Re-evaluate a job at fire time. Returns proceed | pause(+code). Fail-closed."""
    if job.status is not JobStatus.active:
        return PreflightResult(False, "E_SCHED_JOB_PAUSED", f"job is {job.status.value}")

    # 1. creator status (SCIM sync with the IdP) — §15.6
    if user_status is not UserStatus.active:
        return PreflightResult(False, "E_PERM_REVOKED",
                               f"creator is {user_status.value}", pause=True)

    # 2. org kill-switch — §15.6
    if not org_automations_enabled:
        return PreflightResult(False, "E_SCHED_JOB_PAUSED",
                               "org automations disabled", pause=True)

    # 3. permissions AT THE FIRE — every required tool must still be permitted.
    #    A tool that became `deny` (or unknown → deny) revokes the job. A tool
    #    that became `require_approval` is only OK if it was pre-approved (§15.6).
    for tool in job.required_tools:
        effect, _group = engine.evaluate(job.org_id, job.role, tool)
        if effect == ALLOW:
            continue
        if effect == REQUIRE_APPROVAL and tool in job.pre_approved_tools:
            continue
        return PreflightResult(False, "E_PERM_REVOKED",
                               f"permission for {tool} is now '{effect}'", pause=True)

    # 4. consecutive-failure circuit breaker — §15.6
    if job.consecutive_failures >= MAX_CONSECUTIVE_FAILURES:
        return PreflightResult(False, "E_SCHED_JOB_PAUSED",
                               "3 consecutive failures", pause=True)

    return PreflightResult(True)


def fire(
    job: ScheduledJob,
    engine: PolicyEngine,
    *,
    user_status: UserStatus,
    org_automations_enabled: bool = True,
) -> PreflightResult:
    """Apply preflight and mutate the job's status on a pause verdict (§15.4)."""
    result = preflight(job, engine, user_status=user_status,
                       org_automations_enabled=org_automations_enabled)
    if result.pause and job.status is JobStatus.active:
        job.status = JobStatus.paused
        job.pause_reason = result.reason
    return result


def resume(job: ScheduledJob, engine: PolicyEngine, *, user_status: UserStatus,
           org_automations_enabled: bool = True) -> PreflightResult:
    """Resume re-verifies quotas + policy before going ACTIVE again (§15.4)."""
    if job.status is not JobStatus.paused:
        return PreflightResult(False, "E_SCHED_JOB_PAUSED", "job not paused")
    probe = ScheduledJob(**{**job.__dict__, "status": JobStatus.active})
    check = preflight(probe, engine, user_status=user_status,
                      org_automations_enabled=org_automations_enabled)
    if check.proceed:
        job.status = JobStatus.active
        job.pause_reason = None
        return PreflightResult(True)
    return check
