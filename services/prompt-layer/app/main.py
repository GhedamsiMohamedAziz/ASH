"""prompt-layer — FastAPI surface (instructions.md §9).

Stateless: consumes an InboundMessage, runs the 5-stage pipeline, returns a
validated AgentTask (+ signed TASK JWT). Exposed over HTTP for testability; in
prod it consumes `inbound.messages` off the bus and emits the AgentTask to the
Orchestrator (same pipeline for the scheduler channel).
"""

from __future__ import annotations

import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from olma_errors import envelope

from .classify import classify
from .pipeline import GuardrailBlocked, build_task, reapprove_task_jwt

app = FastAPI(title="olma prompt-layer", version="0.1.0")


class PlanRequest(BaseModel):
    inbound: dict
    role: str = "member"


class ReapproveRequest(BaseModel):
    user_id: str
    org_id: str
    tool: str
    allowed_tools: list[str] = []
    approval_tools: list[str] = []
    on_behalf_of: str | None = None


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@app.post("/v1/classify")
def classify_endpoint(body: PlanRequest) -> dict:
    text = body.inbound.get("text", "")
    c = classify(text, has_attachments=bool(body.inbound.get("attachments")))
    return {"class": c.cls, "confidence": c.confidence, "recurrence": c.recurrence}


@app.post("/internal/reapprove")
def reapprove(body: ReapproveRequest) -> dict:
    """Re-mint a TASK JWT with `tool` promoted from approval_tools → allowed_tools (§13.3).

    Called by backend-core after a human approves a gated tool, so the re-invoke passes the
    gateway inline. Internal-only (not user-facing); minting stays in the prompt-layer.
    """
    token = reapprove_task_jwt(
        body.user_id, body.org_id, body.tool,
        body.allowed_tools, body.approval_tools, body.on_behalf_of,
    )
    return {"task_jwt": token}


@app.post("/v1/plan")
def plan(body: PlanRequest):
    try:
        task = build_task(body.inbound, role=body.role)
    except GuardrailBlocked as exc:
        return JSONResponse(status_code=422,
                            content=envelope(exc.code, trace_id=uuid.uuid4().hex))
    except KeyError as exc:
        return JSONResponse(status_code=400,
                            content=envelope("E_VALIDATION", trace_id=uuid.uuid4().hex,
                                             message=f"missing field {exc}"))
    return task.to_dict()
