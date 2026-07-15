"""prompt-layer — FastAPI surface (instructions.md §9).

Stateless: consumes an InboundMessage, runs the 5-stage pipeline, returns a
validated AgentTask (+ signed TASK JWT). Exposed over HTTP for testability; in
prod it consumes `inbound.messages` off the bus and emits the AgentTask to the
Orchestrator (same pipeline for the scheduler channel).
"""

from __future__ import annotations

import os
import time
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from olma_errors import envelope

from .classify import classify
from .memory import MemoryStore
from .memory_mcp import InMemoryTaint, MemoryMcp
from .pipeline import GuardrailBlocked, build_task, reapprove_task_jwt

app = FastAPI(title="olma prompt-layer", version="0.1.0")

# ---------------------------------------------------------------- shared memory (§9.1)
# One process-wide MemoryMcp over a store + taint ledger. The deterministic test embedder
# has a compressed cosine range, so we run the store at the §9.1 test recall_threshold.
#
# TaintLedger seam (ADR-012, §4.4 "Reste à faire"): REDIS_URL configured → RedisTaint, the same
# Redis the Gateway's TaintStore points at (services/mcp-gateway/src/taint.ts), so a scheduled
# run's taint is visible across processes. Unset → InMemoryTaint, the default — offline/keyless
# dev + test path is unchanged.
_redis_url = os.getenv("REDIS_URL")
if _redis_url:
    from .redis_taint import RedisTaint
    _taint = RedisTaint(_redis_url)
else:
    _taint = InMemoryTaint()
memory = MemoryMcp(MemoryStore(recall_threshold=0.30), taint=_taint)


def _seed_memories() -> None:
    """Seed a few example memories at import so the Mémoires page has content to show.

    One is written under a tainted task to demonstrate the §9.1.4 taint linkage: a
    contaminated turn only ever produces an untrusted row.
    """
    now = time.time()
    memory.save("on déploie via ArgoCD après CI", "fact", now=now)
    memory.save("jamais de merge le vendredi", "correction", now=now)
    _taint.taint("seed_tainted")  # the Gateway would set this on an untrusted ingest
    memory.save("les PR passent par une review", "procedure", now=now,
                task_id="seed_tainted")


_seed_memories()


class PlanRequest(BaseModel):
    inbound: dict
    role: str = "member"


class MemorySaveRequest(BaseModel):
    content: str
    kind: str = "fact"
    task_id: str | None = None


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


@app.get("/internal/memory/list")
def memory_list() -> dict:
    """List every stored memory (read straight off the store) for the Mémoires page (§4.4)."""
    return {"memories": [
        {"id": m.id, "content": m.content, "kind": m.kind, "source_trust": m.source_trust}
        for m in memory.store._items
    ]}


@app.post("/internal/memory/save")
def memory_save(body: MemorySaveRequest) -> dict:
    """Deliberate memory write via the audited MCP (§9.1.1); returns mcp.save()'s dict."""
    return memory.save(body.content, body.kind, now=time.time(), task_id=body.task_id)


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
        # Pass the shared taint ledger so a webhook/untrusted inbound pre-taints its task_id
        # (§15.8/§17.6.3): the Gateway then reclasses egress on the resulting turn.
        task = build_task(body.inbound, role=body.role, taint=_taint)
    except GuardrailBlocked as exc:
        return JSONResponse(status_code=422,
                            content=envelope(exc.code, trace_id=uuid.uuid4().hex))
    except KeyError as exc:
        return JSONResponse(status_code=400,
                            content=envelope("E_VALIDATION", trace_id=uuid.uuid4().hex,
                                             message=f"missing field {exc}"))
    return task.to_dict()
