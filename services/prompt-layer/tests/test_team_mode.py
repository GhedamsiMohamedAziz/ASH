"""AX-102 Mode B (team agent) tests (§3)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "packages" / "shared-py"))

from app.pipeline import TASK_JWT_SECRET, build_task  # noqa: E402
from app.team_mode import (  # noqa: E402
    PERSONAL_CONNECTORS,
    filter_team_tools,
    is_personal_connector,
    team_inbound,
)
from olma_shared import jwt  # noqa: E402


def _inbound(text="ouvre une PR", **kw):
    base = {"message_id": "m1", "user_id": "usr_1", "org_id": "org_1",
            "conversation_id": "conv_1", "channel": "slack", "text": text}
    base.update(kw)
    return base


# ------------------------------------------------------------------ config
def test_personal_connectors_flagged():
    assert is_personal_connector("outlook.read")
    assert not is_personal_connector("github.search")


def test_filter_strips_personal_connectors():
    tools = ["github.search", "outlook.read", "slack.dm_send"]
    assert filter_team_tools(tools) == ["github.search"]


def test_team_inbound_sets_on_behalf_of():
    inb = team_inbound(_inbound(), "usr_mehdi")
    assert inb["on_behalf_of"] == "usr_mehdi"


# ------------------------------------------------------------------ the governance property (§3.2)
def test_bot_acts_but_policy_and_audit_follow_the_requester():
    """The org agent runs the task, but authz + identity track the requester."""
    inb = team_inbound(_inbound("merge la PR #42"), "usr_mehdi")
    task = build_task(inb, role="member")
    claims = jwt.verify(task.task_jwt, TASK_JWT_SECRET)

    # sub is the shared bot; on_behalf_of names the human (Git history + audit, §3.2)
    assert claims["sub"] == "agent-org@org_1"
    assert claims["on_behalf_of"] == "usr_mehdi"
    assert task.on_behalf_of == "usr_mehdi"

    # policy is evaluated on the REQUESTER's role (member): create_pr allowed,
    # merge_pr gated — Mehdi cannot merge with org rights just by asking the bot.
    assert "github.create_pr" in task.allowed_tools
    assert "github.merge_pr" in task.approval_tools


def test_mode_b_excludes_personal_connectors_from_the_task():
    # A member normally could read the DB; personal connectors are never in scope
    # in Mode B regardless of policy.
    inb = team_inbound(_inbound(), "usr_mehdi")
    task = build_task(inb, role="member")
    assert not any(is_personal_connector(t) for t in task.allowed_tools)
    # every personal connector is absent from the granted set
    assert set(task.allowed_tools).isdisjoint(PERSONAL_CONNECTORS)


def test_mode_a_still_uses_the_requester_as_sub():
    """Without on_behalf_of (Mode A), sub is the user directly — no regression."""
    task = build_task(_inbound(), role="member")
    claims = jwt.verify(task.task_jwt, TASK_JWT_SECRET)
    assert claims["sub"] == "usr_1"
    assert "on_behalf_of" not in claims
