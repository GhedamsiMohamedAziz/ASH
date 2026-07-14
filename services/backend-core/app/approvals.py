"""Human-in-the-loop approvals (instructions.md §13.3, §3.3).

A require_approval tool call suspends and raises an approval request; the user (or,
in team mode, a member of the designated approver_group) resolves it Approve/Deny.
Both requester and approver are recorded for audit (§3.2). Pending approvals expire
(prod: Redis TTL); an expired or denied request never executes the tool (fail-closed).
"""

from __future__ import annotations

import itertools
from dataclasses import dataclass, field
from enum import Enum


class ApprovalStatus(str, Enum):
    pending = "pending"
    approved = "approved"
    denied = "denied"
    expired = "expired"


class ApprovalError(Exception):
    pass


@dataclass
class Approval:
    id: str
    conversation_id: str
    tool: str
    args_summary: str
    requester: str                 # who asked (on_behalf_of in team mode)
    approver_group: str | None     # None → the requester approves (Mode A, §3.3)
    created_at: float
    expires_at: float
    status: ApprovalStatus = ApprovalStatus.pending
    approver: str | None = None    # who actually decided
    # Replay context captured when the gated call was raised (§13.3). On approve, backend-core
    # re-mints a TASK JWT with `tool` promoted and re-invokes it through the gateway with `args`.
    user_id: str = ""
    org_id: str = ""
    args: dict | None = None
    allowed_tools: list[str] = field(default_factory=list)
    approval_tools: list[str] = field(default_factory=list)

    def is_open(self, now: float) -> bool:
        return self.status is ApprovalStatus.pending and now < self.expires_at


class ApprovalManager:
    def __init__(self, ttl_seconds: float = 900) -> None:
        self._ids = itertools.count(1)
        self._ttl = ttl_seconds
        self.approvals: dict[str, Approval] = {}

    def create(self, *, conversation_id: str, tool: str, args_summary: str,
               requester: str, approver_group: str | None, now: float,
               user_id: str = "", org_id: str = "", args: dict | None = None,
               allowed_tools: list[str] | None = None,
               approval_tools: list[str] | None = None) -> Approval:
        aid = f"appr_{next(self._ids):08d}"
        appr = Approval(
            id=aid, conversation_id=conversation_id, tool=tool, args_summary=args_summary,
            requester=requester, approver_group=approver_group,
            created_at=now, expires_at=now + self._ttl,
            user_id=user_id, org_id=org_id, args=args or {},
            allowed_tools=list(allowed_tools or []), approval_tools=list(approval_tools or []),
        )
        self.approvals[aid] = appr
        return appr

    @staticmethod
    def promote(appr: Approval) -> tuple[list[str], list[str]]:
        """The (allowed_tools, approval_tools) an approved tool should carry on re-issue: the
        tool moves out of approval and into allowed. Pure — the actual mint lives in the
        prompt-layer (§13.3). Only valid for an approved request."""
        if appr.status is not ApprovalStatus.approved:
            raise ApprovalError("cannot promote a non-approved request")
        allowed = appr.allowed_tools if appr.tool in appr.allowed_tools \
            else [*appr.allowed_tools, appr.tool]
        approval = [t for t in appr.approval_tools if t != appr.tool]
        return allowed, approval

    def get(self, approval_id: str) -> Approval | None:
        return self.approvals.get(approval_id)

    def resolve(self, approval_id: str, *, decision: str, approver: str,
                now: float, approver_in_group: bool = False) -> Approval:
        """Approve/deny a pending request. Enforces the §3.3 approver rule."""
        appr = self.approvals.get(approval_id)
        if appr is None:
            raise ApprovalError("no such approval")
        if not appr.is_open(now):
            if appr.status is ApprovalStatus.pending:
                appr.status = ApprovalStatus.expired
            raise ApprovalError(f"approval is {appr.status.value}")
        if decision not in ("approve", "deny"):
            raise ApprovalError("decision must be approve|deny")

        # Team mode: the decider must belong to the designated approver group and
        # must not be the requester approving their own high-impact action (§3.3).
        # `approver_in_group` defaults to False (fail closed): a caller that forgets to
        # compute membership denies rather than admits. Self-approve is checked first so
        # a requester is always rejected with the specific reason, group or not.
        if appr.approver_group is not None:
            if approver == appr.requester:
                raise ApprovalError("requester cannot self-approve a group-gated tool")
            if not approver_in_group:
                raise ApprovalError("approver not in the designated group")

        appr.status = ApprovalStatus.approved if decision == "approve" else ApprovalStatus.denied
        appr.approver = approver
        return appr

    def audit_detail(self, appr: Approval) -> dict:
        """Every approval logs requester AND approver (§3.2)."""
        return {
            "approval_id": appr.id, "tool": appr.tool, "status": appr.status.value,
            "requester": appr.requester, "approver": appr.approver,
            "approver_group": appr.approver_group,
        }
