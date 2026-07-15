"""Pydantic models for backend-core.

These mirror the canonical JSON Schemas in packages/schemas (InboundMessage,
AgentEvent). In Phase 0 proper these are code-generated; here they are written
by hand to keep the service self-contained and runnable.
"""

from __future__ import annotations

from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field


# ------------------------------------------------------------------ enums
class Channel(str, Enum):
    teams = "teams"
    slack = "slack"
    web = "web"
    scheduler = "scheduler"
    webhook = "webhook"  # event-driven ingress (§15.8) — an UNTRUSTED, non-interactive origin


class AgentEventType(str, Enum):
    thinking = "agent.thinking"
    text_delta = "agent.text.delta"
    tool_call = "agent.tool.call"
    tool_result = "agent.tool.result"
    approval_needed = "agent.approval.needed"
    file_created = "agent.file.created"
    cron_created = "agent.cron.created"
    escalated = "agent.escalated"
    done = "agent.done"
    error = "agent.error"


# ------------------------------------------------------------------ requests
class CreateConversation(BaseModel):
    channel: Channel = Channel.web
    title: str | None = None


class Attachment(BaseModel):
    s3_key: str
    mime: str
    name: str


class SendMessage(BaseModel):
    text: str = Field(min_length=1)
    attachments: list[Attachment] = Field(default_factory=list)


class ApprovalDecision(BaseModel):
    approval_id: str
    decision: Literal["approve", "deny"]


class AutomationPatch(BaseModel):
    """PATCH /api/v1/automations/{job_id} body — only the user-mutable columns of
    scheduled_jobs (db/migrations/0002_automations.sql). Lifecycle transitions other than
    active<->paused (e.g. approval, deletion) go through their own routes."""
    name: str | None = None
    cron: str | None = None
    timezone: str | None = None
    status: Literal["active", "paused"] | None = None
    monthly_budget_usd: float | None = None


class ScheduledRunSubmission(BaseModel):
    """POST /internal/scheduled-runs body — a Trigger.dev fire, re-injected as a
    scheduler-channel InboundMessage through the same bus path as POST /messages."""
    job_id: str
    user_id: str
    org_id: str
    text: str = Field(min_length=1)
    scheduled_for: str | None = None


class InternalAutomationCreate(BaseModel):
    """POST /internal/automations body — the Scheduler MCP's create_cron persists a job here
    (never through the public Gateway, §3.2) so a created cron lands in scheduled_jobs and shows
    up in GET /api/v1/automations. Mirrors the CronSpec the agent authored (§16.1, 0002)."""
    user_id: str
    org_id: str
    name: str = Field(min_length=1)
    prompt: str = Field(min_length=1)
    cron: str = Field(min_length=1)
    timezone: str = "UTC"
    delivery: dict = Field(default_factory=dict)
    per_run_budget: dict = Field(default_factory=dict)
    monthly_budget_usd: float | None = None
    created_by: str = "agent"


class InternalOAuthToken(BaseModel):
    """POST /internal/oauth-tokens body — the MCP Gateway persists a SEALED OAuth token here so a
    gateway RESTART can rehydrate connections (§13.2). ``sealed_token`` is base64 of the gateway's
    AES-256-GCM sealed blob; backend-core stores only that ciphertext (the gateway holds the key),
    so plaintext never reaches this service. org_id/scopes/expires_at are optional metadata."""
    user_id: str
    provider: str
    sealed_token: str  # base64 of the gateway's AES-256-GCM sealed blob (ciphertext only)
    org_id: str | None = None
    scopes: list[str] | None = None
    expires_at: str | None = None


# ------------------------------------------------------------------ responses
class Conversation(BaseModel):
    id: str
    user_id: str
    channel: Channel
    title: str | None = None
    status: str = "active"
    created_at: str


class Message(BaseModel):
    id: str
    conversation_id: str
    role: str  # user|assistant|tool|system
    content: dict[str, Any]
    created_at: str


class SendMessageAccepted(BaseModel):
    message_id: str
    task_id: str
    stream: str


class AgentEvent(BaseModel):
    type: AgentEventType
    seq: int
    data: dict[str, Any] = Field(default_factory=dict)
    ts: int = 0  # wall-clock epoch seconds, stamped by the store at record time (audit uses it)


class Page(BaseModel):
    items: list[Any]
    next_cursor: str | None = None


# ------------------------------------------------------------------ errors
class ErrorBody(BaseModel):
    code: str
    message: str
    trace_id: str | None = None
    retry_after: int | None = None


class ErrorEnvelope(BaseModel):
    error: ErrorBody
