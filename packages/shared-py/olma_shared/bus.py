"""Event bus abstraction (instructions.md §8.2, Principle #6/#8).

Prod is NATS JetStream (replay, at-least-once); this defines the interface plus
an in-process implementation for dev/tests. Delivery is at-least-once, so a
DedupeGuard lets consumers drop repeats by message_id / idempotency_key (§21).
Subjects support a single trailing '*' wildcard (e.g. 'agent.events.*').
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Protocol


@dataclass
class Message:
    subject: str
    data: dict[str, Any]
    message_id: str = ""  # dedup key (message_id or idempotency_key)


Handler = Callable[[Message], Awaitable[None]]


class Bus(Protocol):
    async def publish(self, subject: str, data: dict, message_id: str = "") -> None: ...
    def subscribe(self, pattern: str, handler: Handler) -> Callable[[], None]: ...


def _matches(pattern: str, subject: str) -> bool:
    if pattern == subject:
        return True
    if pattern.endswith(".*"):
        return subject.startswith(pattern[:-1])  # 'a.b.*' matches 'a.b.<x>'
    return False


@dataclass
class InMemoryBus:
    """In-process fan-out bus. One instance = one 'cluster' (dev only)."""

    _subs: list[tuple[str, Handler]] = field(default_factory=list)

    async def publish(self, subject: str, data: dict, message_id: str = "") -> None:
        msg = Message(subject=subject, data=data, message_id=message_id)
        handlers = [h for pat, h in self._subs if _matches(pat, subject)]
        # at-least-once: deliver to every matching subscriber
        await asyncio.gather(*(h(msg) for h in handlers)) if handlers else None

    def subscribe(self, pattern: str, handler: Handler) -> Callable[[], None]:
        entry = (pattern, handler)
        self._subs.append(entry)

        def unsubscribe() -> None:
            if entry in self._subs:
                self._subs.remove(entry)

        return unsubscribe


class DedupeGuard:
    """Consumer-side at-least-once dedup by message_id (§21)."""

    def __init__(self, capacity: int = 10000) -> None:
        self._seen: dict[str, None] = {}
        self._capacity = capacity

    def is_duplicate(self, message_id: str) -> bool:
        if not message_id:
            return False
        if message_id in self._seen:
            return True
        self._seen[message_id] = None
        if len(self._seen) > self._capacity:
            # drop oldest (dict preserves insertion order)
            oldest = next(iter(self._seen))
            del self._seen[oldest]
        return False
