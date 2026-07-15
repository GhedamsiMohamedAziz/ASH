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
import hmac
import json
import os
import uuid
from datetime import datetime, timezone

from fastapi import (
    APIRouter,
    BackgroundTasks,
    Depends,
    FastAPI,
    Header,
    HTTPException,
    Request,
    Response,
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
    AutomationPatch,
    Channel,
    Conversation,
    CreateConversation,
    Message,
    Page,
    ScheduledRunSubmission,
    SendMessage,
    SendMessageAccepted,
)
from .approvals import ApprovalManager, ApprovalError, ApprovalStatus
from .identity import DEV_ORG, DEV_USER, current_identity, verify_token, _auth_error_type
from .runner import start_runner
from .store import Store
from .webhooks import (
    MAX_WEBHOOK_BODY,
    event_type_of,
    header_names,
    resolve_delivery_id,
    verify_for_source,
    webhook_dedup,
    webhook_router,
    webhook_storm,
    within_replay_window,
)

# Identity comes from auth-service's RS256 verifier at the request boundary
# (see .identity). DEV_USER/DEV_ORG remain the header-less fallback constants.

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
    # A gated tool the runner hit: register the approval here (the manager lives in this process),
    # inject the real id, and record only what the card needs (§13.3). /approve then re-mints.
    if etype is AgentEventType.approval_needed and "approval_id" not in data:
        appr = approvals.create(
            conversation_id=conversation_id, tool=data.get("tool", "?"),
            args_summary=data.get("args_summary", ""), requester=data.get("user_id", DEV_USER),
            approver_group=None, now=_clock(),
            user_id=data.get("user_id", DEV_USER), org_id=data.get("org_id", DEV_ORG),
            args=data.get("args") or {}, allowed_tools=data.get("allowed_tools") or [],
            approval_tools=data.get("approval_tools") or [])
        data = {"approval_id": appr.id, "tool": appr.tool, "args_summary": appr.args_summary}
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


# The five providers the web ConnectionsPanel renders (order + labels are the contract).
_PROVIDERS: list[tuple[str, str]] = [
    ("github", "GitHub"),
    ("m365", "Microsoft 365"),
    ("slack", "Slack"),
    ("notion", "Notion"),
    ("database", "Base de données"),
]


def _gateway_connections(user_id: str) -> set[str]:
    """Providers this user has a stored token for, from the gateway's /v1/connections.

    Sync + httpx.Client (same pattern as /memories). Graceful: if MCP_GATEWAY_URL is unset
    or the gateway is down, return an empty set so /me honestly reports all-false and the
    web panel renders instead of erroring — keeping make test-all offline + keyless.
    """
    if not MCP_GATEWAY_URL:
        return set()
    import httpx
    try:
        with httpx.Client(timeout=10) as http:
            r = http.get(f"{MCP_GATEWAY_URL}/v1/connections", params={"userId": user_id})
            r.raise_for_status()
            data = r.json()
            return {c["provider"] for c in data.get("connections", []) if c.get("connected")}
    except Exception:  # noqa: BLE001 — gateway down must not break the connections panel
        return set()


@api.get("/me")
def me(identity: tuple[str, str] = Depends(current_identity)) -> dict:
    # Real connection status (§13.4): connected reflects the gateway's stored tokens for the
    # current user; graceful all-false if the gateway is unset/down.
    user_id, _org_id = identity
    connected = _gateway_connections(user_id)
    return {"user_id": user_id, "connections": [
        {"provider": p, "connected": p in connected, "label": label}
        for p, label in _PROVIDERS
    ]}


@api.post("/connect")
def connect(body: dict, identity: tuple[str, str] = Depends(current_identity)) -> dict:
    """Proxy a provider connection to the gateway for the current user (§13.4).

    Forwards POST {MCP_GATEWAY_URL}/v1/connect {userId, provider, token} and returns the
    gateway result. Graceful (connected:False) if the gateway is unset/down so the flow
    never 500s the web app; keeps make test-all offline + keyless."""
    user_id, _org_id = identity
    provider = body.get("provider")
    if not MCP_GATEWAY_URL:
        return {"connected": False, "provider": provider}
    import httpx
    try:
        with httpx.Client(timeout=10) as http:
            r = http.post(f"{MCP_GATEWAY_URL}/v1/connect", json={
                "userId": user_id, "provider": provider, "token": body.get("token"),
            })
            r.raise_for_status()
            return r.json()
    except Exception:  # noqa: BLE001 — gateway down must not break the connect flow
        return {"connected": False, "provider": provider}


@api.post("/login")
def login(body: dict):
    """Dev login (§7.1, ADR-018): proxy a claimed identity to auth-service `/oidc/dev-login` and
    return its RS256 session token. The web stores it and sends it as `Bearer`, so subsequent
    requests carry a REAL verified identity (`current_identity` checks it). No auth is required to
    obtain a token — this IS the login. In prod this endpoint is replaced by the OIDC
    authorization-code flow; the verified-identity → mint step is what stays. AUTH_SERVICE_URL is a
    module global (defined below with the other service URLs) resolved at call time."""
    sub = str(body.get("sub") or "").strip()
    org_id = str(body.get("org_id") or "").strip()
    if not sub or not org_id:
        return _error(400, "E_VALIDATION", "sub and org_id are required")
    if not AUTH_SERVICE_URL:
        return _error(502, "E_TOOL_UPSTREAM_ERROR", "auth-service not configured")
    import httpx
    try:
        with httpx.Client(timeout=10) as http:
            r = http.post(f"{AUTH_SERVICE_URL}/oidc/dev-login", json={
                "sub": sub, "org_id": org_id, "role": str(body.get("role") or "member")})
            r.raise_for_status()
            return {"token": r.json()["token"], "user_id": sub, "org_id": org_id}
    except Exception:  # noqa: BLE001 — auth-service down must surface, not hang
        return _error(502, "E_TOOL_UPSTREAM_ERROR", "auth-service login failed")


@api.get("/memories")
def memories() -> dict:
    # Proxy the user's saved memories from prompt-layer (§9). Sync + httpx.Client to match
    # _replay_approved_tool. Graceful: if prompt-layer is unset or down, return an empty list
    # so the web memory panel renders instead of erroring.
    if not PROMPT_LAYER_URL:
        return {"memories": []}
    import httpx
    try:
        with httpx.Client(timeout=10) as http:
            r = http.get(f"{PROMPT_LAYER_URL}/internal/memory/list")
            r.raise_for_status()
            return r.json()
    except Exception:  # noqa: BLE001 — prompt-layer down must not break the panel
        return {"memories": []}


# JWT-protected route proving the identity chain end-to-end (AX-009, §5, §8.1):
# auth-service mints a signed RS256 JWT → this route verifies it fail-closed against the
# JWKS (no shared secret) → returns the sub. Unified on the SAME RS256 verifier as
# current_identity (the olma_shared HS256 path is retired, §13.4).
@api.get("/whoami")
def whoami(authorization: str | None = Header(default=None)):
    if not authorization or not authorization.startswith("Bearer "):
        return _error(401, "E_AUTH_INVALID_TOKEN", "missing bearer token")
    try:
        claims = verify_token(authorization[7:])
    except _auth_error_type():
        return _error(401, "E_AUTH_INVALID_TOKEN", "invalid token")
    return {"user_id": claims["sub"], "org_id": claims.get("org_id")}


# --------------------------------------------------------------- automations (PLAN-DEV §3.2)
# scheduled_jobs/scheduled_runs (db/migrations/0002_automations.sql) are Postgres-only — unlike
# conversations, backend-core keeps no in-memory shadow store for them (jobs are created by the
# agent via the Scheduler MCP / prompt-layer's JobStore, not by these routes). Without
# DATABASE_URL there is nothing to read, so list/runs answer with a well-formed empty page and
# patch/delete answer 404 — both honest, neither fabricated, matching the /memories graceful
# pattern used elsewhere in this file.
def _valid_cron(expr: str) -> bool:
    # Minimal syntax check (5 space-separated fields, no seconds). The full §16.1 rule also
    # rejects intervals < 15 min; that needs a cron-schedule parser we don't have here, so it
    # is enforced at creation time (prompt-layer/Scheduler MCP), not re-validated on PATCH.
    return len(expr.split()) == 5


def _automation_404() -> JSONResponse:
    # Same response whether the job doesn't exist or belongs to another user — never leak
    # cross-user existence.
    return _error(404, "E_NOT_FOUND", "automation not found")


@api.get("/automations", response_model=Page)
async def list_automations(
    cursor: str | None = None, limit: int = 50,
    identity: tuple[str, str] = Depends(current_identity),
) -> Page:
    user_id, _org_id = identity
    limit = max(1, min(limit, 100))
    if store.db is None:
        return Page(items=[], next_cursor=None)
    items = await store.db.list_scheduled_jobs(user_id)
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=window, next_cursor=next_cursor)


@api.patch("/automations/{job_id}", response_model=None)
async def patch_automation(
    job_id: str, body: AutomationPatch,
    identity: tuple[str, str] = Depends(current_identity),
) -> dict | JSONResponse:
    user_id, _org_id = identity
    if store.db is None:
        return _automation_404()
    job = await store.db.get_scheduled_job(job_id)
    if job is None or job["user_id"] != user_id:
        return _automation_404()
    fields = body.model_dump(exclude_unset=True)
    if "cron" in fields and not _valid_cron(fields["cron"]):
        return _error(422, "E_SCHED_INVALID_CRON", "invalid cron expression")
    updated = await store.db.update_scheduled_job(job_id, fields)
    return updated


@api.delete("/automations/{job_id}", status_code=204, response_model=None)
async def delete_automation(
    job_id: str, identity: tuple[str, str] = Depends(current_identity),
) -> Response | JSONResponse:
    user_id, _org_id = identity
    if store.db is None:
        return _automation_404()
    job = await store.db.get_scheduled_job(job_id)
    if job is None or job["user_id"] != user_id:
        return _automation_404()
    await store.db.soft_delete_scheduled_job(job_id)
    return Response(status_code=204)


@api.get("/automations/{job_id}/runs", response_model=Page)
async def list_automation_runs(
    job_id: str, cursor: str | None = None, limit: int = 50,
    identity: tuple[str, str] = Depends(current_identity),
) -> Page | JSONResponse:
    user_id, _org_id = identity
    limit = max(1, min(limit, 100))
    if store.db is None:
        return Page(items=[], next_cursor=None)
    job = await store.db.get_scheduled_job(job_id)
    if job is None or job["user_id"] != user_id:
        return _automation_404()
    items = await store.db.list_scheduled_runs(job_id)
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=window, next_cursor=next_cursor)


# --------------------------------------------------------------- admin console (§24.1-24.3)
def _require_admin(authorization: str | None) -> tuple[dict | None, JSONResponse | None]:
    """Fail-closed admin gate: a missing/invalid bearer is 401 (mirrors /whoami — no dev-user
    fallback here, unlike current_identity, since an admin route must never silently downgrade
    to the dev identity); a valid token without the admin/platform_admin role is 403."""
    if not authorization or not authorization.startswith("Bearer "):
        return None, _error(401, "E_AUTH_INVALID_TOKEN", "missing bearer token")
    try:
        claims = verify_token(authorization[7:].strip())
    except _auth_error_type():
        return None, _error(401, "E_AUTH_INVALID_TOKEN", "invalid token")
    if claims.get("role") != "admin" and not claims.get("platform_admin"):
        return None, _error(403, "E_PERM_TOOL_DENIED", "admin scope required")
    return claims, None


def _admin_org_scope(claims: dict) -> str | None:
    """Org an admin-console read is scoped to: an org admin is ALWAYS scoped to their own org
    from the verified identity's `org_id` claim (fail-closed narrower — a client can never
    widen this); platform_admin (a dedicated JWT claim, §24.1) sees every org (None = no
    filter)."""
    if claims.get("platform_admin"):
        return None
    return claims.get("org_id")


# The 5 admin console collections (PLAN-DEV §3.2). users/sandboxes/automations are backed by
# real tables owned by this service (users, sandboxes from db/migrations/0001_init.sql;
# scheduled_jobs from 0002_automations.sql) — wired below via PgStore, same
# DATABASE_URL-gated well-formed-empty skip pattern as audit/usage.
@api.get("/admin/users", response_model=Page)
async def admin_list_users(
    cursor: str | None = None, limit: int = 50, status: str | None = None,
    authorization: str | None = Header(default=None),
) -> Page | JSONResponse:
    claims, denied = _require_admin(authorization)
    if denied:
        return denied
    limit = max(1, min(limit, 100))
    if store.db is None:
        return Page(items=[], next_cursor=None)
    items = await store.db.list_users(org_id=_admin_org_scope(claims), status=status)
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=window, next_cursor=next_cursor)


@api.get("/admin/sandboxes", response_model=Page)
async def admin_list_sandboxes(
    cursor: str | None = None, limit: int = 50,
    authorization: str | None = Header(default=None),
) -> Page | JSONResponse:
    claims, denied = _require_admin(authorization)
    if denied:
        return denied
    limit = max(1, min(limit, 100))
    if store.db is None:
        return Page(items=[], next_cursor=None)
    items = await store.db.list_sandboxes(org_id=_admin_org_scope(claims))
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=window, next_cursor=next_cursor)


@api.get("/admin/audit", response_model=Page)
async def admin_list_audit(
    cursor: str | None = None, limit: int = 50, org: str | None = None,
    authorization: str | None = Header(default=None),
) -> Page | JSONResponse:
    _claims, denied = _require_admin(authorization)
    if denied:
        return denied
    limit = max(1, min(limit, 100))
    if store.db is None:
        return Page(items=[], next_cursor=None)
    items = await store.db.list_audit_log(org_id=org)  # append-only, read-only
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=window, next_cursor=next_cursor)


@api.get("/admin/usage", response_model=Page)
async def admin_list_usage(
    cursor: str | None = None, limit: int = 50, org: str | None = None, day: str | None = None,
    authorization: str | None = Header(default=None),
) -> Page | JSONResponse:
    _claims, denied = _require_admin(authorization)
    if denied:
        return denied
    limit = max(1, min(limit, 100))
    if store.db is None:
        return Page(items=[], next_cursor=None)
    items = await store.db.list_usage_daily(org_id=org, day=day)
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=window, next_cursor=next_cursor)


@api.get("/admin/automations", response_model=Page)
async def admin_list_automations(
    cursor: str | None = None, limit: int = 50,
    authorization: str | None = Header(default=None),
) -> Page | JSONResponse:
    """ORG-WIDE view of scheduled_jobs (§24.2) — unlike GET /automations (owner-scoped to the
    caller), an admin sees every job in their org (or every org, for platform_admin)."""
    claims, denied = _require_admin(authorization)
    if denied:
        return denied
    limit = max(1, min(limit, 100))
    if store.db is None:
        return Page(items=[], next_cursor=None)
    items = await store.db.list_scheduled_jobs_for_org(org_id=_admin_org_scope(claims))
    start = _decode_cursor(cursor) if cursor else 0
    window = items[start : start + limit]
    next_cursor = _encode_cursor(start + limit) if start + limit < len(items) else None
    return Page(items=window, next_cursor=next_cursor)


# --------------------------------------------------------------- conversations
@api.post("/conversations", status_code=201, response_model=Conversation)
async def create_conversation(
    body: CreateConversation,
    identity: tuple[str, str] = Depends(current_identity),
) -> Conversation:
    user_id, _org_id = identity
    conv = Conversation(id=store.new_conversation_id(), user_id=user_id,
                        channel=body.channel, title=body.title, created_at=_now())
    store.add_conversation(conv)
    if store.db is not None:
        await store.db.persist_conversation(conv)
    return conv


@api.get("/conversations", response_model=Page)
def list_conversations(
    cursor: str | None = None, limit: int = 50,
    identity: tuple[str, str] = Depends(current_identity),
) -> Page:
    user_id, _org_id = identity
    limit = max(1, min(limit, 100))
    items = store.list_conversations(user_id)
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


def _audit_row(actor: str, tool: str, status: str, redacted: list[str],
               on_behalf_of: str | None = None, reason: str | None = None, ts: int = 0) -> dict:
    # Gateway AuditEntry shape (§16.1) the web AuditPanel renders.
    return {"ts": ts, "actor": actor, "on_behalf_of": on_behalf_of, "action": "tool.call",
            "tool": tool, "status": status, "redacted": redacted, "reason": reason}


@api.get("/conversations/{conversation_id}/audit")
def list_audit(conversation_id: str) -> dict:
    """The REAL audit trail for a conversation — derived from the recorded events (§16.1),
    not demo data. Every tool call, approval gate, and approval decision the turn actually
    produced, mapped to the audit-row shape (who / tool / verdict / redactions)."""
    state = store.get(conversation_id)
    if state is None:
        raise _conv_404(conversation_id)
    actor = state.conversation.user_id
    rows: list[dict] = []
    for ev in state.events:
        d = ev.data or {}
        t = ev.type
        ts = getattr(ev, "ts", 0)
        if t is AgentEventType.tool_call:
            rows.append(_audit_row(actor, d.get("tool", "?"), "ok", [], ts=ts))
        elif t is AgentEventType.approval_needed:
            rows.append(_audit_row(actor, d.get("tool", "?"), "needs_approval", [], ts=ts))
        elif t is AgentEventType.tool_result:
            action = d.get("action")
            if action == "approval.decision":
                st = "ok" if d.get("status") == "approved" else "denied"
                rows.append(_audit_row(d.get("approver") or actor, d.get("tool", "?"), st, [],
                                       on_behalf_of=d.get("on_behalf_of"), reason="approbation", ts=ts))
            elif action == "approval.replay":
                st = "ok" if d.get("status") == "ok" else "error"
                rows.append(_audit_row(actor, d.get("tool", "?"), st, [], reason=d.get("reason"), ts=ts))
    return {"audit": rows}


@api.post("/conversations/{conversation_id}/messages", status_code=202)
async def send_message(
    conversation_id: str,
    body: SendMessage,
    background: BackgroundTasks,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    identity: tuple[str, str] = Depends(current_identity),
) -> JSONResponse:
    user_id, org_id = identity
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
        "schema_version": "1.2", "message_id": msg.id, "user_id": user_id,
        # The turn runs under the caller's org. Header-less callers fall back to org_1, the org
        # with seeded tool_policies (§9.4) so the agent still has tools (search/create_pr/merge_pr).
        "org_id": org_id, "channel": "web", "conversation_id": conversation_id,
        "task_id": task_id, "text": body.text, "ts": _now(),
        "idempotency_key": idempotency_key,
    }
    background.add_task(bus.publish, SUBJECT_INBOUND, inbound, message_id=idempotency_key)
    return JSONResponse(status_code=202, content=accepted, background=background)


@api.post("/conversations/{conversation_id}/request-approval")
def request_approval(
    conversation_id: str, body: dict,
    identity: tuple[str, str] = Depends(current_identity),
) -> dict:
    """Raise an approval when a tool returns needs_approval from the Gateway (§13.3).

    Emits agent.approval.needed so the client renders the Approve/Deny card.
    """
    if store.get(conversation_id) is None:
        raise _conv_404(conversation_id)
    user_id, org_id = identity
    appr = approvals.create(
        conversation_id=conversation_id, tool=body["tool"],
        args_summary=body.get("args_summary", ""), requester=body.get("requester", user_id),
        approver_group=body.get("approver_group"), now=_clock(),
        # Replay context (§13.3): captured now so approve() can re-mint + re-invoke the tool.
        user_id=body.get("user_id", user_id), org_id=body.get("org_id", org_id),
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
AUTH_SERVICE_URL = os.getenv("AUTH_SERVICE_URL")
LLM_PROXY_URL = os.getenv("LLM_PROXY_URL")

# Dedicated secret for /internal/* (PLAN-DEV §3.2): mTLS terminates at the mesh in prod; this
# header is the in-process defense-in-depth check. Unset => fail-closed (nobody gets in), never
# an accidental open door in an env that forgot to configure it.
INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN")


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
def approve(
    conversation_id: str, decision: ApprovalDecision,
    identity: tuple[str, str] = Depends(current_identity),
):
    if store.get(conversation_id) is None:
        raise _conv_404(conversation_id)
    approver, _org_id = identity
    try:
        appr = approvals.resolve(decision.approval_id, decision=decision.decision,
                                 approver=approver, now=_clock())
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


# --------------------------------------------------------------- internal (never via the Gateway)
def _require_service_token(x_service_token: str | None) -> JSONResponse | None:
    """Gate /internal/* (PLAN-DEV §3.2): mTLS + a dedicated service token, NEVER a user JWT.
    hmac.compare_digest avoids a timing side-channel on the comparison. Fail-closed: an unset
    INTERNAL_SERVICE_TOKEN denies every request rather than accepting anything."""
    if (not INTERNAL_SERVICE_TOKEN or not x_service_token
            or not hmac.compare_digest(x_service_token, INTERNAL_SERVICE_TOKEN)):
        return _error(403, "E_PERM_TOOL_DENIED", "internal route requires a valid service token")
    return None


@app.post("/internal/scheduled-runs", status_code=202)
async def internal_scheduled_run(
    body: ScheduledRunSubmission,
    background: BackgroundTasks,
    x_service_token: str | None = Header(default=None, alias="X-Service-Token"),
) -> JSONResponse:
    """Trigger.dev fires a scheduled job here (never through the public Gateway, §3.2). This
    re-injects the run as a scheduler-channel InboundMessage through the SAME bus path as
    POST /messages (ADR 005 — one pipeline for humans and crons); it does NOT itself write to
    scheduled_runs (that ledger — the fire-time idempotency mark — is prompt-layer JobStore's
    job, out of scope here)."""
    denied = _require_service_token(x_service_token)
    if denied is not None:
        return denied

    conversation_id = f"cron_{body.job_id}"
    if store.get(conversation_id) is None:
        conv = Conversation(id=conversation_id, user_id=body.user_id, channel=Channel.scheduler,
                            title=f"Automation {body.job_id}", created_at=_now())
        store.add_conversation(conv)
        if store.db is not None:
            await store.db.persist_conversation(conv)

    idempotency_key = (f"{body.job_id}:{body.scheduled_for}" if body.scheduled_for
                       else uuid.uuid4().hex)
    prior = store.idempotency.get(idempotency_key)
    if prior is not None:
        return JSONResponse(status_code=202, content=prior)

    msg = Message(id=store.new_message_id(), conversation_id=conversation_id, role="user",
                 content={"text": body.text, "attachments": []}, created_at=_now())
    store.add_message(conversation_id, msg)
    if store.db is not None:
        await store.db.persist_message(msg)

    task_id = store.new_task_id()
    accepted = SendMessageAccepted(
        message_id=msg.id, task_id=task_id,
        stream=f"/api/v1/conversations/{conversation_id}/stream",
    ).model_dump()
    store.idempotency.remember(idempotency_key, accepted)

    inbound = {
        "schema_version": "1.2", "message_id": msg.id, "user_id": body.user_id,
        "org_id": body.org_id, "channel": "scheduler", "conversation_id": conversation_id,
        "task_id": task_id, "text": body.text, "ts": _now(),
        "idempotency_key": idempotency_key, "job_id": body.job_id,
        "scheduled_for": body.scheduled_for,
    }
    background.add_task(bus.publish, SUBJECT_INBOUND, inbound, message_id=idempotency_key)
    return JSONResponse(status_code=202, content=accepted, background=background)


# --------------------------------------------------------------- webhook ingress (§15.8)
@app.post("/webhooks/{source}")
async def webhook_ingress(source: str, request: Request) -> JSONResponse:
    """Event-driven ingress — the complement to crons (§15.8). A public webhook
    (github|sentry|slack|…) is verified, replay/dedup/storm-guarded, matched against the org's
    event-automations, and each match is published to the bus as an UNTRUSTED, webhook-channel
    InboundMessage (a PR title is an injection surface — the turn is tainted, §17.6.3).

    Security, in order (all fail-closed):
      • body-size cap (1 MiB) BEFORE any work → oversized = 413, dropped (OOM DoS, #3);
      • tenant resolution → the request MUST name its org (?org=) so the secret is that org's
        and fan-out is org-scoped; missing = 401 (#4);
      • signature vs the per-(source, org) secret → github signs the raw body, other sources
        use the v0 timestamp-bound scheme; bad/missing = 401 (#1, #4);
      • ±5 min anti-replay for sources with a signed timestamp (github has none → defers to
        its required delivery-id dedup) → 401 (#1);
      • required delivery id for dedup → github's X-GitHub-Delivery, else sha256(signed body);
        a redelivery is acked 200 but reprocessed at most once, and dedup is NEVER skipped (#1);
      • storm control keyed per (source, org, automation) → a flood throttles ONLY that tenant/
        trigger; suppressed deliveries are NOT dedup-consumed, so they stay retryable (#2);
      • dedup-on-SUCCESS → the delivery is marked only after every publish succeeds, so a
        mid-processing failure allows a retry instead of silently dropping the event (ADR-016)."""
    names = header_names(source)

    # 1) Body-size cap (#3) — reject an oversized body BEFORE any auth/parse work (OOM DoS).
    content_length = request.headers.get("content-length")
    if content_length is not None:
        try:
            if int(content_length) > MAX_WEBHOOK_BODY:
                return _error(413, "E_VALIDATION", "webhook body exceeds the 1 MiB cap")
        except ValueError:
            return _error(400, "E_VALIDATION", "invalid Content-Length")
    raw = await request.body()
    if len(raw) > MAX_WEBHOOK_BODY:
        return _error(413, "E_VALIDATION", "webhook body exceeds the 1 MiB cap")

    # 2) Tenant resolution (#4) — the request names its org so the secret used is THAT org's
    # and fan-out stays within it. Missing org → fail closed (no tenant → no secret).
    org_id = request.query_params.get("org", "")
    if not org_id:
        return _error(401, "E_AUTH_INVALID_TOKEN", "missing org for webhook")

    signature = request.headers.get(names["signature"], "")
    ts_header = request.headers.get(names["timestamp"]) if names.get("timestamp") else None

    # 3) Signature — fail-closed, per-(source, org) secret (#1, #4). An unconfigured
    # (source, org) has no secret → denied, never open.
    secret = webhook_router.secret_for(source, org_id)
    if not secret or not verify_for_source(source, secret, ts_header, raw, signature):
        return _error(401, "E_AUTH_INVALID_TOKEN", "invalid or missing webhook signature")

    now = _clock()
    # 4) Anti-replay (±5 min) for sources carrying a signed timestamp (#1). Fail-closed: a
    # missing/stale/malformed ts is rejected. GitHub has no timestamp → its required, unique
    # delivery id (below) is the replay defence.
    if names.get("timestamp") and not within_replay_window(ts_header, now):
        return _error(401, "E_AUTH_INVALID_TOKEN", "webhook timestamp outside the replay window")

    # 5) Delivery id for dedup — REQUIRED, fail-closed, NEVER skipped (#1). github must send a
    # non-empty X-GitHub-Delivery; other sources dedup on sha256 of the signed body.
    delivery = resolve_delivery_id(source, request.headers.get(names["delivery"], ""), raw)
    if not delivery:
        return _error(401, "E_AUTH_INVALID_TOKEN", "missing webhook delivery id")

    try:
        payload = json.loads(raw or b"{}")
    except json.JSONDecodeError:
        return _error(400, "E_VALIDATION", "invalid webhook body")
    if not isinstance(payload, dict):
        return _error(400, "E_VALIDATION", "webhook body must be a JSON object")

    # 6) Dedup — an at-least-once redelivery is acked but NOT reprocessed.
    if webhook_dedup.seen(delivery, now):
        return JSONResponse(status_code=200, content={"status": "duplicate", "fanned_out": 0})

    event_type = event_type_of(source, request.headers, payload)
    inbounds = webhook_router.fan_out(source, org_id, event_type, payload, delivery)

    # 7) No matching automation → 200 ack, nothing published. Record the delivery as handled
    # (a no-match is a terminal, successful outcome — a redelivery need not re-match).
    if not inbounds:
        webhook_dedup.mark(delivery, now)
        return JSONResponse(status_code=200, content={"status": "no_match", "fanned_out": 0})

    # 8) Storm control keyed per (source, org, automation) (#2) — a flood throttles ONLY that
    # target. Suppressed targets are recorded for the digest (StormControl.tripped). When
    # EVERYTHING is suppressed the delivery dedup key is NOT consumed, so the sender's retry
    # (or a digest sweep) can still deliver — a suppressed event is never permanently lost.
    to_publish: list[dict] = []
    suppressed = 0
    for inbound in inbounds:
        storm_key = inbound.pop("_storm_key")
        if webhook_storm.allow(storm_key, now):
            to_publish.append(inbound)
        else:
            suppressed += 1
    if not to_publish:
        return JSONResponse(status_code=200, content={
            "status": "storm_paused", "fanned_out": 0, "suppressed": suppressed})

    # 9) Publish each InboundMessage. Synchronous (not a BackgroundTask) so dedup-on-SUCCESS
    # holds: the delivery is marked ONLY after every publish succeeds — a publish failure
    # returns an error WITHOUT consuming the dedup key, so the webhook retry re-processes it
    # (mirrors the cron fire_job dedup-on-success rule, ADR-016 / §15.6).
    try:
        for inbound in to_publish:
            await bus.publish(SUBJECT_INBOUND, inbound, message_id=inbound["idempotency_key"])
    except Exception as exc:  # noqa: BLE001 — a failed publish must not consume the dedup key
        return _error(502, "E_TOOL_UPSTREAM_ERROR", f"webhook fan-out failed: {str(exc)[:120]}")

    webhook_dedup.mark(delivery, now)
    return JSONResponse(status_code=202, content={
        "status": "accepted", "fanned_out": len(to_publish), "suppressed": suppressed})


app.include_router(api)
