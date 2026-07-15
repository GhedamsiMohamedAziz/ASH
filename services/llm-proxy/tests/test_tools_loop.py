"""Tool-use contract for /v1/complete (§12): the proxy accepts an Anthropic `tools` array and
returns the assistant's structured content blocks (stop_reason + tool_use/text), while the
tools-absent path stays a plain text completion. Covers the StubBackend scripted tool_use (the
offline/keyless loop) and the AnthropicBackend block serialization (with a fake SDK client).
"""
from __future__ import annotations

import os

from fastapi.testclient import TestClient

from app.backends import AnthropicBackend, StubBackend
from app.main import app
from app.models import ChatMessage, CompleteRequest
from app.proxy import Proxy
from app.config import load_config


_TOOLS = [{"name": "scheduler_list_crons", "description": "list", "input_schema": {"type": "object"}}]


# --------------------------------------------------------------- StubBackend scripted tool_use
def test_stub_emits_tool_use_when_configured(monkeypatch):
    monkeypatch.setenv("LLM_PROXY_STUB_TOOL", "scheduler_list_crons")
    r = StubBackend().complete(
        model="m", messages=[ChatMessage(role="user", content="list my crons")],
        max_tokens=256, tools=_TOOLS,
    )
    assert r.stop_reason == "tool_use"
    tool_uses = [b for b in r.blocks if b["type"] == "tool_use"]
    assert len(tool_uses) == 1
    assert tool_uses[0]["name"] == "scheduler_list_crons"


def test_stub_ends_turn_after_tool_result(monkeypatch):
    """Once a tool_result is fed back, the stub stops calling tools — the loop terminates."""
    monkeypatch.setenv("LLM_PROXY_STUB_TOOL", "scheduler_list_crons")
    msgs = [
        ChatMessage(role="user", content="list my crons"),
        ChatMessage(role="assistant", content=[{"type": "tool_use", "id": "t1",
                                                "name": "scheduler_list_crons", "input": {}}]),
        ChatMessage(role="user", content=[{"type": "tool_result", "tool_use_id": "t1",
                                           "content": "[]"}]),
    ]
    r = StubBackend().complete(model="m", messages=msgs, max_tokens=256, tools=_TOOLS)
    assert r.stop_reason == "end_turn"
    assert all(b["type"] != "tool_use" for b in r.blocks)


def test_stub_no_tools_is_plain_text():
    r = StubBackend().complete(model="m", messages=[ChatMessage(role="user", content="hi")],
                               max_tokens=256)
    assert r.stop_reason == "end_turn"
    assert r.text.startswith("[stub:m]")


# --------------------------------------------------------------- AnthropicBackend block serialization
class _TextBlock:
    type = "text"
    def __init__(self, text): self.text = text


class _ToolUseBlock:
    type = "tool_use"
    def __init__(self, id, name, inp): self.id, self.name, self.input = id, name, inp


class _Usage:
    def __init__(self, i, o): self.input_tokens, self.output_tokens = i, o


class _Resp:
    def __init__(self, content, stop): self.content, self.stop_reason, self.usage = content, stop, _Usage(10, 5)


class _Messages:
    def __init__(self, resp): self._resp, self.last_kwargs = resp, None
    def create(self, **kwargs):
        self.last_kwargs = kwargs
        return self._resp


class _FakeClient:
    def __init__(self, resp): self.messages = _Messages(resp)
    def with_options(self, **_): return self


def test_anthropic_returns_tool_use_blocks_and_passes_tools():
    resp = _Resp([_ToolUseBlock("toolu_1", "scheduler_list_crons", {})], stop="tool_use")
    client = _FakeClient(resp)
    b = AnthropicBackend(client=client)
    r = b.complete(model="claude-opus-4-8",
                   messages=[ChatMessage(role="user", content="list crons")],
                   max_tokens=512, tools=_TOOLS)
    assert r.stop_reason == "tool_use"
    assert r.blocks == [{"type": "tool_use", "id": "toolu_1",
                         "name": "scheduler_list_crons", "input": {}}]
    assert client.messages.last_kwargs["tools"] == _TOOLS


def test_anthropic_end_turn_text():
    resp = _Resp([_TextBlock("voici tes crons")], stop="end_turn")
    b = AnthropicBackend(client=_FakeClient(resp))
    r = b.complete(model="claude-opus-4-8",
                   messages=[ChatMessage(role="user", content="go")], max_tokens=512)
    assert r.stop_reason == "end_turn"
    assert r.text == "voici tes crons"


# --------------------------------------------------------------- HTTP surface end-to-end (stub)
def test_http_complete_returns_content_blocks(monkeypatch):
    monkeypatch.setenv("LLM_PROXY_STUB_TOOL", "scheduler_list_crons")
    c = TestClient(app)
    r = c.post("/v1/complete", json={
        "tier": "eco",
        "messages": [{"role": "user", "content": "liste mes crons"}],
        "tools": _TOOLS,
    })
    assert r.status_code == 200
    body = r.json()
    assert body["stop_reason"] == "tool_use"
    assert any(b["type"] == "tool_use" for b in body["content_blocks"])


def test_http_complete_backward_compat_no_tools():
    c = TestClient(app)
    r = c.post("/v1/complete", json={"tier": "eco",
                                     "messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code == 200
    body = r.json()
    assert body["text"].startswith("[stub:")
    assert body["stop_reason"] == "end_turn"
