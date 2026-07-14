"""AX-045 procedural notes + AX-052 profile selection tests (§9.1, §9.5)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.procedural import COMPACT_LINES, ProceduralNotes  # noqa: E402
from app.profiles import select_profile  # noqa: E402


# ---------------------------------------------------------------- procedural notes (AX-045)
def test_append_and_render():
    n = ProceduralNotes()
    n.append("checkout", "déploiement : CI → tag → ArgoCD, jamais de push direct")
    block = n.render("checkout")
    assert "<procedural_notes>" in block and "ArgoCD" in block


def test_notes_are_deduped():
    n = ProceduralNotes()
    n.append("checkout", "run tests before merge")
    n.append("checkout", "run tests before merge")
    assert len(n.get("checkout")) == 1


def test_render_empty_project_is_blank():
    assert ProceduralNotes().render("nope") == ""


def test_notes_are_per_project():
    n = ProceduralNotes()
    n.append("web", "use pnpm")
    n.append("api", "use uv")
    assert "pnpm" in n.render("web") and "pnpm" not in n.render("api")


def test_compaction_over_threshold():
    n = ProceduralNotes()
    for i in range(COMPACT_LINES + 100):
        n.append("big", f"note {i}")
    assert n.needs_compaction("big")
    dropped = n.compact("big")
    assert dropped == 100 + COMPACT_LINES // 2
    assert not n.needs_compaction("big")
    # most recent kept
    assert f"note {COMPACT_LINES + 99}" in n.get("big")


# ---------------------------------------------------------------- profile selection (AX-052)
def test_job_pin_wins():
    assert select_profile("anything", cls="task_agentique", job_profile="ops") == "ops"


def test_user_pref_beats_inference():
    assert select_profile("fix the bug in the repo", cls="task_agentique",
                          user_pref="data-analyst") == "data-analyst"


def test_chat_simple_is_generalist():
    assert select_profile("what time is standup?", cls="chat_simple") == "generalist"


def test_dev_signals():
    assert select_profile("open a PR and merge the branch after CI", cls="task_agentique") == "dev"


def test_data_signals():
    assert select_profile("run a SQL query on churn and build a chart",
                          cls="task_agentique") == "data-analyst"


def test_ops_signals():
    assert select_profile("triage the Sentry incident and check the prod logs",
                          cls="task_agentique") == "ops"


def test_default_generalist_when_no_signal():
    assert select_profile("aide-moi à rédiger un message", cls="task_agentique") == "generalist"


def test_invalid_pin_falls_through():
    # a bogus job profile is ignored, inference used
    assert select_profile("fix the failing test in the repo", cls="task_agentique",
                          job_profile="bogus") == "dev"
