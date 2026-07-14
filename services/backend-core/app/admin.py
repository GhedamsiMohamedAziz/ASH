"""Admin console API logic (instructions.md §24.1-24.3).

Backend for the ops console. RBAC:
  • platform_admin — all orgs + infra (a dedicated JWT claim, granted out-of-band
    via the platform_admins table, never the public API, §24.1),
  • admin (org)    — that org only.
Every admin action is written to the audit log with actor=admin (§24.1), including
the platform_admin's. `view_as` is read-only and requires a reason (§24.1).
"""

from __future__ import annotations

from dataclasses import dataclass, field


class AdminDenied(Exception):
    code = "E_PERM_TOOL_DENIED"


@dataclass
class Actor:
    user_id: str
    org_id: str
    role: str                 # member|power_user|admin
    platform_admin: bool = False


@dataclass
class ToolPolicy:
    org_id: str
    role: str
    tool_pattern: str
    effect: str               # allow|deny|require_approval
    approver_group: str | None = None


@dataclass
class AdminService:
    """In-memory admin store (Postgres in prod). Records an audit trail per action."""

    orgs: dict[str, dict] = field(default_factory=dict)
    policies: list[ToolPolicy] = field(default_factory=list)
    budgets: dict[str, float] = field(default_factory=dict)   # org_id -> monthly cap
    audit: list[dict] = field(default_factory=list)

    # -- authorization --------------------------------------------
    def _authorize(self, actor: Actor, org_id: str) -> None:
        if actor.platform_admin:
            return
        if actor.role != "admin" or actor.org_id != org_id:
            raise AdminDenied("requires org admin for this org")

    def _log(self, actor: Actor, action: str, target: str, **details) -> None:
        # Every admin action audited with actor=admin (§24.1), incl. platform_admin.
        self.audit.append({
            "actor": "admin", "admin_id": actor.user_id,
            "platform_admin": actor.platform_admin, "action": action,
            "target": target, "details": details,
        })

    # -- operations -----------------------------------------------
    def set_policy(self, actor: Actor, policy: ToolPolicy) -> None:
        self._authorize(actor, policy.org_id)
        self.policies = [p for p in self.policies
                         if not (p.org_id == policy.org_id and p.role == policy.role
                                 and p.tool_pattern == policy.tool_pattern)]
        self.policies.append(policy)
        self._log(actor, "policy.set", f"{policy.org_id}:{policy.role}:{policy.tool_pattern}",
                  effect=policy.effect)

    def set_budget(self, actor: Actor, org_id: str, monthly_usd: float) -> None:
        self._authorize(actor, org_id)
        self.budgets[org_id] = monthly_usd
        self._log(actor, "budget.set", org_id, monthly_usd=monthly_usd)

    def list_policies(self, actor: Actor, org_id: str) -> list[ToolPolicy]:
        self._authorize(actor, org_id)
        return [p for p in self.policies if p.org_id == org_id]

    def query_audit(self, actor: Actor, org_id: str) -> list[dict]:
        self._authorize(actor, org_id)
        # org admins see only their org's rows; platform_admin sees all.
        if actor.platform_admin:
            return list(self.audit)
        return [a for a in self.audit if org_id in a.get("target", "")]

    def view_as(self, actor: Actor, target_user: str, org_id: str, reason: str) -> dict:
        """Read-only impersonation for support (§24.1) — logged with mandatory reason."""
        self._authorize(actor, org_id)
        if not reason.strip():
            raise AdminDenied("view-as requires a reason")
        self._log(actor, "view_as", target_user, org_id=org_id, reason=reason, read_only=True)
        return {"viewing": target_user, "read_only": True}
