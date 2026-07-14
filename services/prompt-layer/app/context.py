"""LLM context assembly for prompt caching (instructions.md §9.6).

Caching is the #1 cost lever, but only works if the context PREFIX is
byte-for-byte stable across calls. The builder enforces the strict block order
(most stable → most volatile) and the anti-volatility rules a non-regression test
checks: no timestamps/turn-ids/counters in blocks 1-4, deterministic (alphabetical)
tool ordering, and cache breakpoints after the stable prefix (blocks 1-4).
"""

from __future__ import annotations

import re
from dataclasses import dataclass

# Volatile tokens that must never appear in the cacheable prefix (blocks 1-4).
_VOLATILE = re.compile(
    r"(\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}|turn[_-]?\d+|msg_[0-9a-f]{6,}|"
    r"task_\d+|\bnonce\b|\btimestamp\b)", re.I)


class VolatilePrefixError(Exception):
    """A cacheable prefix block contains a volatile token — would break caching."""


@dataclass
class Block:
    name: str
    text: str
    cacheable: bool  # part of the stable prefix (gets a cache breakpoint)


def build_context(
    *,
    system_prompt: str,
    agent_profile: str,
    allowed_tools: list[str],
    org_rules: str,
    user_memory: str,
    history: list[str],
    current_message: str,
) -> list[Block]:
    """Assemble the §9.6 block order. Blocks 1-4 are the cacheable prefix."""
    # Block 3: tool defs sorted alphabetically so the same user's turns produce
    # an identical block regardless of allowed_tools ordering (§9.6).
    tools_block = "\n".join(f"- {t}" for t in sorted(set(allowed_tools)))

    blocks = [
        Block("system", system_prompt, True),                 # 1 global, versioned
        Block("profile", f"profile: {agent_profile}", True),  # 2 stable per profile
        Block("tools", tools_block, True),                    # 3 deterministic order
        Block("org_rules", org_rules, True),                  # 4 stable per org
        Block("user_memory", user_memory, False),             # 5 slow-varying
        Block("history", "\n".join(history), False),          # 6 append-only
        Block("current", current_message, False),             # 7 volatile (date lives here)
    ]

    # Enforce: no volatile token in the cacheable prefix (blocks 1-4). Today's date,
    # ids, counters must live in block 7 only.
    for b in blocks:
        if b.cacheable and _VOLATILE.search(b.text):
            raise VolatilePrefixError(f"volatile token in cacheable block '{b.name}'")
    return blocks


def prefix_key(blocks: list[Block]) -> str:
    """The byte-stable cache prefix (blocks 1-4 joined). Two turns of the same user
    with the same tools/profile/org yield an identical key → a cache hit (§9.6)."""
    return "\x00".join(b.text for b in blocks if b.cacheable)


def cache_hit_ratio(prefix_keys: list[str]) -> float:
    """Metric llm_cache_hit_ratio (§19): fraction of calls whose prefix was seen
    before. Target ≥ 0.75 global; < 0.60 triggers an investigation (§9.6)."""
    if not prefix_keys:
        return 0.0
    seen: set[str] = set()
    hits = 0
    for k in prefix_keys:
        if k in seen:
            hits += 1
        else:
            seen.add(k)
    return hits / len(prefix_keys)
