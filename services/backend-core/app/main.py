"""backend-core — REST + WebSocket API (instructions.md §8.2, §8.3).

Phase-1 vertical slice, now decoupled through the bus (§8.2): a posted message is
persisted, then published to `inbound.messages`; the runner (a bus consumer)
streams AgentEvents to `agent.events.{conversation_id}`; a bridge here consumes
them, assigns the monotonic `seq`, and fans out to WebSocket subscribers.
Conversations/messages persist to Postgres when DATABASE_URL is set.
Auth is stubbed (fixed dev user) until auth-service (§13.4) is wired.
"""

from __future__ import annotations

import base64
import contextlib
import os
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    FastAPI,
    Header,
    HTTPException,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.responses import JSONResponse

from olma_errors import envelope
from olma_shared.bus import Message as BusMessage

from .bus import SUBJECT_INBOUND, bus, mark_cancelled
from .models import (
    AgentEvent,
    AgentEventType,
    ApprovalDecision,
    Conversation,
    CreateConversation,
    Message,
    Page,
    SendMessage,
    SendMessageAccepted,
)
from .approvals import ApprovalManager, ApprovalError, ApprovalStatus
from .runner import start_runner
from .store import Store

DEV_USER = "usr_dev"  # TODO: JWT `sub` from auth-service (§13.4)

store = Store()
approvals = ApprovalManager()


def _clock() -> float:
    import time
    return time.time()


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _error(status: int, code: str, message: str | None = None) -> JSONResponse:
    return JSONResponse(status_code=status,
                        content=envelope(code, trace_id=uuid.uuid4().hex, message=message))


def _encode_cursor(index: int) -> str:
    return base64.urlsafe_b64encode(str(index).encode()).decode()


def _decode_cursor(cursor: str) -> int:
    try:
        return int(base64.urlsafe_b64decode(cursor.encode()).decode())
    except Exception:
        raise HTTPException(status_code=400, detail="bad cursor")


# --------------------------------------------------------------- bridge (bus → store/WS)
async def _on_agent_event(msg: BusMessage) -> None:
    """Consume `agent.events.*`, assign seq into the store, persist terminal reply."""
    conversation_id = msg.subject.rsplit(".", 1)[-1]
    if store.get(conversation_id) is None:
        return
    etype = AgentEventType(msg.data["type"])
    data = dict(msg.data.get("data", {}))
    # On the terminal event, persist the assistant message (persistence stays here).
    if etype is AgentEventType.done and "reply" in data:
        reply = data.pop("reply")
        amsg = Message(id=store.new_message_id(), conversation_id=conversation_id,
                       role="assistant", content={"text": reply}, created_at=_now())
        store.add_message(conversation_id, amsg)
        if store.db is not None:
            await store.db.persist_message(amsg)
    store.record_event(conversation_id, etype, data)


# --------------------------------------------------------------- app + lifespan
@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    dsn = os.getenv("DATABASE_URL")
    if dsn:
        from .pgstore import PgStore
        db = PgStore(dsn)
        await db.connect()
        await db.ensure_dev_user(DEV_USER)
        store.db = db
    try:
        yield
    finally:
        if store.db is not None:
            await store.db.close()
            store.db = None


app = FastAPI(title="olma backend-core", version="0.1.0", lifespan=lifespan)
api = APIRouter(prefix="/api/v1")

# Wire the bus consumers at import time — the in-process InMemoryBus needs no
# running loop to subscribe, and tests use a plain TestClient (no lifespan).
bus.subscribe("agent.events.*", _on_agent_event)
start_runner()


# --------------------------------------------------------------- health / me
@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok"}


@api.get("/me")
def me() -> dict:
    return {"user_id": DEV_USER, "connections": []}


# JWT-protected route proving the identity chain end-to-end (AX-009, §5, §8.1):
# adapter mints a signed JWT → this route verifies it fail-closed → returns the sub.
# Fail closed in prod: /whoami verifies bearer tokens against this, so a well-known dev
# default under OLMA_ENV=prod would be an auth bypass. Require the env var when ENV=prod.
_OLMA_ENV = os.getenv("OLMA_ENV", "dev")
SESSION_JWT_SECRET = os.getenv("SESSION_JWT_SECRET") or (
    "dev-session-secret" if _OLMA_ENV != "prod" else None
)
if SESSION_JWT_SECRET is None:
    raise RuntimeError("SESSION_JWT_SECRET must be set when OLMA_ENV=prod")


@api.get("/whoami")
def whoami(authorization: str | None = Header(default=None)):
    from olma_shared import jwt as sjwt
    if not authorization or not authorization.startswith("Bearer "):
        return _error(401, "E_AUTH_INVALID_TOKEN", "missing bearer token")
    try:
        claims = sjwt.verify(authorization[7:], SESSION_JWT_SECRET,
                             iss="olma-auth", aud="olma-internal")
    except sjwt.JWTError:
        return _error(401, "E_AUTH_INVALID_TOKEN", "invalid token")
    return {"user_id": claims["sub"], "org_id": claims.get("org_id")}


# --------------------------------------------------------------- conversations
@api.post("/conversations", status_code=201, response_model=Conversation)
async def create_conversation(body: CreateConversation) -> Conversation:
    conv = Conversation(id=store.new_conversation_id(), user_id=DEV_USER,
                        channel=body.channel, title=body.title, created_at=_now())
    store.add_conversation(conv)
    if store.db is not None:
        await store.db.persist_conversation(conv)
    return conv


@api.get("/conversations", response_model=Page)
def list_conversations(cursor: str | None = None, limit: int = 50) -> Page:
    limit = max(1, min(limit, 100))
    items = store.list_conversations(DEV_USER)
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=[c.model_dump() for c in window], next_cursor=next_cursor)


@api.get("/conversations/{conversation_id}/messages", response_model=Page)
def list_messages(conversation_id: str) -> Page:
    state = store.get(conversation_id)
    if state is None:
        raise _conv_404(conversation_id)
    return Page(items=[m.model_dump() for m in state.messages], next_cursor=None)


@api.post("/conversations/{conversation_id}/messages", status_code=202)
async def send_message(
    conversation_id: str,
    body: SendMessage,
    background: BackgroundTasks,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
) -> JSONResponse:
    if idempotency_key is None:
        return _error(400, "E_IDEMPOTENCY_KEY_REQUIRED")
    prior = store.idempotency.get(idempotency_key)
    if prior is not None:
        return JSONResponse(status_code=202, content=prior)

    if store.get(conversation_id) is None:
        return _error(404, "E_CONV_NOT_FOUND")

    msg = Message(
        id=store.new_message_id(), conversation_id=conversation_id, role="user",
        content={"text": body.text, "attachments": [a.model_dump() for a in body.attachments]},
        created_at=_now(),
    )
    store.add_message(conversation_id, msg)
    if store.db is not None:
        await store.db.persist_message(msg)

    task_id = store.new_task_id()
    accepted = SendMessageAccepted(
        message_id=msg.id, task_id=task_id,
        stream=f"/api/v1/conversations/{conversation_id}/stream",
    ).model_dump()
    store.idempotency.remember(idempotency_key, accepted)

    # Publish InboundMessage to the bus AFTER the 202 is returned (§8.2). A
    # BackgroundTask (not a bare create_task) is driven deterministically by both
    # uvicorn and the test client, so the turn always runs.
    inbound = {
        "schema_version": "1.2", "message_id": msg.id, "user_id": DEV_USER,
        "org_id": "org_dev", "channel": "web", "conversation_id": conversation_id,
        "task_id": task_id, "text": body.text, "ts": _now(),
        "idempotency_key": idempotency_key,
    }
    background.add_task(bus.publish, SUBJECT_INBOUND, inbound, message_id=idempotency_key)
    return JSONResponse(status_code=202, content=accepted, background=background)


@api.post("/conversations/{conversation_id}/request-approval")
def request_approval(conversation_id: str, body: dict) -> dict:
    """Raise an approval when a tool returns needs_approval from the Gateway (§13.3).

    Emits agent.approval.needed so the client renders the Approve/Deny card.
    """
    if store.get(conversation_id) is None:
        raise _conv_404(conversation_id)
    appr = approvals.create(
        conversation_id=conversation_id, tool=body["tool"],
        args_summary=body.get("args_summary", ""), requester=body.get("requester", DEV_USER),
        approver_group=body.get("approver_group"), now=_clock(),
        # Replay context (§13.3): captured now so approve() can re-mint + re-invoke the tool.
        user_id=body.get("user_id", DEV_USER), org_id=body.get("org_id", "org_1"),
        args=body.get("args") or {},
        allowed_tools=body.get("allowed_tools") or [],
        approval_tools=body.get("approval_tools") or [],
    )
    store.record_event(conversation_id, AgentEventType.approval_needed, {
        "approval_id": appr.id, "tool": appr.tool, "args_summary": appr.args_summary,
        "approver_group": appr.approver_group,
    })
    return {"approval_id": appr.id, "status": appr.status.value}


# Re-mint + re-invoke wiring (§13.3). Set both URLs to complete the approval loop live; unset
# (dev/test) keeps approve() a pure decision, exactly as before.
PROMPT_LAYER_URL = os.getenv("PROMPT_LAYER_URL")
MCP_GATEWAY_URL = os.getenv("MCP_GATEWAY_URL")


def _replay_approved_tool(appr) -> dict | None:
    """After approval, re-mint a TASK JWT with the tool promoted (prompt-layer /internal/reapprove)
    and re-invoke it through the gateway (§13.3). Returns the gateway result, or None if the loop
    isn't wired (dev/test). Best-effort: a failure here is reported, never raised into the route."""
    if not (PROMPT_LAYER_URL and MCP_GATEWAY_URL):
        return None
    import httpx
    allowed, approval = approvals.promote(appr)
    try:
        with httpx.Client(timeout=10) as http:
            rm = http.post(f"{PROMPT_LAYER_URL}/internal/reapprove", json={
                "user_id": appr.user_id, "org_id": appr.org_id, "tool": appr.tool,
                "allowed_tools": allowed, "approval_tools": approval,
            })
            rm.raise_for_status()
            task_jwt = rm.json()["task_jwt"]
            gw = http.post(f"{MCP_GATEWAY_URL}/v1/tool/call", json={
                "tool": appr.tool, "args": appr.args or {}, "taskJwt": task_jwt,
            })
            return gw.json()
    except Exception as exc:  # noqa: BLE001 — replay failure must not break the approve response
        return {"status": "error", "code": "E_TOOL_UPSTREAM_ERROR", "reason": str(exc)[:160]}


@api.post("/conversations/{conversation_id}/approve", response_model=None)
def approve(conversation_id: str, decision: ApprovalDecision):
    if store.get(conversation_id) is None:
        raise _conv_404(conversation_id)
    try:
        appr = approvals.resolve(decision.approval_id, decision=decision.decision,
                                 approver=DEV_USER, now=_clock())
    except ApprovalError as exc:
        return _error(409, "E_VALIDATION", str(exc))
    # Audit records requester AND approver (§3.2).
    store.record_event(conversation_id, AgentEventType.tool_result, {
        "action": "approval.decision", **approvals.audit_detail(appr)})

    # On approve, close the loop: re-mint with the tool promoted + re-invoke through the gateway.
    replay = None
    if appr.status is ApprovalStatus.approved:
        replay = _replay_approved_tool(appr)
        if replay is not None:
            store.record_event(conversation_id, AgentEventType.tool_result, {
                "action": "approval.replay", "tool": appr.tool,
                "status": replay.get("status"), "result": replay.get("result"),
                "reason": replay.get("reason"),
            })
    out = {"status": appr.status.value, "approver": appr.approver}
    if replay is not None:
        out["replay"] = replay
    return out


@api.post("/conversations/{conversation_id}/cancel")
def cancel(conversation_id: str) -> dict:
    if store.get(conversation_id) is None:
        raise _conv_404(conversation_id)
    mark_cancelled(conversation_id)
    return {"status": "cancelling"}


def _conv_404(conversation_id: str) -> HTTPException:
    return HTTPException(status_code=404, detail=f"Conversation {conversation_id} not found.")


# --------------------------------------------------------------- WebSocket stream
@app.websocket("/api/v1/conversations/{conversation_id}/stream")
async def stream(ws: WebSocket, conversation_id: str) -> None:
    await ws.accept()
    if store.get(conversation_id) is None:
        await ws.close(code=4003)
        return

    try:
        hello = await ws.receive_json()
    except Exception:
        hello = {"type": "subscribe", "last_seq": 0}
    last_seq = int(hello.get("last_seq", 0) or 0)

    q = store.subscribe(conversation_id)
    try:
        for event in store.replay_since(conversation_id, last_seq):
            await _send(ws, event)
            last_seq = event.seq
        while True:
            event: AgentEvent = await q.get()
            if event.seq <= last_seq:
                continue
            await _send(ws, event)
            last_seq = event.seq
    except WebSocketDisconnect:
        pass
    finally:
        store.unsubscribe(conversation_id, q)


async def _send(ws: WebSocket, event: AgentEvent) -> None:
    await ws.send_json({"type": event.type.value, "seq": event.seq, "data": event.data})


app.include_router(api)
