"""Procedural memory — the learned how-to (instructions.md §9.1 type 3, §9.1.3).

`NOTES.md` + one note per project in the workspace (`/workspace/.agent/`, §11.3):
the *comment faire* the agent learns ("déploiement checkout : CI → tag → ArgoCD,
jamais de push direct") — often more useful than facts. Injected as
`<procedural_notes>` for the active project. A note file is compacted when it
grows past ~2000 lines (§9.1.3) so procedural memory stays signal, not noise.
"""

from __future__ import annotations

from dataclasses import dataclass, field

COMPACT_LINES = 2000


@dataclass
class ProceduralNotes:
    """In-memory model of the workspace note files (persisted to volume in prod)."""

    # project -> list of note lines
    _notes: dict[str, list[str]] = field(default_factory=dict)

    def append(self, project: str, note: str) -> None:
        """Record a learned procedure. Deduped against the exact same line."""
        lines = self._notes.setdefault(project, [])
        note = note.strip()
        if note and note not in lines:
            lines.append(note)

    def get(self, project: str) -> list[str]:
        return list(self._notes.get(project, []))

    def render(self, project: str, max_lines: int = 20) -> str:
        """The `<procedural_notes>` block injected for the active project (§9.1)."""
        lines = self._notes.get(project, [])
        if not lines:
            return ""
        shown = lines[-max_lines:]
        return "<procedural_notes>\n" + "\n".join(f"- {l}" for l in shown) + "\n</procedural_notes>"

    def drop(self, project: str) -> int:
        """Remove all notes for a project (used by user-erasure §15.7). Returns count."""
        n = len(self._notes.get(project, []))
        self._notes.pop(project, None)
        return n

    def needs_compaction(self, project: str) -> bool:
        return len(self._notes.get(project, [])) > COMPACT_LINES

    def compact(self, project: str, keep: int = COMPACT_LINES // 2) -> int:
        """Keep the most recent `keep` notes (a summariser runs in prod, §15.7).
        Returns how many lines were dropped."""
        lines = self._notes.get(project, [])
        if len(lines) <= keep:
            return 0
        dropped = len(lines) - keep
        self._notes[project] = lines[-keep:]
        return dropped
