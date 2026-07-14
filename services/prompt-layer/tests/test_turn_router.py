"""AX-027 routing + AX-028 escalation tests (§7.2.1)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.turn_router import maybe_escalate, route  # noqa: E402


# ---------------------------------------------------------------- routing (AX-027)
def test_simple_question_no_sandbox():
    r = route("what is our branch naming convention?")
    assert r.path == "chat_simple" and r.wake_sandbox is False


def test_agentic_task_wakes_sandbox():
    r = route("déploie fix/login sur staging et merge la PR")
    assert r.path == "task_agentique" and r.wake_sandbox is True


def test_attachment_forces_agentic():
    r = route("résume ça", has_attachments=True)
    assert r.wake_sandbox is True


def test_ambiguous_starts_light():
    r = route("bonjour")
    assert r.wake_sandbox is False  # never wake a sandbox "just in case"


# ---------------------------------------------------------------- escalation (AX-028)
def test_simple_turn_escalates_on_tool_need():
    e = maybe_escalate("chat_simple", "il faut que je regarde dans le repo pour confirmer")
    assert e.escalated is True
    assert e.event["type"] == "agent.escalated"
    assert e.event["data"] == {"from": "chat_simple", "to": "task_agentique"}


def test_simple_turn_without_tool_need_stays_simple():
    e = maybe_escalate("chat_simple", "notre convention est kebab-case pour les branches")
    assert e.escalated is False


def test_escalation_is_one_way():
    # an already-agentique turn never "escalates" again
    e = maybe_escalate("task_agentique", "regarde dans le repo")
    assert e.escalated is False


def test_english_tool_need_detected():
    e = maybe_escalate("chat_simple", "let me check the PR to be sure")
    assert e.escalated is True
