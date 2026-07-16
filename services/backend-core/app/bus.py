"""The process-global event bus (instructions.md §8.2).

Backend Core never talks to the LLM or sandboxes directly — it publishes on the
bus and consumes what comes back. Prod is NATS JetStream; this uses the shared
in-process `InMemoryBus` so the whole flow is runnable with zero external infra.
"""

from __future__ import annotations

from olma_shared.bus import InMemoryBus

# ONE bus for the whole process (dev). Prod swaps this for NATS JetStream.
bus = InMemoryBus()

# Subjects (§8.2). Inbound user messages fan out to the agent-runner; the runner
# streams AgentEvents back per-conversation; cancels ride a control subject.
SUBJECT_INBOUND = "inbound.messages"
SUBJECT_CANCEL = "control.cancel"


def agent_events_subject(conversation_id: str) -> str:
    return f"agent.events.{conversation_id}"


# In-process cancellation registry. Prod publishes to SUBJECT_CANCEL and the
# runner subscribes; in-process we share a set so `POST /cancel` can signal the
# runner mid-turn without coupling it to the store (§7.2.1 "Arrêter").
_cancelled: set[str] = set()


def mark_cancelled(conversation_id: str) -> None:
    _cancelled.add(conversation_id)


def is_cancelled(conversation_id: str) -> bool:
    return conversation_id in _cancelled


def clear_cancel(conversation_id: str) -> None:
    _cancelled.discard(conversation_id)


# In-process human-approval signal for OpenCode-native permission requests (§13.3). When OpenCode
# pauses a gated tool call it emits a permission event; the runner surfaces an approval card and
# awaits the user's decision here, which `POST /approve` sets (keyed by OpenCode's per_… id). Mirrors
# the cancel registry — no store coupling. Prod: a Redis key with a TTL keyed by the permission id.
_perm_decisions: dict[str, str] = {}


def set_permission_decision(permission_id: str, decision: str) -> None:
    """decision is 'approve' or 'deny' (the /approve route's ApprovalDecision.decision)."""
    _perm_decisions[permission_id] = decision


def get_permission_decision(permission_id: str) -> str | None:
    return _perm_decisions.get(permission_id)


def clear_permission_decision(permission_id: str) -> None:
    _perm_decisions.pop(permission_id, None)
