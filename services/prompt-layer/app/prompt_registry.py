"""Prompt registry + feedback→evals loop (instructions.md §20).

System prompts are versioned artifacts, not strings scattered in code: each has an
id + monotonically increasing version, and the active version per (id) is pinned.
User feedback (thumbs, approval refusals) is captured against the prompt version
that produced the turn, so a regression is attributable to a specific prompt change
and can seed a new eval case (§20 feedback→évals).
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class PromptVersion:
    prompt_id: str
    version: int
    text: str


@dataclass
class Feedback:
    prompt_id: str
    version: int
    signal: str        # up | down | approval_refused
    note: str = ""


@dataclass
class PromptRegistry:
    _versions: dict[str, list[PromptVersion]] = field(default_factory=dict)
    _active: dict[str, int] = field(default_factory=dict)
    feedback: list[Feedback] = field(default_factory=list)

    def register(self, prompt_id: str, text: str) -> PromptVersion:
        """Add a new version (immutable); it becomes active."""
        versions = self._versions.setdefault(prompt_id, [])
        pv = PromptVersion(prompt_id, len(versions) + 1, text)
        versions.append(pv)
        self._active[prompt_id] = pv.version
        return pv

    def active(self, prompt_id: str) -> PromptVersion:
        v = self._active[prompt_id]
        return self._versions[prompt_id][v - 1]

    def pin(self, prompt_id: str, version: int) -> None:
        """Roll back / pin the active version (a prompt regression fix)."""
        if not (1 <= version <= len(self._versions.get(prompt_id, []))):
            raise KeyError("no such version")
        self._active[prompt_id] = version

    def record_feedback(self, fb: Feedback) -> None:
        self.feedback.append(fb)

    def regression_signal(self, prompt_id: str) -> dict:
        """Down/refusal rate for the ACTIVE version vs the previous — feeds §20 loop.
        A jump is a candidate for a new eval case + a rollback."""
        active_v = self._active.get(prompt_id)
        if active_v is None or active_v < 2:
            return {"comparable": False}

        def rate(v: int) -> float:
            fbs = [f for f in self.feedback if f.prompt_id == prompt_id and f.version == v]
            if not fbs:
                return 0.0
            bad = sum(1 for f in fbs if f.signal in ("down", "approval_refused"))
            return bad / len(fbs)

        cur, prev = rate(active_v), rate(active_v - 1)
        return {"comparable": True, "active_version": active_v,
                "current_bad_rate": round(cur, 3), "previous_bad_rate": round(prev, 3),
                "regressed": cur > prev}
