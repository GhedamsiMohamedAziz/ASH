"""OpenAI-compatible stub surface for OpenCode (instructions.md §9.5, §12, §G.4).

OpenCode (the sandbox agent) drives its LLM through an OpenAI-compatible provider
(`@ai-sdk/openai-compatible`, which POSTs `{baseURL}/chat/completions`). llm-proxy's
own `/v1/complete` is a bespoke shape OpenCode cannot speak, so this router adds the
one endpoint OpenCode needs — `POST /v1/chat/completions` — backed by the SAME
deterministic `StubBackend` used everywhere else on the dev/CI path.

Why a stub: the dev + CI path is KEYLESS (no ANTHROPIC_API_KEY, no paid calls). This
endpoint returns a fixed, valid completion for any prompt, and — when `LLM_PROXY_STUB_TOOL`
names a tool that OpenCode offers — emits a single tool_call so an agentic turn exercises a
real MCP tool round-trip through the Gateway before finishing with text. It reuses
`StubBackend` (the existing provider seam, backends.py) so the live `/v1/complete` path is
untouched. A provider-routed OpenAI bridge to a real backend is future work (out of scope).

Selection: `LLM_PROXY_STUB_TOOL` (optional) — a tool name; the stub emits a tool_call for
the offered tool whose function name equals or ends with it (suffix match tolerates MCP name
prefixing, e.g. `mcp-gateway_github.search`). `LLM_PROXY_STUB_TOOL_ARGS` (optional JSON) sets
the call arguments (default `{}`). Unset => text-only, no tool call.
"""

from __future__ import annotations

import json
import os
import time
import uuid

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, StreamingResponse

from .backends import StubBackend
from .models import ChatMessage

router = APIRouter()

_STUB = StubBackend()


def _to_chat_messages(messages: list[dict]) -> list[ChatMessage]:
    out: list[ChatMessage] = []
    for m in messages:
        role = m.get("role", "user")
        if role not in ("system", "user", "assistant", "tool"):
            role = "user"
        content = m.get("content")
        if isinstance(content, list):
            content = " ".join(
                p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"
            )
        out.append(ChatMessage(role=role, content=str(content or "")))
    return out


def _pick_tool(req_tools: list[dict], want: str) -> str | None:
    """Return the offered tool's function name that equals or ends with `want`, else None."""
    for t in req_tools or []:
        fn = (t.get("function") or {}).get("name") if isinstance(t, dict) else None
        if fn and (fn == want or fn.endswith(want) or fn.endswith("." + want) or fn.endswith("_" + want)):
            return fn
    return None


def _tool_directive(messages: list[dict], req_tools: list[dict]) -> tuple[str, dict] | None:
    """Decide whether THIS call should emit a tool_call (deterministic, env-driven).

    Emits a tool_call only on the FIRST hop of a turn — once a `tool` role result is in the
    transcript we return final text so the turn terminates. Returns (tool_name, args) or None.
    """
    want = os.environ.get("LLM_PROXY_STUB_TOOL", "").strip()
    if not want:
        return None
    if any(m.get("role") == "tool" for m in messages):
        return None  # tool already ran this turn -> finish with text
    name = _pick_tool(req_tools, want)
    if not name:
        return None
    raw = os.environ.get("LLM_PROXY_STUB_TOOL_ARGS", "").strip()
    try:
        args = json.loads(raw) if raw else {}
    except json.JSONDecodeError:
        args = {}
    return name, args


def _stub_text(messages: list[dict], model: str) -> str:
    """Deterministic text for a completion — reuses StubBackend's echo shape (backends.py)."""
    return _STUB.complete(model=model, messages=_to_chat_messages(messages), max_tokens=512).text


def _usage(prompt_tokens: int = 10, completion_tokens: int = 8) -> dict:
    return {"prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
            "total_tokens": prompt_tokens + completion_tokens}


@router.post("/v1/chat/completions")
async def chat_completions(request: Request):
    """Deterministic, keyless OpenAI-compatible completion for OpenCode (stream + non-stream)."""
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — a malformed body is a client error, never a hang
        return JSONResponse(status_code=400, content={"error": {"message": "invalid JSON body"}})

    messages: list[dict] = body.get("messages") or []
    req_tools: list[dict] = body.get("tools") or []
    model: str = body.get("model") or "stub-model"
    stream: bool = bool(body.get("stream"))
    cid = "chatcmpl-" + uuid.uuid4().hex[:24]
    created = int(time.time())

    directive = _tool_directive(messages, req_tools)

    if stream:
        return StreamingResponse(
            _stream_chunks(cid, created, model, messages, directive),
            media_type="text/event-stream",
        )

    if directive is not None:
        tool_name, tool_args = directive
        message = {
            "role": "assistant", "content": None,
            "tool_calls": [{
                "id": "call_" + uuid.uuid4().hex[:20], "type": "function",
                "function": {"name": tool_name, "arguments": json.dumps(tool_args)},
            }],
        }
        finish = "tool_calls"
    else:
        message = {"role": "assistant", "content": _stub_text(messages, model)}
        finish = "stop"

    return JSONResponse(content={
        "id": cid, "object": "chat.completion", "created": created, "model": model,
        "choices": [{"index": 0, "message": message, "finish_reason": finish}],
        "usage": _usage(),
    })


def _sse(obj: dict) -> bytes:
    return f"data: {json.dumps(obj)}\n\n".encode()


def _stream_chunks(cid: str, created: int, model: str, messages: list[dict],
                   directive: tuple[str, dict] | None):
    """Yield OpenAI chat.completion.chunk SSE frames (text or a single tool_call)."""
    def chunk(delta: dict, finish=None, usage=None) -> bytes:
        c: dict = {"id": cid, "object": "chat.completion.chunk", "created": created, "model": model,
                   "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        if usage is not None:
            c["usage"] = usage
        return _sse(c)

    yield chunk({"role": "assistant"})
    if directive is not None:
        tool_name, tool_args = directive
        yield chunk({"tool_calls": [{"index": 0, "id": "call_" + uuid.uuid4().hex[:20],
                                     "type": "function",
                                     "function": {"name": tool_name, "arguments": json.dumps(tool_args)}}]})
        yield chunk({}, finish="tool_calls", usage=_usage())
    else:
        text = _stub_text(messages, model)
        # A few deltas so consumers exercise real streaming, not one blob.
        for piece in _split(text, 24):
            yield chunk({"content": piece})
        yield chunk({}, finish="stop", usage=_usage())
    yield b"data: [DONE]\n\n"


def _split(s: str, n: int):
    for i in range(0, len(s), n):
        yield s[i : i + n]
    if not s:
        yield ""
