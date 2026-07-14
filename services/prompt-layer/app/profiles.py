"""Agent profile selection (instructions.md §9.5).

Picks the OpenCode profile (dev / data-analyst / ops / generalist) from the
classification + content signals + user preference, or a job-pinned profile for a
cron. The profile decides which tools + model the sandbox loads (sandbox/profiles/).
"""

from __future__ import annotations

import re

PROFILES = ("dev", "data-analyst", "ops", "generalist")

_SIGNALS = {
    "dev": re.compile(r"\b(pr|pull request|branch|branche|commit|merge|repo|code|bug|"
                      r"refactor|deploy|déploie|ci|staging|test)\b", re.I),
    "data-analyst": re.compile(r"\b(sql|requête|query|données|data|churn|graphique|chart|"
                               r"rapport|report|analyse|analyze|métrique|metric|dashboard)\b", re.I),
    "ops": re.compile(r"\b(sentry|incident|on-call|alerte|alert|monitoring|log|erreur|"
                      r"error|deploy|rollback|prod)\b", re.I),
}


def select_profile(text: str, *, cls: str, user_pref: str | None = None,
                   job_profile: str | None = None) -> str:
    """Return the profile to load. Precedence: job pin > user pref > content > default."""
    # A cron pins its profile (§9.5) — deterministic, not re-inferred at each run.
    if job_profile in PROFILES:
        return job_profile
    # An explicit user preference wins over inference.
    if user_pref in PROFILES:
        return user_pref
    # chat_simple never needs a specialist profile.
    if cls == "chat_simple":
        return "generalist"

    # Score content signals; strongest wins, ties broken by PROFILES order (dev first).
    best, best_score = "generalist", 0
    for profile in ("dev", "data-analyst", "ops"):
        score = len(_SIGNALS[profile].findall(text))
        if score > best_score:
            best, best_score = profile, score
    return best
