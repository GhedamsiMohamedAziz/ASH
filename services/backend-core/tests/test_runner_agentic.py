"""The runner's real tool-use loop (§10, §12): for an AGENTIC-class turn it fetches the Gateway's
tool catalog (POST /mcp tools/list), calls llm-proxy with the tools, executes each returned
tool_use through the Gateway (POST /v1/tool/call with the dotted gwTool + task_jwt), feeds the
result back, and answers from the tool output. This drives the loop with a mocked httpx client and
asserts: the Gateway tool call is REAL (dotted name + args + jwt), the tool.call/tool.result events
are emitted, and the final reply is the model's end_turn text.
"""
from __future__ import annotations

import asyncio
from types import SimpleNamespace

import app.runner as runner


class _FakeResp:
    def __init__(self, data): self._data = data
    def raise_for_status(self): pass
    def json(self): return self._data


class _FakeAsyncClient:
    """Scripts /v1/plan, /mcp tools/list, /v1/complete (tool_use then end_turn), /v1/tool/call."""
    calls: list = []

    def __init__(self, *a, **k):
        self._complete_calls = 0

    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False

    async def post(self, url, json=None, headers=None):
        _FakeAsyncClient.calls.append((url, json, headers))
        if url.endswith("/v1/plan"):
            return _FakeResp({"class": "task_agentique", "task_jwt": "task.jwt.here",
                              "allowed_tools": ["scheduler.list_crons"], "approval_tools": [],
                              "agent_profile": "generalist", "task_id": "tk"})
        if url.endswith("/mcp"):
            return _FakeResp({"jsonrpc": "2.0", "id": 1, "result": {"tools": [
                {"name": "scheduler_list_crons", "description": "List crons",
                 "inputSchema": {"type": "object", "properties": {}}}]}})
        if url.endswith("/v1/complete"):
            self._complete_calls += 1
            if self._complete_calls == 1:
                return _FakeResp({"model": "claude-opus-4-8", "stop_reason": "tool_use",
                                  "text": "", "usage": {"tokens_in": 10, "tokens_out": 5},
                                  "cost_usd": 0.001, "content_blocks": [
                                      {"type": "tool_use", "id": "toolu_1",
                                       "name": "scheduler_list_crons", "input": {}}]})
            return _FakeResp({"model": "claude-opus-4-8", "stop_reason": "end_turn",
                              "text": "Tu as 1 automatisation : chaque jour à 8h.",
                              "usage": {"tokens_in": 20, "tokens_out": 12}, "cost_usd": 0.002,
                              "content_blocks": [{"type": "text",
                                                  "text": "Tu as 1 automatisation : chaque jour à 8h."}]})
        if url.endswith("/v1/tool/call"):
            return _FakeResp({"status": "ok",
                              "result": '[{"jobId":"job_1","status":"active"}]'})
        return _FakeResp({})


def _run(monkeypatch, capture):
    import httpx
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", None)
    monkeypatch.setattr(runner, "PROMPT_LAYER_URL", "http://pl.test")
    monkeypatch.setattr(runner, "LLM_PROXY_URL", "http://llm.test")
    monkeypatch.setattr(runner, "MCP_GATEWAY_URL", "http://gw.test")
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.calls = []

    async def fake_emit(conversation_id, etype, data):
        capture.append((etype, data))
    monkeypatch.setattr(runner, "_emit", fake_emit)

    reply, meta = asyncio.run(runner._integrated_turn(
        "conv_1", "liste mes automatisations planifiées", "org_1", "web", False, "usr_42"))
    return reply, meta


def test_agentic_loop_calls_tool_through_gateway(monkeypatch):
    events: list = []
    reply, meta = _run(monkeypatch, events)

    # The Gateway was called REALLY, with the dotted gwTool, the model's args, and the task_jwt.
    tool_calls = [c for c in _FakeAsyncClient.calls if c[0].endswith("/v1/tool/call")]
    assert len(tool_calls) == 1, "the runner did not call the Gateway tool"
    _url, body, _headers = tool_calls[0]
    assert body["tool"] == "scheduler.list_crons"   # underscore MCP name mapped to dotted gwTool
    assert body["taskJwt"] == "task.jwt.here"
    assert body["args"] == {}

    # tools/list was fetched with the task_jwt as Bearer.
    mcp_calls = [c for c in _FakeAsyncClient.calls if c[0].endswith("/mcp")]
    assert mcp_calls and mcp_calls[0][2]["Authorization"] == "Bearer task.jwt.here"

    # The UI events the panel renders were emitted in order.
    etypes = [e[0] for e in events]
    assert "agent.tool.call" in etypes and "agent.tool.result" in etypes
    call_ev = next(e for e in events if e[0] == "agent.tool.call")
    assert call_ev[1]["tool"] == "scheduler.list_crons"
    result_ev = next(e for e in events if e[0] == "agent.tool.result")
    assert result_ev[1]["status"] == "ok"

    # The final reply is the model's end_turn text, grounded on the tool result.
    assert "automatisation" in reply
    assert meta["class"] == "task_agentique"


def test_agentic_loop_gates_on_needs_approval(monkeypatch):
    events: list = []

    class _ApprovalClient(_FakeAsyncClient):
        async def post(self, url, json=None, headers=None):
            if url.endswith("/v1/tool/call"):
                _FakeAsyncClient.calls.append((url, json, headers))
                return _FakeResp({"status": "needs_approval", "reason": "tool requires approval"})
            return await super().post(url, json=json, headers=headers)

    import httpx
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", None)
    monkeypatch.setattr(runner, "PROMPT_LAYER_URL", "http://pl.test")
    monkeypatch.setattr(runner, "LLM_PROXY_URL", "http://llm.test")
    monkeypatch.setattr(runner, "MCP_GATEWAY_URL", "http://gw.test")
    monkeypatch.setattr(httpx, "AsyncClient", _ApprovalClient)
    _FakeAsyncClient.calls = []

    async def fake_emit(conversation_id, etype, data):
        events.append((etype, data))
    monkeypatch.setattr(runner, "_emit", fake_emit)

    reply, meta = asyncio.run(runner._integrated_turn(
        "conv_2", "crée une automatisation", "org_1", "web", False, "usr_42"))

    etypes = [e[0] for e in events]
    assert "agent.approval.needed" in etypes, "a gated tool must emit agent.approval.needed"
    appr = next(e for e in events if e[0] == "agent.approval.needed")
    assert appr[1]["tool"] == "scheduler.list_crons"
    assert appr[1]["args"] == {}
    # The loop STOPPED — no second /v1/complete iteration after the gate.
    complete_calls = [c for c in _FakeAsyncClient.calls if c[0].endswith("/v1/complete")]
    assert len(complete_calls) == 1
