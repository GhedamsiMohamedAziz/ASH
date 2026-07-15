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
    # EN core. `ignore … instructions` tolerates bounded filler words between the
    # verb and its object ("ignore your previous instructions", "kindly ignore any
    # previous instructions") without matching unrelated "ignore the noise …".
    re.compile(r"ignore\s+(\w+\s+){0,3}instructions", re.I),
    re.compile(r"disregard (your|the) (system )?prompt", re.I),
    re.compile(r"reveal (your|the) (system )?(prompt|instructions)", re.I),
    re.compile(r"you are now (a|an|in) ", re.I),
    # Bare persona/jailbreak ("you are now DAN/root", not "you are now on the waitlist").
    re.compile(r"you are now\b.{0,20}\b(dan|root|jailbroken|jailbreak|unrestricted|god\s*mode|no restrictions?|do anything now|developer mode)\b", re.I),
    re.compile(r"\bact as\b.{0,20}\b(an? )?(unrestricted|jailbroken|dan|uncensored|evil) ", re.I),
    re.compile(r"from now on\b.{0,40}\b(no (restrictions?|rules?|limits?|filters?)|unrestricted|you have no restrictions?)\b", re.I),
    re.compile(r"\bpretend\b.{0,30}\b(jailbroken|unrestricted|dan|uncensored|no restrictions?)\b", re.I),
    re.compile(r"(exfiltrate|leak) (the |all )?(secret|token|credential|data)", re.I),
    re.compile(r"print (your|the) (system )?(prompt|instructions|config)", re.I),
    re.compile(r"bypass (the )?(guardrails|permissions|policy)", re.I),
    re.compile(r"(new|updated) (system )?instructions?\s*[:：]", re.I),
    # FR variants (the corpus is bilingual, §20.2). `ignore … instructions` above
    # already covers "ignore (toutes) les instructions précédentes" (EN verb spelling).
    re.compile(r"oublie[rz]?\s+(\w+\s+){0,3}instructions", re.I),
    re.compile(r"(révèle|montre|affiche|dévoile|donne)(-?(moi|nous))?\s+(ton|le|la|votre|vos|tes|mes|ce)\s+.{0,20}(prompt|instructions?|syst[eè]me)", re.I),
    re.compile(r"tu es maintenant\s+.{0,40}(sans (restrictions?|limites?|r[eè]gles?|garde-fous?)|non restreint|jailbreak\w*|débridé)", re.I),
    re.compile(r"(contourne|désactive|neutralise)[rz]?\s+(les?\s+|la\s+|des\s+)?(garde[- ]?fous?|s[eé]curit[eé]s?|restrictions?|protections?)", re.I),
    re.compile(r"(exfiltre|vole|divulgue|envoie|fuite)[rz]?\s+.{0,30}(token|secret|credential|clé|mot de passe|identifiant)", re.I),
]
# Attachment heuristic: instructions embedded in a "document" that address the model.
_ATTACH_INJECTION = re.compile(
    r"(assistant\s*[:：]|<system>|\[system\]|as an ai|when you read this,? (ignore|do))", re.I)

# Light normalization for common obfuscation (§9.3): collapse letter-spacing and
# map leetspeak so `i g n o r e …` / `1gn0re all previous 1nstruct10ns` hit the same
# patterns. Arbitrary base64 / novel encodings are NOT deterministically decidable
# — those stay uncaught (tracked as KNOWN_GAP in the corpus), we do not decode the world.
_LEET = str.maketrans({"0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s"})
_SPACED = re.compile(r"(?<=\b\w)\s(?=\w\b)")


def _normalize(text: str) -> str:
    return _SPACED.sub("", text).translate(_LEET)

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

    norm = _normalize(text)
    for rx in _INJECTION:
        if rx.search(text) or rx.search(norm):
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
