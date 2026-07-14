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
