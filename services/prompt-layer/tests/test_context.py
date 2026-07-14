"""AX-051 prompt-cache context tests (§9.6) — the non-regression test the spec requires."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.context import (  # noqa: E402
    VolatilePrefixError,
    build_context,
    cache_hit_ratio,
    prefix_key,
)


def _ctx(tools, current="do the thing", history=None):
    return build_context(
        system_prompt="You are Axone.", agent_profile="dev", allowed_tools=tools,
        org_rules="Org: acme. Approve merges.", user_memory="prefers dark mode",
        history=history or ["turn 1 text"], current_message=current)


def test_block_order_and_prefix():
    blocks = _ctx(["github.search", "github.create_pr"])
    assert [b.name for b in blocks] == [
        "system", "profile", "tools", "org_rules", "user_memory", "history", "current"]
    assert [b.name for b in blocks if b.cacheable] == ["system", "profile", "tools", "org_rules"]


def test_tool_order_is_deterministic():
    # same tools, different input order → identical tools block → identical prefix
    a = prefix_key(_ctx(["b.tool", "a.tool", "c.tool"]))
    b = prefix_key(_ctx(["c.tool", "a.tool", "b.tool"]))
    assert a == b


def test_same_turn_shape_hits_cache():
    # two turns, same user/profile/tools/org but different current message → same prefix
    k1 = prefix_key(_ctx(["github.search"], current="question one"))
    k2 = prefix_key(_ctx(["github.search"], current="question two", history=["a", "b"]))
    assert k1 == k2  # prefix unaffected by block 6/7 changes


def test_volatile_token_in_prefix_is_rejected():
    with pytest.raises(VolatilePrefixError):
        build_context(system_prompt="You are Axone. 2026-07-13T09:00 build",
                      agent_profile="dev", allowed_tools=[], org_rules="", user_memory="",
                      history=[], current_message="x")


def test_date_in_current_message_is_allowed():
    # the volatile date lives in block 7 (current) — must NOT raise
    _ctx(["github.search"], current="today is 2026-07-13T09:00, deploy now")


def test_cache_hit_ratio():
    keys = ["A", "A", "A", "B"]  # 3 of 4 are repeats after first-seen
    assert cache_hit_ratio(keys) == 2 / 4  # A(miss),A(hit),A(hit),B(miss) → 2 hits
    assert cache_hit_ratio([]) == 0.0
