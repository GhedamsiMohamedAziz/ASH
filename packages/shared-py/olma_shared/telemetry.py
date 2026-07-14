"""W3C traceparent propagation (instructions.md §8.1, §19).

Prod plugs the OpenTelemetry SDK (traces → Tempo); this module handles the wire
format — generate a root trace, parse an incoming header, derive a child span —
so every service can propagate `traceparent` today without the full SDK.

Format: 00-<32 hex trace_id>-<16 hex span_id>-<2 hex flags>
"""

from __future__ import annotations

import os
import re
from dataclasses import dataclass

_TP_RE = re.compile(r"^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$")


@dataclass(frozen=True)
class SpanContext:
    trace_id: str  # 32 hex
    span_id: str   # 16 hex
    sampled: bool = True

    def to_traceparent(self) -> str:
        flags = "01" if self.sampled else "00"
        return f"00-{self.trace_id}-{self.span_id}-{flags}"


def _rand_hex(n_bytes: int) -> str:
    return os.urandom(n_bytes).hex()


def new_trace(sampled: bool = True) -> SpanContext:
    """Start a fresh root trace."""
    return SpanContext(_rand_hex(16), _rand_hex(8), sampled)


def parse(traceparent: str) -> SpanContext | None:
    """Parse an incoming header; return None if malformed (caller starts a new trace)."""
    m = _TP_RE.match((traceparent or "").strip())
    if not m:
        return None
    _, trace_id, span_id, flags = m.groups()
    if trace_id == "0" * 32 or span_id == "0" * 16:
        return None  # invalid per spec
    return SpanContext(trace_id, span_id, bool(int(flags, 16) & 0x01))


def child(traceparent: str | None) -> SpanContext:
    """Continue an incoming trace with a new span, or start a new root if absent/invalid."""
    parent = parse(traceparent) if traceparent else None
    if parent is None:
        return new_trace()
    return SpanContext(parent.trace_id, _rand_hex(8), parent.sampled)
