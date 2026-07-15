"""OpenAI-compatible stub surface tests (app/openai_compat.py).

Proves the keyless `POST /v1/chat/completions` OpenCode drives its LLM through:
  • non-stream + stream both return a valid, deterministic text completion (no API key);
  • with LLM_PROXY_STUB_TOOL set, the FIRST hop emits exactly one tool_call for the offered
    tool (suffix-matched to tolerate MCP name prefixing), and once a tool result is in the
    transcript the turn finishes with text — so an agentic turn terminates.
"""

import json
import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.main import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clear_tool_env():
    """Keep each test's tool-injection env isolated (the endpoint reads it per request)."""
    for k in ("LLM_PROXY_STUB_TOOL", "LLM_PROXY_STUB_TOOL_ARGS"):
        os.environ.pop(k, None)
    yield
    for k in ("LLM_PROXY_STUB_TOOL", "LLM_PROXY_STUB_TOOL_ARGS"):
        os.environ.pop(k, None)


def _body(messages, **kw):
    return {"model": "stub-model", "messages": messages, **kw}


def test_non_stream_text_completion():
    r = client.post("/v1/chat/completions",
                    json=_body([{"role": "user", "content": "hello there"}]))
    assert r.status_code == 200
    d = r.json()
    assert d["object"] == "chat.completion"
    choice = d["choices"][0]
    assert choice["finish_reason"] == "stop"
    assert "hello there" in choice["message"]["content"]
    assert d["usage"]["total_tokens"] > 0


def test_stream_text_completion():
    r = client.post("/v1/chat/completions",
                    json=_body([{"role": "user", "content": "stream me"}], stream=True))
    assert r.status_code == 200
    frames = [ln[6:] for ln in r.text.splitlines() if ln.startswith("data: ")]
    assert frames[-1] == "[DONE]"
    chunks = [json.loads(f) for f in frames if f != "[DONE]"]
    assert chunks[0]["choices"][0]["delta"].get("role") == "assistant"
    text = "".join(c["choices"][0]["delta"].get("content", "") for c in chunks)
    assert "stream me" in text
    assert chunks[-1]["choices"][0]["finish_reason"] == "stop"


def test_content_as_parts_array():
    """OpenCode may send content as an array of typed parts; the stub echoes their text."""
    r = client.post("/v1/chat/completions", json=_body(
        [{"role": "user", "content": [{"type": "text", "text": "array form"}]}]))
    assert r.status_code == 200
    assert "array form" in r.json()["choices"][0]["message"]["content"]


def test_tool_call_emitted_then_text_on_result():
    os.environ["LLM_PROXY_STUB_TOOL"] = "search"
    os.environ["LLM_PROXY_STUB_TOOL_ARGS"] = json.dumps({"query": "login"})
    tools = [{"type": "function", "function": {"name": "mcp-gateway_github.search",
                                               "parameters": {}}}]

    # First hop: no tool result yet -> the stub emits a tool_call (suffix-matched name).
    r1 = client.post("/v1/chat/completions",
                     json=_body([{"role": "user", "content": "find the login bug"}], tools=tools))
    choice = r1.json()["choices"][0]
    assert choice["finish_reason"] == "tool_calls"
    call = choice["message"]["tool_calls"][0]
    assert call["function"]["name"] == "mcp-gateway_github.search"
    assert json.loads(call["function"]["arguments"]) == {"query": "login"}

    # Second hop: a tool result is now in the transcript -> finish with text (turn terminates).
    r2 = client.post("/v1/chat/completions", json=_body([
        {"role": "user", "content": "find the login bug"},
        {"role": "assistant", "content": None, "tool_calls": [call]},
        {"role": "tool", "tool_call_id": call["id"], "content": "found 3 results"},
    ], tools=tools))
    choice2 = r2.json()["choices"][0]
    assert choice2["finish_reason"] == "stop"
    assert choice2["message"]["content"]


def test_tool_not_offered_falls_back_to_text():
    """Tool configured but NOT in the offered set -> plain text, no tool_call."""
    os.environ["LLM_PROXY_STUB_TOOL"] = "search"
    r = client.post("/v1/chat/completions",
                    json=_body([{"role": "user", "content": "hi"}],
                               tools=[{"type": "function", "function": {"name": "read"}}]))
    assert r.json()["choices"][0]["finish_reason"] == "stop"


def test_tool_call_in_stream():
    os.environ["LLM_PROXY_STUB_TOOL"] = "glob"
    r = client.post("/v1/chat/completions", json=_body(
        [{"role": "user", "content": "list files"}], stream=True,
        tools=[{"type": "function", "function": {"name": "glob"}}]))
    frames = [json.loads(ln[6:]) for ln in r.text.splitlines()
              if ln.startswith("data: ") and ln[6:] != "[DONE]"]
    tool_deltas = [c for c in frames if c["choices"][0]["delta"].get("tool_calls")]
    assert len(tool_deltas) == 1
    assert tool_deltas[0]["choices"][0]["delta"]["tool_calls"][0]["function"]["name"] == "glob"
    assert frames[-1]["choices"][0]["finish_reason"] == "tool_calls"
