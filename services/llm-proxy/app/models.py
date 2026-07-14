"""Request/response contracts for the llm-proxy (instructions.md §9.5).

Hand-written Pydantic models to keep the service self-contained and runnable, mirroring
the `POST /v1/complete` shape: `{tier|model, messages, max_tokens, org_id}` in,
`{text, usage:{tokens_in,tokens_out}, cost_usd, model}` out.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator


class ChatMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"] = "user"
    content: str


class CompleteRequest(BaseModel):
    # Exactly one of tier / model selects the target (tier is routed, model is explicit).
    tier: Literal["eco", "frontier"] | None = None
    model: str | None = None
    messages: list[ChatMessage] = Field(min_length=1)
    max_tokens: int = Field(default=512, ge=1)
    org_id: str | None = None
    # Per-call budget ceiling in USD; the request is rejected if cost would exceed it (§9.5).
    budget_usd: float | None = Field(default=None, ge=0)
    # Debug hook: force the primary backend to fail so fallback (§9.5) can be exercised
    # live without a real provider incident. Never set by production callers.
    simulate_primary_failure: bool = False

    @model_validator(mode="after")
    def _one_target(self) -> "CompleteRequest":
        if bool(self.tier) == bool(self.model):
            raise ValueError("provide exactly one of `tier` or `model`")
        return self


class Usage(BaseModel):
    tokens_in: int
    tokens_out: int


class CompleteResponse(BaseModel):
    text: str
    usage: Usage
    cost_usd: float
    model: str
    # True when the primary model failed and the tier fallback served the request (§9.5).
    fell_back: bool = False


class ErrorBody(BaseModel):
    code: str
    message: str
    trace_id: str | None = None


class ErrorEnvelope(BaseModel):
    error: ErrorBody
