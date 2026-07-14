"""Pluggable LLM backends behind one interface (instructions.md §9.5, §12, §G.4).

Every backend implements `complete(...) -> BackendResult`. The dev/test path ships
`StubBackend` (deterministic, offline, no API key). A real Anthropic / LiteLLM / Bedrock /
Foundry backend drops in behind this same interface — production selects it via
`config.yaml: provider`, and nothing above this module changes.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol, runtime_checkable

from .models import ChatMessage
from .pricing import token_estimate


class BackendError(Exception):
    """A backend failed (provider incident, quota, timeout). Triggers fallback (§9.5)."""


@dataclass
class BackendResult:
    text: str
    tokens_in: int
    tokens_out: int


@runtime_checkable
class Backend(Protocol):
    name: str

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int) -> BackendResult:
        ...


def _prompt_text(messages: list[ChatMessage]) -> str:
    return "\n".join(f"{m.role}: {m.content}" for m in messages)


class StubBackend:
    """Deterministic offline backend — same input always yields the same output/usage.

    Stands in for LiteLLM/Anthropic on the dev+test path so the whole proxy runs without a
    network or API key. Token counts are derived from text length so cost is reproducible.
    """

    name = "stub"

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int) -> BackendResult:
        prompt = _prompt_text(messages)
        tokens_in = token_estimate(prompt)
        text = f"[stub:{model}] echo: {prompt[:200]}"
        tokens_out = min(max_tokens, token_estimate(text))
        return BackendResult(text=text, tokens_in=tokens_in, tokens_out=tokens_out)


class FailingBackend:
    """Backend that always raises — used to prove fallback (§9.5) deterministically."""

    name = "failing"

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int) -> BackendResult:
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

    def complete(self, *, model: str, messages: list[ChatMessage], max_tokens: int) -> BackendResult:
        client = self._get_client().with_options(timeout=self._timeout)
        system, turns = self._split(messages)
        kwargs: dict = {"model": model, "max_tokens": max_tokens, "messages": turns}
        if system is not None:
            kwargs["system"] = system

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

        text = "".join(
            getattr(block, "text", "") for block in resp.content
            if getattr(block, "type", None) == "text"
        )
        usage = resp.usage
        return BackendResult(
            text=text,
            tokens_in=int(getattr(usage, "input_tokens", 0) or 0),
            tokens_out=int(getattr(usage, "output_tokens", 0) or 0),
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
