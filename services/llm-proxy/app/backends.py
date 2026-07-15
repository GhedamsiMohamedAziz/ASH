"""Pluggable LLM backends behind one interface (instructions.md §9.5, §12, §G.4).

Every backend implements `complete(...) -> BackendResult`. The dev/test path ships
`StubBackend` (deterministic, offline, no API key). A real Anthropic / LiteLLM / Bedrock /
Foundry backend drops in behind this same interface — production selects it via
`config.yaml: provider`, and nothing above this module changes.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from typing import Any, Protocol, runtime_checkable

from .models import ChatMessage
from .pricing import token_estimate


class BackendError(Exception):
    """A backend failed (provider incident, quota, timeout). Triggers fallback (§9.5)."""


@dataclass
class BackendResult:
    text: str
    tokens_in: int
    tokens_out: int
    # Anthropic stop_reason + raw content blocks for the tool-use loop (§12). Default to a plain
    # end_turn text block so the classic single-shot path (and every existing caller) is unchanged.
    stop_reason: str | None = None
    blocks: list[dict[str, Any]] = field(default_factory=list)


@runtime_checkable
class Backend(Protocol):
    name: str

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int,
                 tools: list[dict[str, Any]] | None = None) -> BackendResult:
        ...


def _content_text(content: str | list[dict[str, Any]]) -> str:
    """Flatten a message's content to text for token estimation. A block list is JSON-serialized
    so tool_use/tool_result payloads still contribute a stable, reproducible length."""
    if isinstance(content, str):
        return content
    return json.dumps(content, ensure_ascii=False)


def _prompt_text(messages: list[ChatMessage]) -> str:
    return "\n".join(f"{m.role}: {_content_text(m.content)}" for m in messages)


def _has_tool_result(messages: list[ChatMessage]) -> bool:
    """True once a tool_result block has been fed back in — the stub uses it to end its scripted
    loop after one tool call so offline tool-use tests terminate deterministically."""
    for m in messages:
        if isinstance(m.content, list):
            for block in m.content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    return True
    return False


class StubBackend:
    """Deterministic offline backend — same input always yields the same output/usage.

    Stands in for LiteLLM/Anthropic on the dev+test path so the whole proxy runs without a
    network or API key. Token counts are derived from text length so cost is reproducible.
    """

    name = "stub"

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int,
                 tools: list[dict[str, Any]] | None = None) -> BackendResult:
        prompt = _prompt_text(messages)
        tokens_in = token_estimate(prompt)

        # Scripted tool-use path (§12): when tools are offered, no tool_result has come back yet,
        # and LLM_PROXY_STUB_TOOL is configured, emit ONE tool_use block so the offline/keyless
        # test path exercises the runner's real loop without a provider. The env value names the
        # tool (MCP underscore name); it must be one of the offered tools, else the first is used.
        stub_tool = os.environ.get("LLM_PROXY_STUB_TOOL")
        if tools and stub_tool and not _has_tool_result(messages):
            offered = {t.get("name") for t in tools}
            name = stub_tool if stub_tool in offered else next(iter(offered), stub_tool)
            block = {"type": "tool_use", "id": "toolu_stub", "name": name, "input": {}}
            text_out = f"[stub:{model}] calling {name}"
            return BackendResult(
                text="", tokens_in=tokens_in,
                tokens_out=min(max_tokens, token_estimate(text_out)),
                stop_reason="tool_use", blocks=[block],
            )

        text = f"[stub:{model}] echo: {prompt[:200]}"
        tokens_out = min(max_tokens, token_estimate(text))
        return BackendResult(
            text=text, tokens_in=tokens_in, tokens_out=tokens_out,
            stop_reason="end_turn", blocks=[{"type": "text", "text": text}],
        )


class FailingBackend:
    """Backend that always raises — used to prove fallback (§9.5) deterministically."""

    name = "failing"

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int,
                 tools: list[dict[str, Any]] | None = None) -> BackendResult:
        raise BackendError(f"simulated failure for model {model!r}")


class AnthropicBackend:
    """Real Anthropic backend — the money-spending edge (§9.5, §G.4).

    Drops in behind the identical Backend interface: `provider: anthropic` in config.yaml
    selects it, nothing above this module changes. Reads the key from ANTHROPIC_API_KEY
    (never hardcoded, never logged). Every provider failure — rate limit, auth, timeout,
    5xx, connection — is mapped to `BackendError` so the proxy's §9.5 auto-fallback fires
    exactly as it does for the stub's `FailingBackend`.

    Message mapping: `system` roles are hoisted into Anthropic's top-level `system` param;
    `tool` roles fold into `user` (a tool result fed back to the model). Token counts come
    from the real `usage` block, so cost accounting is exact rather than estimated.
    """

    name = "anthropic"

    def __init__(self, *, client=None, timeout: float = 60.0, stream_over_tokens: int = 8000) -> None:
        # Lazily construct the SDK client so importing this module never requires the
        # `anthropic` package or an API key (the stub/test path must stay offline).
        self._client = client
        self._timeout = timeout
        self._stream_over_tokens = stream_over_tokens

    def _get_client(self):
        if self._client is None:
            import anthropic  # lazy: only when a real call is actually made
            self._client = anthropic.Anthropic()
        return self._client

    @staticmethod
    def _split(messages: list[ChatMessage]) -> tuple[str | None, list[dict]]:
        system_parts: list[str] = []
        turns: list[dict] = []
        for m in messages:
            if m.role == "system":
                system_parts.append(m.content)
                continue
            role = "assistant" if m.role == "assistant" else "user"  # tool/user -> user
            turns.append({"role": role, "content": m.content})
        if not turns:
            # Anthropic requires at least one message, first must be user.
            turns.append({"role": "user", "content": (system_parts and system_parts[-1]) or "."})
        system = "\n\n".join(system_parts) if system_parts else None
        return system, turns

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int,
                 tools: list[dict[str, Any]] | None = None) -> BackendResult:
        client = self._get_client().with_options(timeout=self._timeout)
        system, turns = self._split(messages)
        kwargs: dict = {"model": model, "max_tokens": max_tokens, "messages": turns}
        if system is not None:
            kwargs["system"] = system
        # Tool-use loop (§12): hand the Anthropic tool schema to the model so it can emit tool_use
        # blocks. Absent → a plain text completion, byte-identical to before.
        if tools:
            kwargs["tools"] = tools

        try:
            if max_tokens > self._stream_over_tokens:
                # Stream large outputs so we never hit the SDK's non-streaming HTTP timeout.
                with client.messages.stream(**kwargs) as stream:
                    resp = stream.get_final_message()
            else:
                resp = client.messages.create(**kwargs)
        except Exception as err:  # noqa: BLE001 — every provider failure => §9.5 fallback
            # Covers anthropic.APIError (auth/rate-limit/timeout/5xx) and transport errors.
            raise BackendError(f"anthropic backend failed for model {model!r}: {err}") from err

        # Serialize the assistant's content blocks to plain dicts so the tool-use loop can thread
        # them back verbatim: text blocks flatten to `text`, tool_use blocks carry id/name/input.
        blocks: list[dict[str, Any]] = []
        for block in resp.content:
            btype = getattr(block, "type", None)
            if btype == "text":
                blocks.append({"type": "text", "text": getattr(block, "text", "")})
            elif btype == "tool_use":
                blocks.append({
                    "type": "tool_use",
                    "id": getattr(block, "id", ""),
                    "name": getattr(block, "name", ""),
                    "input": getattr(block, "input", {}) or {},
                })
        text = "".join(b["text"] for b in blocks if b["type"] == "text")
        usage = resp.usage
        return BackendResult(
            text=text,
            tokens_in=int(getattr(usage, "input_tokens", 0) or 0),
            tokens_out=int(getattr(usage, "output_tokens", 0) or 0),
            stop_reason=getattr(resp, "stop_reason", None),
            blocks=blocks,
        )


def build_backend(provider: str) -> Backend:
    """Factory: turn config.yaml's `provider` string into a concrete default backend.

    The provider-swap seam (§G.4): `stub` stays offline (dev/test), `anthropic` spends real
    money. Unknown providers fall back to the stub with a loud name so a typo never silently
    routes production traffic to a live model.
    """
    if provider == "anthropic":
        return AnthropicBackend()
    return StubBackend()
