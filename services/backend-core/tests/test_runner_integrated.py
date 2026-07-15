"""The runner threads the bus message's real origin fields into the /v1/plan call (FIX 2).

Defect: _on_inbound rebuilt a fresh inbound with channel="web"/user_id="usr_dev", discarding a
webhook message's channel="webhook"/untrusted=True — so build_task lost its pre-taint +
origin=scheduled and an injected webhook turn would run untainted + interactive. This test drives
_on_inbound with a webhook-shaped bus message and asserts the /v1/plan request carries
channel=webhook + untrusted=True (and the real user/org), captured via a mocked httpx client.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import pytest

import app.runner as runner


class _FakeResp:
    def __init__(self, data): self._data = data
    def raise_for_status(self): pass
    def json(self): return self._data


class _FakeAsyncClient:
    """Records every POST; answers /v1/plan and /v1/complete with minimal canned bodies."""
    calls: list = []

    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False

    async def post(self, url, json=None):
        _FakeAsyncClient.calls.append((url, json))
        if url.endswith("/v1/plan"):
            return _FakeResp({"class": "chat_simple", "task_jwt": "t",
                              "allowed_tools": [], "approval_tools": [], "task_id": "tk"})
        if url.endswith("/v1/complete"):
            return _FakeResp({"text": "ok", "model": "m",
                              "usage": {"tokens_in": 1, "tokens_out": 1}, "cost_usd": 0.0})
        return _FakeResp({})


def test_webhook_origin_threaded_into_plan(monkeypatch):
    import httpx
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", None)
    monkeypatch.setattr(runner, "PROMPT_LAYER_URL", "http://pl.test")
    monkeypatch.setattr(runner, "LLM_PROXY_URL", "http://llm.test")
    monkeypatch.setattr(runner, "MCP_GATEWAY_URL", None)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.calls = []

    # A webhook-injected bus message (webhooks.py fan_out shape): untrusted, webhook channel.
    msg = SimpleNamespace(data={
        "conversation_id": "event:auto1", "task_id": "task_evt_auto1_d1",
        "text": "injected PR title", "org_id": "org_9",
        "channel": "webhook", "untrusted": True, "user_id": "usr_hook",
    })
    asyncio.run(runner._on_inbound(msg))

    plan_calls = [c for c in _FakeAsyncClient.calls if c[0].endswith("/v1/plan")]
    assert plan_calls, "no /v1/plan call was captured"
    inbound = plan_calls[0][1]["inbound"]
    assert inbound["channel"] == "webhook", "webhook channel was dropped (would run interactive)"
    assert inbound["untrusted"] is True, "untrusted taint was dropped (would run untainted)"
    assert inbound["user_id"] == "usr_hook", "real user_id was replaced by usr_dev"
    assert inbound["org_id"] == "org_9"


def test_web_message_defaults_preserved(monkeypatch):
    # A normal web message (no channel/untrusted/user_id fabricated) keeps the interactive default.
    import httpx
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", None)
    monkeypatch.setattr(runner, "PROMPT_LAYER_URL", "http://pl.test")
    monkeypatch.setattr(runner, "LLM_PROXY_URL", "http://llm.test")
    monkeypatch.setattr(runner, "MCP_GATEWAY_URL", None)
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.calls = []

    msg = SimpleNamespace(data={
        "conversation_id": "conv_1", "task_id": "task_1", "text": "bonjour",
        "org_id": "org_1", "channel": "web", "user_id": "usr_42",
    })
    asyncio.run(runner._on_inbound(msg))

    inbound = next(c for c in _FakeAsyncClient.calls if c[0].endswith("/v1/plan"))[1]["inbound"]
    assert inbound["channel"] == "web"
    assert inbound["untrusted"] is False
    assert inbound["user_id"] == "usr_42"
