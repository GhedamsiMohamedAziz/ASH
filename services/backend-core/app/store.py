"""In-memory store + per-conversation event log and pub/sub.

Conversations/messages may be persisted to Postgres (see `pgstore.PgStore`,
selected by DATABASE_URL); the event log + WS fan-out stay in-memory in both
modes because AgentEvents are transient (§8.3 replay is served from NATS in
prod). Seq is owned here: `record_event` assigns the monotonic per-conversation
`seq`, so the bus/bridge path (§8.2) keeps gap-free ordering.
"""

from __future__ import annotations

import asyncio
import itertools
import time
from dataclasses import dataclass, field

from olma_shared.idempotency import InMemoryStore

from .models import AgentEvent, AgentEventType, Conversation, Message


@dataclass
class ConversationState:
    conversation: Conversation
    messages: list[Message] = field(default_factory=list)
    events: list[AgentEvent] = field(default_factory=list)  # replay log
    _seq: itertools.count = field(default_factory=lambda: itertools.count(1))
    subscribers: set[asyncio.Queue] = field(default_factory=set)
    cancelled: bool = False

    def next_seq(self) -> int:
        return next(self._seq)


class Store:
    """Process-local store. `db` (optional PgStore) persists conversations+messages."""

    def __init__(self, db=None) -> None:
        self._ids = itertools.count(1)
        self.conversations: dict[str, ConversationState] = {}
        self.idempotency = InMemoryStore()  # shared helper (§21, Principle #8)
        self.db = db  # optional PgStore; None → in-memory only

    # -- id helpers -------------------------------------------------
    def _id(self, prefix: str) -> str:
        return f"{prefix}_{next(self._ids):08d}"

    def new_conversation_id(self) -> str:
        return self._id("conv")

    def new_message_id(self) -> str:
        return self._id("msg")

    def new_task_id(self) -> str:
        return self._id("task")

    # -- conversations ----------------------------------------------
    def add_conversation(self, conv: Conversation) -> ConversationState:
        state = ConversationState(conversation=conv)
        self.conversations[conv.id] = state
        return state

    def get(self, conversation_id: str) -> ConversationState | None:
        return self.conversations.get(conversation_id)

    def list_conversations(self, user_id: str) -> list[Conversation]:
        return [
            s.conversation
            for s in self.conversations.values()
            if s.conversation.user_id == user_id
        ]

    def add_message(self, conversation_id: str, msg: Message) -> None:
        self.conversations[conversation_id].messages.append(msg)

    # -- events: assign seq, append to log, fan out to live subscribers ----
    def record_event(self, conversation_id: str, etype: AgentEventType, data: dict) -> AgentEvent:
        """Assign the next per-conversation seq and append; the WS loop fans it out.

        This is the single seq authority (§8.3). Called by the bridge that
        consumes `agent.events.*` off the bus, so ordering is owned here even
        though the runner produces events out-of-process.
        """
        state = self.conversations[conversation_id]
        event = AgentEvent(type=etype, seq=state.next_seq(), data=data, ts=int(time.time()))
        state.events.append(event)
        for q in list(state.subscribers):
            q.put_nowait(event)
        return event

    def subscribe(self, conversation_id: str) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self.conversations[conversation_id].subscribers.add(q)
        return q

    def unsubscribe(self, conversation_id: str, q: asyncio.Queue) -> None:
        state = self.conversations.get(conversation_id)
        if state:
            state.subscribers.discard(q)

    def replay_since(self, conversation_id: str, last_seq: int) -> list[AgentEvent]:
        state = self.conversations[conversation_id]
        return [e for e in state.events if e.seq > last_seq]
