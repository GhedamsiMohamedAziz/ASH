"""Mode B — shared team agent configuration (instructions.md §3).

The recommended MVP: one org-agent on the org's service credentials, used by the
whole team. Not a rewrite, a configuration (§3 intro):
  • the requester's identity still drives authz + approval + audit (§3.2),
  • the TASK JWT sub becomes `agent-org@<org>` + an `on_behalf_of` claim,
  • personal/delegated connectors (Outlook OBO, DM, personal mail) are DISABLED —
    a shared agent does not read "my mail" (§3.4).
"""

from __future__ import annotations

# Connectors excluded in Mode B (delegated/personal data). A shared org agent
# must never touch these (§3.4); requesting one is denied before policy eval.
PERSONAL_CONNECTORS = frozenset({
    "outlook.read", "outlook.send", "outlook.search",  # personal mail (OBO)
    "slack.dm_read", "slack.dm_send",                   # direct messages
    "calendar.personal",                                # personal calendar
})


def is_personal_connector(tool: str) -> bool:
    return tool in PERSONAL_CONNECTORS


def team_inbound(inbound: dict, requester_id: str) -> dict:
    """Mark an InboundMessage as team-mode: it runs on the org agent on behalf of
    the requester. Sets `on_behalf_of` so build_task emits sub=agent-org@<org>."""
    out = dict(inbound)
    out["on_behalf_of"] = requester_id
    return out


def filter_team_tools(tools: list[str]) -> list[str]:
    """Strip personal connectors from a candidate tool list in Mode B (§3.4)."""
    return [t for t in tools if not is_personal_connector(t)]
