"""Task planning — 3-7 step decomposition (instructions.md §9.2).

For a task_agentique turn the planner produces a high-level plan (3-7 steps)
inserted into the agent's system prompt; the agent may revise it, but the plan
frames execution and drives client-side progress display (§7.2.1 milestones). It
also surfaces the automation intent (§9.2) and a rough budget tier. Prod uses the
LLM for this; here a deterministic decomposition keyed on detected actions/tools.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Ordered action detectors → a canonical step. First match wins per category so a
# multi-verb request ("déploie et merge") yields ordered, deduped steps.
_STEP_RULES: list[tuple[re.Pattern, str]] = [
    (re.compile(r"\b(cherche|search|trouve|find|lis|read|regarde|look)\b", re.I),
     "chercher et lire les éléments pertinents"),
    (re.compile(r"\b(analyse|analyze|compare|évalue|vérifie|check|ci)\b", re.I),
     "analyser / vérifier (CI, données)"),
    (re.compile(r"\b(crée|create|écris|write|génère|generate|ouvre|open|branch|pr|commit)\b", re.I),
     "créer le changement (branche / PR / fichier)"),
    (re.compile(r"\b(déploie|deploy|staging|prod|release|merge|push|apply)\b", re.I),
     "déployer / merger (sous approbation)"),
    (re.compile(r"\b(envoie|send|poste|post|notifie|notify|préviens|préviens|récap|digest)\b", re.I),
     "notifier / livrer le résultat"),
]


@dataclass
class Plan:
    steps: list[str]
    automation_intent: bool
    budget_tier: str  # "eco" | "frontier"

    def as_dicts(self) -> list[dict]:
        return [{"step": s, "done": False} for s in self.steps]


def decompose(text: str, *, recurrence: bool = False, agentic: bool = True) -> Plan:
    """Build a 3-7 step plan for a task (§9.2). chat_simple → a single answer step."""
    if not agentic:
        return Plan(["répondre directement"], recurrence, "eco")

    steps: list[str] = ["comprendre et cadrer la demande"]
    for rx, step in _STEP_RULES:
        if rx.search(text) and step not in steps:
            steps.append(step)

    # Always close with a recap; ensure a floor of 3 and a ceiling of 7 (§9.2).
    if "récapituler et livrer" not in steps and len(steps) < 7:
        steps.append("récapituler et livrer")
    if len(steps) < 3:
        steps.insert(1, "exécuter via les outils autorisés")
    steps = steps[:7]

    # An automation request adds the scheduler confirmation step (§9.2).
    if recurrence and len(steps) < 7:
        steps.insert(1, "confirmer l'horaire et créer l'automatisation")

    tier = "frontier" if agentic else "eco"
    return Plan(steps, recurrence, tier)
