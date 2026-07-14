"""Persistent workspace volume model (instructions.md §11.3, Principle #4).

The sandbox is disposable but /workspace persists on a volume: repos, project notes
and files survive a kill/restart. This models the volume lifecycle + the .agent/
notes area, verifiable without a real volume."""
from __future__ import annotations
from dataclasses import dataclass, field

@dataclass
class Workspace:
    user_id: str
    volume_id: str
    files: dict = field(default_factory=dict)   # path -> content (volume-backed in prod)

    def write(self, path: str, content: str) -> None:
        self.files[path] = content

    def read(self, path: str) -> str | None:
        return self.files.get(path)

    def survives_restart(self) -> "Workspace":
        """A sandbox restart re-attaches the SAME volume — files persist (§11.3)."""
        return Workspace(self.user_id, self.volume_id, files=dict(self.files))

class VolumeRegistry:
    """Maps user -> volume; a killed sandbox re-attaches its user's volume."""
    def __init__(self): self._vols: dict[str, Workspace] = {}
    def attach(self, user_id: str) -> Workspace:
        if user_id not in self._vols:
            self._vols[user_id] = Workspace(user_id, f"vol_{user_id}")
        return self._vols[user_id]
