"""Real Anthropic backend tests — drive AnthropicBackend with a fake SDK client (no network,
no key). Proves the message split (system hoisted, tool->user), that usage is read from the
real block, and that any provider failure becomes a BackendError so the proxy's §9.5 fallback
fires exactly as it does for the stub's FailingBackend.
"""
from __future__ import annotations

import pytest

from app.backends import AnthropicBackend, BackendError, StubBackend
from app.config import Config, Price, TierRoute
from app.models import ChatMessage, CompleteRequest
from app.proxy import Proxy


class _Block:
    def __init__(self, text: str) -> None:
        self.type = "text"
        self.text = text


class _Usage:
    def __init__(self, i: int, o: int) -> None:
        self.input_tokens = i
        self.output_tokens = o


class _Resp:
    def __init__(self, text: str, i: int, o: int) -> None:
        self.content = [_Block(text)]
        self.usage = _Usage(i, o)


class _Messages:
    def __init__(self, resp=None, err=None) -> None:
        self._resp, self._err = resp, err
        self.last_kwargs = None

    def create(self, **kwargs):
        self.last_kwargs = kwargs
        if self._err:
            raise self._err
        return self._resp


class _FakeClient:
    """Stands in for anthropic.Anthropic(): with_options() returns self, .messages fixed."""

    def __init__(self, resp=None, err=None) -> None:
        self.messages = _Messages(resp, err)

    def with_options(self, **_):
        return self


def test_split_hoists_system_and_folds_tool_to_user():
    system, turns = AnthropicBackend._split([
        ChatMessage(role="system", content="you are Axone"),
        ChatMessage(role="user", content="deploy fix/login"),
        ChatMessage(role="tool", content="pr #42 opened"),
    ])
    assert system == "you are Axone"
    assert turns == [
        {"role": "user", "content": "deploy fix/login"},
        {"role": "user", "content": "pr #42 opened"},  # tool -> user
    ]


def test_empty_turns_still_produces_a_user_message():
    _, turns = AnthropicBackend._split([ChatMessage(role="system", content="ctx")])
    assert turns == [{"role": "user", "content": "ctx"}]


def test_complete_reads_real_usage():
    client = _FakeClient(resp=_Resp("PR #42 ouverte", i=1200, o=37))
    b = AnthropicBackend(client=client)
    r = b.complete(model="claude-opus-4-8",
                   messages=[ChatMessage(role="user", content="go")], max_tokens=512)
    assert r.text == "PR #42 ouverte"
    assert (r.tokens_in, r.tokens_out) == (1200, 37)
    assert client.messages.last_kwargs["model"] == "claude-opus-4-8"


def test_provider_failure_becomes_backend_error():
    client = _FakeClient(err=RuntimeError("401 authentication_error"))
    b = AnthropicBackend(client=client)
    with pytest.raises(BackendError):
        b.complete(model="claude-opus-4-8",
                   messages=[ChatMessage(role="user", content="go")], max_tokens=512)


def _cfg() -> Config:
    return Config(
        provider="anthropic",
        tiers={"frontier": TierRoute(model="claude-opus-4-8", fallback="claude-sonnet-4-6")},
        org_overrides={},
        prices={
            "claude-opus-4-8": Price(input=5.0, output=25.0),
            "claude-sonnet-4-6": Price(input=3.0, output=15.0),
        },
    )


def test_anthropic_failure_triggers_tier_fallback_end_to_end():
    """A dead primary Anthropic model falls over to the tier fallback (§9.5) — the real
    backend participates in fallback identically to the stub's FailingBackend."""
    failing = AnthropicBackend(client=_FakeClient(err=RuntimeError("529 overloaded")))
    healthy_fallback = StubBackend()
    proxy = Proxy(_cfg(), default_backend=healthy_fallback,
                  backends={"claude-opus-4-8": failing})
    resp = proxy.complete(CompleteRequest(
        tier="frontier", messages=[ChatMessage(role="user", content="go")], max_tokens=64))
    assert resp.fell_back is True
    assert resp.model == "claude-sonnet-4-6"
