"""The 5-stage Prompt Layer pipeline (instructions.md §9).

InboundMessage → [memory · planning · guardrails · permissions · routing] → AgentTask
(+ signed TASK JWT). This minimal AX-013 build implements planning (classify),
input guardrails (injection heuristic, fail-closed), a permission stub
(allowed_tools by role) and routing (tier). Memory is a no-op hook for now.

Scheduler-channel messages traverse the SAME pipeline (§9 intro) — only difference
is no interactive approval: require_approval tools fail the call at run time unless
pre-approved (§15.6). That's a downstream concern; the task we emit is identical.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field

from .classify import TASK_AGENTIQUE, classify
from .policy import Policy, PolicyEngine
from .task_jwt import TASK_JWT_SECRET, mint as _mint_task_jwt

# TASK_JWT_SECRET (the HS256 dev default secret) now lives in `task_jwt` alongside the
# config-gated ES256 seam (§13.4, ADR-012); re-exported here so existing importers keep
# working. HS256 stays the default — ES256 is opt-in via TASK_JWT_ALG=ES256.
TASK_JWT_ISS = "olma-prompt-layer"
TASK_JWT_AUD = "olma-mcp-gateway"
TASK_JWT_TTL = 900  # 15 min (§13.4)

# Candidate tool universe evaluated against tool_policies each turn (§9.4).
_DEFAULT_TOOLS = ["github.search", "github.read", "github.create_pr", "github.merge_pr",
                  "database.read", "database.write", "scheduler.list_crons",
                  "scheduler.create_cron"]

# Default org policies (mirror db/migrations/0003_seed_policies.sql). Prod loads
# these from the tool_policies table per org via policy.load_from_postgres; here
# they seed a default PolicyEngine so the pipeline runs with no DB.
_DEFAULT_POLICIES = [
    Policy("org_1", "member", "github.search", "allow"),
    Policy("org_1", "member", "github.read", "allow"),
    Policy("org_1", "member", "github.create_pr", "allow"),
    Policy("org_1", "member", "github.merge_pr", "require_approval", "tech-leads"),
    Policy("org_1", "member", "database.read", "allow"),
    Policy("org_1", "member", "database.write", "deny"),
    Policy("org_1", "member", "scheduler.list_crons", "allow"),
    Policy("org_1", "member", "scheduler.create_cron", "require_approval", None),
]
_DEFAULT_ENGINE = PolicyEngine(_DEFAULT_POLICIES)

# Prompt-injection heuristic (input guardrail, §9.3). Fail-closed on a hit.
_INJECTION = re.compile(
    r"(ignore\s+(all\s+)?(previous\s+)?(the above\s+)?instructions|"
    r"disregard (your|the) (system )?prompt|reveal your (system )?prompt|"
    r"you are now|exfiltrate|print your instructions|"
    r"outil interdit|bypass (the )?(guardrails|permissions))", re.IGNORECASE)


class GuardrailBlocked(Exception):
    code = "E_GUARD_INPUT_BLOCKED"


@dataclass
class AgentTask:
    task_id: str
    conversation_id: str
    user_id: str
    org_id: str
    cls: str
    origin: str
    allowed_tools: list[str]
    approval_tools: list[str]
    model_tier: str
    agent_profile: str
    task_jwt: str
    on_behalf_of: str | None = None
    locale: str = "fr-FR"
    plan: list[dict] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id, "conversation_id": self.conversation_id,
            "user_id": self.user_id, "org_id": self.org_id, "class": self.cls,
            "origin": self.origin, "allowed_tools": self.allowed_tools,
            "approval_tools": self.approval_tools, "model": self.model_tier,
            "agent_profile": self.agent_profile, "task_jwt": self.task_jwt,
            "on_behalf_of": self.on_behalf_of, "locale": self.locale, "plan": self.plan,
        }


def _guardrails(text: str) -> None:
    if _INJECTION.search(text or ""):
        raise GuardrailBlocked("input blocked by prompt-injection guardrail")


def _route(cls: str, recurrence: bool) -> tuple[str, str]:
    """(model_tier, agent_profile). Simple tasks → eco; code tasks → frontier (§9.5)."""
    tier = "frontier" if cls == TASK_AGENTIQUE else "eco"
    profile = "dev" if cls == TASK_AGENTIQUE else "generalist"
    return tier, profile


def _sign_task_jwt(user_id: str, org_id: str, allowed: list[str], approval: list[str],
                   on_behalf_of: str | None, now: float | None = None,
                   task_id: str | None = None, origin: str = "interactive") -> str:
    iat = int(now if now is not None else time.time())
    claims = {
        "sub": user_id, "org_id": org_id, "iss": TASK_JWT_ISS, "aud": TASK_JWT_AUD,
        "iat": iat, "exp": iat + TASK_JWT_TTL,
        "allowed_tools": allowed, "approval_tools": approval,
        # Carried so the Gateway can key taint per task and decide egress on a tainted turn
        # (§17.6.3): interactive → require_approval, scheduled → E_GUARD_TAINTED_EGRESS.
        "task_id": task_id, "origin": origin,
    }
    if on_behalf_of:
        claims["sub"] = f"agent-org@{org_id}"
        claims["on_behalf_of"] = on_behalf_of
    return _mint_task_jwt(claims)


def reapprove_task_jwt(user_id: str, org_id: str, tool: str,
                       allowed: list[str], approval: list[str],
                       on_behalf_of: str | None = None, now: float | None = None) -> str:
    """Re-mint a TASK JWT after a human approves a gated tool (§13.3, the approval loop).

    The gateway returns `needs_approval` whenever the tool is still in `approval_tools`; it
    never executes an approval-gated tool inline. Once a human approves, this promotes exactly
    that tool from `approval_tools` into `allowed_tools` and re-issues a fresh short-lived token,
    so a re-invoke now passes the gateway. Only the approved tool moves — every other gate stays.
    """
    promoted_allowed = allowed if tool in allowed else [*allowed, tool]
    promoted_approval = [t for t in approval if t != tool]
    return _sign_task_jwt(user_id, org_id, promoted_allowed, promoted_approval,
                          on_behalf_of, now=now)


def build_task(inbound: dict, *, role: str = "member", task_id: str | None = None,
               now: float | None = None, engine: PolicyEngine | None = None) -> AgentTask:
    """Run the pipeline on an InboundMessage dict → AgentTask (raises GuardrailBlocked).

    `engine` is the tool_policies evaluator; defaults to the seeded default engine.
    Prod passes an engine loaded from Postgres for the message's org (§9.4) — this
    is what makes permissions re-evaluate at fire time for scheduled runs (§15.6).
    """
    # Validate the required InboundMessage keys once, up front. Three call sites build this
    # dict with divergent shapes (main.py / runner.py / scheduler.py); a missing key must be a
    # clean E_VALIDATION at the boundary, not a bare KeyError deep in the pipeline (which, inside
    # fire_job, would otherwise be masked and silently drop the run).
    missing = [k for k in ("org_id", "user_id", "conversation_id") if not inbound.get(k)]
    if missing:
        raise ValueError(f"inbound missing required field(s): {', '.join(missing)}")

    text = inbound.get("text", "")
    _guardrails(text)  # stage 3, fail-closed before anything else commits

    has_att = bool(inbound.get("attachments"))
    c = classify(text, has_attachments=has_att)  # stage 2 planning

    on_behalf_of = inbound.get("on_behalf_of")

    eng = engine or _DEFAULT_ENGINE
    # Mode B (§3.4): a shared org agent never touches personal/delegated connectors.
    candidate_tools = _DEFAULT_TOOLS
    if on_behalf_of:
        from .team_mode import filter_team_tools
        candidate_tools = filter_team_tools(_DEFAULT_TOOLS)
    allowed, approval, _groups = eng.compute_tools(inbound["org_id"], role, candidate_tools)  # stage 4
    tier, profile = _route(c.cls, c.recurrence)  # stage 5 routing
    origin = "scheduled" if inbound.get("channel") == "scheduler" else "interactive"
    tid = task_id or inbound.get("task_id") or f"task_{inbound.get('message_id', '0')}"
    jwt_str = _sign_task_jwt(inbound["user_id"], inbound["org_id"], allowed, approval,
                             on_behalf_of, now=now, task_id=tid, origin=origin)

    plan = []
    if c.cls == TASK_AGENTIQUE:
        plan = [{"step": "comprendre la demande", "done": False},
                {"step": "exécuter via les outils autorisés", "done": False},
                {"step": "récapituler et livrer", "done": False}]

    return AgentTask(
        task_id=tid, conversation_id=inbound["conversation_id"],
        user_id=inbound["user_id"], org_id=inbound["org_id"], cls=c.cls, origin=origin,
        allowed_tools=allowed, approval_tools=approval, model_tier=tier,
        agent_profile=profile, task_jwt=jwt_str, on_behalf_of=on_behalf_of,
        locale=inbound.get("locale", "fr-FR"), plan=plan,
    )
