"""Request classification (instructions.md §9.2, §7.2.1).

chat_simple (answer directly, no sandbox) vs task_agentique (needs tools/sandbox).
Prod uses a light eco model (Haiku, few-shot JSON) in ~250ms; here a fast
deterministic heuristic stands in — same contract: {class, confidence}, with
confidence < 0.7 → 'ambigu' (which starts light and escalates, never the reverse).
The decision is reversible mid-turn via agent.escalated (§7.2.1).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

CHAT_SIMPLE = "chat_simple"
TASK_AGENTIQUE = "task_agentique"
AMBIGU = "ambigu"

# Signals that a turn needs tools/sandbox (action verbs, tool nouns, deployment).
_ACTION = re.compile(
    r"\b(déploie|deploy|merge|commit|push|crée|create|ouvre|open|run|exécute|execute|"
    r"lance|build|fix|corrige|refactor|migre|migrate|analyse|analyze|génère|generate|"
    r"cherche dans|search in|requête|query|envoie|send|poste|post)\b",
    re.IGNORECASE,
)
_TOOL_NOUN = re.compile(
    r"\b(pr|pull request|issue|branch|branche|repo|sentry|outlook|mail|email|"
    r"calendar|calendrier|sharepoint|notion|database|base de données|sql|"
    r"staging|prod|production|ci|pipeline|cron|schedule)\b",
    re.IGNORECASE,
)
# Signals of a plain question (answer from memory/LLM, no tools).
_QUESTION = re.compile(r"^\s*(quoi|what|qu'est|comment|how|pourquoi|why|c'est quoi|"
                       r"peux-tu expliquer|can you explain|quelle est|what is)\b", re.IGNORECASE)
_RECURRENCE = re.compile(
    r"\b(chaque|tous les|toutes les|every|each|daily|hebdo|weekly|monthly|"
    r"lundi|mardi|matin|morning|à \d+h|at \d+ ?(am|pm)|quotidien)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Classification:
    cls: str
    confidence: float
    recurrence: bool  # automation intent detected (§9.2)

    @property
    def needs_sandbox(self) -> bool:
        return self.cls == TASK_AGENTIQUE


def classify(text: str, has_attachments: bool = False) -> Classification:
    t = (text or "").strip()
    recurrence = bool(_RECURRENCE.search(t))

    action = bool(_ACTION.search(t))
    tool = bool(_TOOL_NOUN.search(t))
    question = bool(_QUESTION.match(t))

    # A plain question with no action verb is simple even if it names a tool
    # concept — "what is our branch convention?" asks ABOUT a repo, it doesn't
    # act on one. The action verb, not the noun, is what needs a sandbox.
    if question and not action:
        return Classification(CHAT_SIMPLE, 0.85, recurrence)
    # Strong agentic signals.
    if (action and tool) or has_attachments or (action and len(t) > 80):
        return Classification(TASK_AGENTIQUE, 0.9, recurrence)
    # Weak agentic: an action verb OR a tool noun alone.
    if action or tool:
        return Classification(TASK_AGENTIQUE, 0.7, recurrence)
    # Otherwise ambiguous → start light, escalate on demand (§7.2.1).
    return Classification(AMBIGU, 0.5, recurrence)
