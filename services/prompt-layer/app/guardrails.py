"""Input guardrails (instructions.md §9.3) — fail-closed, before the agent.

Four checks, run in order; the first block wins:
  1. prompt-injection (classifier heuristics + attachment heuristics),
  2. PII leaving the org perimeter (optional per org),
  3. org content policy (blocked categories, configurable per org),
  4. cron re-scan: a cron's prompt is re-checked at each fire (§9.3) — a policy
     that changed since creation can auto-pause the job.
Emits the §21 code so the adapter renders a localized message; never leaks which
detector fired or the matched span (§9.3 "motif catégorisé, jamais le détail").
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# --- 1. injection ---------------------------------------------------------
_INJECTION = [
    re.compile(r"ignore\s+(all\s+)?(previous\s+|the above\s+)?instructions", re.I),
    re.compile(r"disregard (your|the) (system )?prompt", re.I),
    re.compile(r"reveal (your|the) (system )?(prompt|instructions)", re.I),
    re.compile(r"you are now (a|an|in) ", re.I),
    re.compile(r"(exfiltrate|leak) (the |all )?(secret|token|credential|data)", re.I),
    re.compile(r"print (your|the) (system )?(prompt|instructions|config)", re.I),
    re.compile(r"bypass (the )?(guardrails|permissions|policy)", re.I),
    re.compile(r"(new|updated) (system )?instructions?\s*[:：]", re.I),
]
# Attachment heuristic: instructions embedded in a "document" that address the model.
_ATTACH_INJECTION = re.compile(
    r"(assistant\s*[:：]|<system>|\[system\]|as an ai|when you read this,? (ignore|do))", re.I)

# --- 2. PII ---------------------------------------------------------------
_PII = {
    "email": re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]+\b"),
    "credit_card": re.compile(r"\b(?:\d[ -]?){13,16}\b"),
    "iban": re.compile(r"\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b"),
    "ssn_fr": re.compile(r"\b[12]\d{2}(0[1-9]|1[0-2])\d{2}\d{3}\d{3}\d{2}\b"),
}


@dataclass
class OrgPolicy:
    pii_filter: bool = False              # block PII leaving the perimeter
    blocked_categories: set[str] = field(default_factory=set)  # e.g. {"health","legal_advice"}


_CATEGORY_SIGNALS = {
    "health": re.compile(r"\b(diagnos\w*|prescription|medical records?|dossier médical|maladie)\b", re.I),
    "legal_advice": re.compile(r"\b(legal advice|conseil juridique|poursuite|lawsuit)\b", re.I),
}


class GuardrailBlocked(Exception):
    def __init__(self, category: str) -> None:
        super().__init__(category)
        self.category = category
        self.code = "E_GUARD_INPUT_BLOCKED"


def check_input(text: str, *, attachments_text: str = "", policy: OrgPolicy | None = None) -> None:
    """Run the input guardrails; raise GuardrailBlocked on the first violation."""
    policy = policy or OrgPolicy()

    for rx in _INJECTION:
        if rx.search(text):
            raise GuardrailBlocked("prompt_injection")
    if attachments_text and _ATTACH_INJECTION.search(attachments_text):
        raise GuardrailBlocked("attachment_injection")

    if policy.pii_filter:
        for _name, rx in _PII.items():
            if rx.search(text):
                raise GuardrailBlocked("pii")

    for cat in policy.blocked_categories:
        rx = _CATEGORY_SIGNALS.get(cat)
        if rx and rx.search(text):
            raise GuardrailBlocked("content_policy")


def rescan_cron_prompt(prompt: str, policy: OrgPolicy) -> bool:
    """Re-scan a cron prompt at fire time (§9.3). Returns True if still compliant;
    False → the job must auto-pause (org policy changed since creation)."""
    try:
        check_input(prompt, policy=policy)
        return True
    except GuardrailBlocked:
        return False
