"""Request/response models for auth-service (instructions.md §13.4)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field


class TokenRequest(BaseModel):
    """Mint a service/access JWT, or a TASK JWT variant (§13.4).

    `token_type="task"` adds `allowed_tools` / `approval_tools` / `on_behalf_of`
    (§3.2, §13.4) so the MCP Gateway can scope the agent's tool use.
    """

    sub: str
    org_id: str
    role: str = "member"
    token_type: Literal["access", "task"] = "access"
    iss: str | None = None  # override issuer (defaults to AUTH_ISS)
    aud: str | None = None  # override audience (defaults to AUTH_AUD)

    # TASK JWT extras (ignored for token_type="access")
    allowed_tools: list[str] = Field(default_factory=list)
    approval_tools: list[str] = Field(default_factory=list)
    on_behalf_of: str | None = None
    task_id: str | None = None
    conversation_id: str | None = None


class TokenResponse(BaseModel):
    token: str
    kid: str
    token_type: str
    expires_in: int


class VerifyRequest(BaseModel):
    token: str


class VerifyResponse(BaseModel):
    valid: Literal[True]
    claims: dict[str, Any]


class OidcDevLoginRequest(BaseModel):
    """STUB identity for `POST /oidc/dev-login`.

    Production wires Entra ID (§7.1) / Slack (§7.2) OIDC; the fields below stand
    in for the verified claims a real provider would return after the round-trip.
    """

    sub: str
    org_id: str
    role: str = "member"
    email: str | None = None
    name: str | None = None
