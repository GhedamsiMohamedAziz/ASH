"""Turn routing + mid-turn escalation (instructions.md §7.2.1, §9.2).

A mention is classified fast (chat_simple vs task_agentique); simple turns answer
directly with no sandbox (the cost-critical path, §25). Classification is
REVERSIBLE: if a chat_simple turn reveals a tool need, the turn escalates to
task_agentique (agent.escalated), the sandbox wakes, and the client shows "je
regarde dans <outil>…". The fail-safe is always start light → escalate, never the
reverse (waking a sandbox "just in case" is expensive and slow).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from .classify import AMBIGU, CHAT_SIMPLE, TASK_AGENTIQUE, classify

# Signals, discovered mid-answer, that a "simple" turn actually needs tools.
_TOOL_NEED = re.compile(
    r"\b(dans le repo|in the repo|regarde|check the|vérifie dans|look (in|at) the|"
    r"la PR|the PR|le ticket|the issue|en base|in the database|les logs|the logs|"
    r"sur staging|on staging|le fichier|the file|dans le code|in the code)\b", re.I)


@dataclass
class Route:
    path: str          # chat_simple | task_agentique
    wake_sandbox: bool
    reason: str


def route(text: str, has_attachments: bool = False) -> Route:
    """Initial routing decision (§7.2.1). Ambiguous starts light."""
    c = classify(text, has_attachments=has_attachments)
    if c.cls == TASK_AGENTIQUE:
        return Route(TASK_AGENTIQUE, True, "agentic: needs tools/sandbox")
    # chat_simple AND ambigu both start without a sandbox.
    return Route(CHAT_SIMPLE, False, "simple: direct LLM answer, no sandbox")


@dataclass
class Escalation:
    escalated: bool
    event: dict | None = None  # the agent.escalated payload (§7.4)


def maybe_escalate(current_path: str, discovered_text: str) -> Escalation:
    """Called mid-turn: if a chat_simple turn reveals a tool need, escalate (§7.2.1).

    `discovered_text` is what the agent is about to say/needs (e.g. it decided it
    must read the repo). Escalation is one-way: simple → agentique only.
    """
    if current_path != CHAT_SIMPLE:
        return Escalation(False)
    if _TOOL_NEED.search(discovered_text):
        return Escalation(True, {"type": "agent.escalated",
                                 "data": {"from": CHAT_SIMPLE, "to": TASK_AGENTIQUE}})
    return Escalation(False)
