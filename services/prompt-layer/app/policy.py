"""Permissions engine — tool_policies evaluation (instructions.md §9.4).

Evaluates (org_id, role, tool) → allow | require_approval | deny against the
`tool_policies` matrix (§16.1). Patterns support a trailing '*' (e.g. 'github.*');
the most specific match wins (exact > longer prefix > shorter prefix). Fail-closed:
no match → deny. Policies load from Postgres in prod; tests inject rows directly,
so the evaluator has no DB dependency.
"""

from __future__ import annotations

from dataclasses import dataclass

ALLOW = "allow"
REQUIRE_APPROVAL = "require_approval"
DENY = "deny"


@dataclass(frozen=True)
class Policy:
    org_id: str
    role: str
    tool_pattern: str      # exact ('github.merge_pr') or prefix ('github.*')
    effect: str            # allow | require_approval | deny
    approver_group: str | None = None


def _matches(pattern: str, tool: str) -> bool:
    if pattern.endswith(".*"):
        return tool.startswith(pattern[:-1])  # 'github.*' → tool starts 'github.'
    if pattern == "*":
        return True
    return pattern == tool


def _specificity(pattern: str) -> int:
    # Exact match is most specific; longer prefixes beat shorter; '*' is weakest.
    if pattern == "*":
        return 0
    if pattern.endswith(".*"):
        return len(pattern)      # longer prefix → higher
    return 10_000 + len(pattern)  # exact always beats any wildcard


class PolicyEngine:
    """Evaluates tool access from a set of tool_policies rows."""

    def __init__(self, policies: list[Policy]) -> None:
        self._policies = list(policies)

    def evaluate(self, org_id: str, role: str, tool: str) -> tuple[str, str | None]:
        """Return (effect, approver_group). Fail-closed to ('deny', None)."""
        candidates = [
            p for p in self._policies
            if p.org_id == org_id and p.role == role and _matches(p.tool_pattern, tool)
        ]
        if not candidates:
            return (DENY, None)
        best = max(candidates, key=lambda p: _specificity(p.tool_pattern))
        return (best.effect, best.approver_group)

    def compute_tools(self, org_id: str, role: str, tools: list[str]) -> tuple[list[str], list[str], dict]:
        """For a candidate tool list → (allowed_tools, approval_tools, approver_groups)."""
        allowed, approval, groups = [], [], {}
        for tool in tools:
            effect, group = self.evaluate(org_id, role, tool)
            if effect == ALLOW:
                allowed.append(tool)
            elif effect == REQUIRE_APPROVAL:
                allowed.append(tool)      # may be called, but gated
                approval.append(tool)
                if group:
                    groups[tool] = group
            # deny → excluded entirely (fail-closed)
        return allowed, approval, groups


async def load_from_postgres(dsn: str, org_id: str) -> list[Policy]:
    """Load an org's policies from the tool_policies table (§16.1)."""
    import asyncpg

    con = await asyncpg.connect(dsn)
    try:
        rows = await con.fetch(
            "SELECT org_id, role, tool_pattern, effect, approver_group "
            "FROM tool_policies WHERE org_id=$1", org_id)
    finally:
        await con.close()
    return [Policy(r["org_id"], r["role"], r["tool_pattern"], r["effect"],
                   r["approver_group"]) for r in rows]
