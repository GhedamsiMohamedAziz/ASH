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
