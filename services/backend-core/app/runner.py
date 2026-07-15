"""Agent runner — a bus CONSUMER (instructions.md §8.2, §9, §10).

Backend Core publishes an InboundMessage to `inbound.messages`; this runner
subscribes, runs the agent turn, and publishes AgentEvents to
`agent.events.{conversation_id}`. The bridge in main.py consumes them back.

Three modes (checked in priority order in `_run_turn`):
  • opencode — when OPENCODE_SERVER_URL is set, the runner drives a REAL `opencode serve`
    over its HTTP API: it creates a session, pushes the turn, consumes OpenCode's SSE event
    stream and maps it to AgentEvents (thinking/text.delta/tool.call/tool.result/done). This
    is the actual agentic turn (§10, §12): OpenCode's LLM points at llm-proxy (the keyless
    stub on the dev/CI path) and its MCP at the real Gateway.
  • integrated — when PROMPT_LAYER_URL + LLM_PROXY_URL are set, the runner calls the real
    prompt-layer (classify + AgentTask) and llm-proxy (completion), so a turn carries the
    real class, model tier and cost.
  • stub (default) — a deterministic reply, no external calls (tests, offline).
"""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

from olma_shared.bus import Message

from .bus import agent_events_subject, bus, clear_cancel, is_cancelled

PROMPT_LAYER_URL = os.getenv("PROMPT_LAYER_URL")
LLM_PROXY_URL = os.getenv("LLM_PROXY_URL")
MCP_GATEWAY_URL = os.getenv("MCP_GATEWAY_URL")

# OpenCode real-turn wiring (§10, §12). OPENCODE_SERVER_URL points at a running
# `opencode serve`; the provider/model/agent select how OpenCode routes the turn — its
# config (sandbox/opencode.json) is what actually points the LLM at llm-proxy and the MCP
# at the Gateway. TASK_JWT is written to a tmpfs path the gateway-auth config can read (§13).
OPENCODE_SERVER_URL = os.getenv("OPENCODE_SERVER_URL")
OPENCODE_PROVIDER_ID = os.getenv("OPENCODE_PROVIDER_ID", "llm-proxy")
OPENCODE_MODEL_ID = os.getenv("OPENCODE_MODEL_ID", "eco")
OPENCODE_AGENT = os.getenv("OPENCODE_AGENT", "build")
OPENCODE_TASK_JWT_PATH = os.getenv("OPENCODE_TASK_JWT_PATH")
OPENCODE_TASK_JWT = os.getenv("TASK_JWT")
OPENCODE_TURN_TIMEOUT = float(os.getenv("OPENCODE_TURN_TIMEOUT", "120"))
# After the prompt POST completes, wait at most this long for session.idle / trailing SSE
# events before ending the drive loop — bounds a delayed/absent session.idle WITHOUT truncating
# the text.delta stream (deltas arrive right after the POST returns; session.idle after them).
OPENCODE_IDLE_GRACE = float(os.getenv("OPENCODE_IDLE_GRACE", "8"))

# Real tool-use loop (§10, §12). An AGENTIC-class turn (plan.class != chat_simple) drives the model
# in a loop: the model emits tool_use blocks, the runner executes each via the Gateway, feeds the
# result back, and repeats until the model returns a final answer (or hits the iteration cap).
AGENTIC_MAX_ITERS = int(os.getenv("RUNNER_AGENTIC_MAX_ITERS", "6"))
AGENTIC_MAX_TOKENS = int(os.getenv("RUNNER_AGENTIC_MAX_TOKENS", "1024"))


class _Cancelled(Exception):
    """The user cancelled mid-turn; unwinds the OpenCode drive loop to emit E_CANCELLED."""


def start_runner() -> None:
    """Wire the runner onto the bus. Idempotent-ish: call once at startup."""
    bus.subscribe("inbound.messages", _on_inbound)


async def _on_inbound(msg: Message) -> None:
    data = msg.data
    # Thread the REAL origin fields from the bus message verbatim (§17.6.3). A webhook-injected
    # turn arrives with channel="webhook"/untrusted=True; fabricating channel="web"/usr_dev here
    # would strip build_task's pre-taint + origin=scheduled, letting an injected turn run
    # untainted + interactive (and exfiltrate via a public-egress tool).
    await _run_turn(data["conversation_id"], data["task_id"], data.get("text", ""),
                    org_id=data.get("org_id", "org_1"),
                    channel=data.get("channel", "web"),
                    untrusted=bool(data.get("untrusted", False)),
                    user_id=data.get("user_id", "usr_dev"))


async def _emit(conversation_id: str, etype: str, data: dict) -> None:
    # Publish an event to this conversation's subject; the bridge assigns seq.
    await bus.publish(agent_events_subject(conversation_id), {"type": etype, "data": data})


async def _run_turn(conversation_id: str, task_id: str, text: str, org_id: str = "org_1",
                    channel: str = "web", untrusted: bool = False,
                    user_id: str = "usr_dev") -> None:
    clear_cancel(conversation_id)
    await _emit(conversation_id, "agent.thinking", {})
    await asyncio.sleep(0)

    # Real agentic turn against a running `opencode serve` (§10, §12). Emits its own
    # text.delta / tool.* / done, so return once it's driven the turn end-to-end.
    if OPENCODE_SERVER_URL:
        # Thread the REAL origin (§17.6.3) into the OpenCode path too — not just conversation/task.
        # Dropping channel/untrusted/user_id here is the residual webhook-exfil hole: the OpenCode
        # turn would present the STATIC env TASK_JWT (fixed origin/task_id, never tainted), so an
        # injected webhook turn runs untainted and the gateway's egress gate never fires.
        await _opencode_turn(conversation_id, task_id, text, org_id,
                             channel=channel, untrusted=untrusted, user_id=user_id)
        return

    integrated = bool(PROMPT_LAYER_URL and LLM_PROXY_URL)
    if integrated:
        try:
            reply, meta = await _integrated_turn(conversation_id, text, org_id,
                                                 channel, untrusted, user_id)
        except _Cancelled:
            # The agentic loop was cancelled mid-turn; E_CANCELLED was already emitted there.
            return
        except Exception as exc:  # noqa: BLE001 — a turn must ALWAYS terminate the WS (§21)
            # prompt-layer or llm-proxy down/timeout/non-2xx: emit a terminal error + done so
            # the client never hangs. (str(exc) is backend-internal, no user secret; truncated.)
            await _emit(conversation_id, "agent.error",
                        {"code": "E_TOOL_UPSTREAM_ERROR",
                         "message": f"Un service interne a échoué : {str(exc)[:160]}"})
            await _emit(conversation_id, "agent.done", {
                "task_id": task_id, "reply": "",
                "usage": {"tokens_in": 0, "tokens_out": 0},
                "cost_usd": 0.0, "model": None, "class": None,
            })
            return
    else:
        reply, meta = f"(stub) reçu : {text.strip()[:120]}", {"tier": None, "cost_usd": 0.0}

    for chunk in _chunks(reply, 24):
        if is_cancelled(conversation_id):
            await _emit(conversation_id, "agent.error",
                        {"code": "E_CANCELLED", "message": "Tour annulé."})
            return
        await _emit(conversation_id, "agent.text.delta", {"text": chunk})
        await asyncio.sleep(0)

    await _emit(conversation_id, "agent.done", {
        "task_id": task_id, "reply": reply,
        "usage": meta.get("usage", {"tokens_in": 0, "tokens_out": 0}),
        "cost_usd": meta.get("cost_usd", 0.0), "model": meta.get("model"),
        "class": meta.get("class"),
    })


async def _integrated_turn(conversation_id: str, text: str, org_id: str,
                           channel: str = "web", untrusted: bool = False,
                           user_id: str = "usr_dev"):
    """Real turn: prompt-layer classifies + routes; llm-proxy completes (§9, §9.5).

    channel/untrusted/user_id are threaded verbatim from the bus message so build_task keeps the
    real origin + taint (a webhook turn stays untrusted + non-interactive, §17.6.3)."""
    import httpx

    inbound = {"message_id": "m", "user_id": user_id, "org_id": org_id,
               "conversation_id": conversation_id, "channel": channel,
               "untrusted": untrusted, "text": text}
    async with httpx.AsyncClient(timeout=60) as http:
        pr = await http.post(f"{PROMPT_LAYER_URL}/v1/plan", json={"inbound": inbound})
        pr.raise_for_status()  # a non-2xx must raise, not .json()-crash into a silent hang
        plan = pr.json()

        allowed = plan.get("allowed_tools") or []
        approval = plan.get("approval_tools") or []
        profile = plan.get("agent_profile") or "generalist"
        klass = plan.get("class")
        # Give the model its real identity + the ACTUAL tools the pipeline authorized for this
        # user/turn (allowed_tools/approval_tools are computed by permissions, §9.4 — not invented),
        # so it answers as the Axone agent and can enumerate its real tools instead of "plain Claude".
        sys_prompt = _sys_prompt(org_id, profile, allowed, approval)

        # Memory capture (§9): when the user says "retiens …" / "remember …", best-effort
        # persist the utterance as a fact via prompt-layer. Failure never breaks the turn.
        if text.lower().lstrip().startswith(("retiens", "remember")):
            try:
                await http.post(f"{PROMPT_LAYER_URL}/internal/memory/save", json={
                    "content": text, "kind": "fact", "task_id": plan.get("task_id")})
            except Exception:  # noqa: BLE001 — memory-save is best-effort
                pass

        # An AGENTIC-class turn (class != chat_simple) runs a REAL tool-use loop through the
        # Gateway when the pipeline authorized tools and a Gateway is configured. Otherwise
        # (chat_simple, or no tools/Gateway) it is a single system-prompted completion — the
        # unchanged §9.5 path.
        if klass != "chat_simple" and MCP_GATEWAY_URL and allowed:
            tool_defs, name_map = await _fetch_tool_defs(http, plan["task_jwt"], allowed)
            if tool_defs:
                return await _agentic_loop(http, conversation_id, plan, sys_prompt, text,
                                           org_id, user_id, tool_defs, name_map)

        tier = "eco" if klass == "chat_simple" else "frontier"
        await _emit(conversation_id, "agent.tool.call",
                    {"tool": "llm.complete", "args_summary": f"tier={tier}"})
        cr = await http.post(f"{LLM_PROXY_URL}/v1/complete", json={
            "tier": tier,
            "messages": [{"role": "system", "content": sys_prompt},
                         {"role": "user", "content": text}],
            "org_id": org_id,
        })
        cr.raise_for_status()
        comp = cr.json()
    meta = {"class": klass, "tier": tier, "model": comp.get("model"),
            "usage": comp.get("usage"), "cost_usd": comp.get("cost_usd")}
    return comp.get("text", ""), meta


def _sys_prompt(org_id: str, profile: str, allowed: list[str], approval: list[str]) -> str:
    """The Axone agent's system prompt: its identity + the REAL tools authorized for this turn."""
    return (
        f"Tu es l'agent Axone de l'organisation « {org_id} » (profil : {profile}). "
        "Tu opères via une MCP Gateway qui filtre, pour cet utilisateur et ce tour, les outils "
        "auxquels tu as accès. "
        + (f"Outils (MCP) actuellement disponibles pour toi : {', '.join(allowed)}. "
           if allowed else "Aucun outil n'est disponible pour ce tour. ")
        + (f"Outils nécessitant une approbation humaine avant exécution : {', '.join(approval)}. "
           if approval else "")
        + "Tu peux aussi créer et gérer des automatisations planifiées (crons) pour l'utilisateur. "
        "Quand un outil peut répondre à la demande, APPELLE-LE réellement au lieu de décrire ce que "
        "tu ferais ; fonde ta réponse finale sur les résultats des outils. "
        "Quand on te demande tes outils, tes MCP ou tes connecteurs, énumère précisément la liste "
        "ci-dessus — ne prétends jamais n'avoir aucun outil. Réponds dans la langue de l'utilisateur "
        "(français par défaut), de façon concise et utile."
    )


async def _fetch_tool_defs(http, task_jwt: str, allowed: list[str]):
    """Fetch the Gateway's MCP tool catalog for THIS token (POST /mcp tools/list, Bearer task_jwt)
    and shape it into Anthropic tool defs. Returns (tool_defs, name_map) where name_map maps the
    MCP underscore name (e.g. `scheduler_list_crons`) back to the dotted gwTool the Gateway executes
    (`scheduler.list_crons`). tools/list already reflects ONLY the token's allowed_tools (§13)."""
    try:
        r = await http.post(f"{MCP_GATEWAY_URL}/mcp",
                            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}},
                            headers={"Authorization": f"Bearer {task_jwt}"})
        r.raise_for_status()
        tools = ((r.json() or {}).get("result") or {}).get("tools") or []
    except Exception:  # noqa: BLE001 — a catalog fetch failure falls back to a plain completion
        return [], {}
    defs = [{"name": t["name"], "description": t.get("description", ""),
             "input_schema": t.get("inputSchema") or {"type": "object"}}
            for t in tools if t.get("name")]
    # The dotted gwTool's underscore form is its MCP name (github.search -> github_search); build
    # the reverse map from the authorized dotted tools so a returned tool_use name resolves exactly.
    name_map = {t.replace(".", "_"): t for t in allowed}
    return defs, name_map


async def _agentic_loop(http, conversation_id: str, plan: dict, sys_prompt: str, text: str,
                        org_id: str, user_id: str, tool_defs: list[dict], name_map: dict[str, str]):
    """The real tool-use loop (§10, §12): the model emits tool_use blocks, each is executed through
    the Gateway (real authz/approval/taint/audit), the result is fed back, and the loop repeats
    until the model returns a final answer, hits the iteration cap, or a tool needs approval."""
    task_jwt = plan["task_jwt"]
    messages: list[dict] = [{"role": "user", "content": text}]
    model = None
    tokens_in = tokens_out = 0
    cost = 0.0
    reply = ""

    for _ in range(AGENTIC_MAX_ITERS):
        if is_cancelled(conversation_id):
            await _emit(conversation_id, "agent.error",
                        {"code": "E_CANCELLED", "message": "Tour annulé."})
            raise _Cancelled()

        cr = await http.post(f"{LLM_PROXY_URL}/v1/complete", json={
            "tier": "frontier",
            "messages": [{"role": "system", "content": sys_prompt}, *messages],
            "org_id": org_id,
            "tools": tool_defs,
            "max_tokens": AGENTIC_MAX_TOKENS,
        })
        cr.raise_for_status()
        comp = cr.json()
        model = comp.get("model") or model
        usage = comp.get("usage") or {}
        tokens_in += int(usage.get("tokens_in", 0) or 0)
        tokens_out += int(usage.get("tokens_out", 0) or 0)
        cost += float(comp.get("cost_usd", 0.0) or 0.0)

        blocks = comp.get("content_blocks") or []
        stop = comp.get("stop_reason")

        if stop == "tool_use":
            # Thread the assistant's tool_use blocks back verbatim so the model sees its own call.
            messages.append({"role": "assistant", "content": blocks})
            tool_uses = [b for b in blocks if b.get("type") == "tool_use"]
            tool_results: list[dict] = []
            for tu in tool_uses:
                mcp_name = tu.get("name", "")
                gw_tool = name_map.get(mcp_name) or mcp_name.replace("_", ".", 1)
                args = tu.get("input") or {}
                await _emit(conversation_id, "agent.tool.call",
                            {"tool": gw_tool, "args_summary": _short_args(args)})
                gw = await http.post(f"{MCP_GATEWAY_URL}/v1/tool/call",
                                     json={"tool": gw_tool, "args": args, "taskJwt": task_jwt})
                gwr = gw.json()
                status = gwr.get("status")
                if status == "needs_approval":
                    # Gate the turn (§13.3): the bridge registers the approval + real id, /approve
                    # re-mints and replays. STOP the loop — the tool must not run un-approved.
                    await _emit(conversation_id, "agent.approval.needed", {
                        "tool": gw_tool, "args_summary": _short_args(args),
                        "user_id": user_id, "org_id": org_id, "args": args,
                        "allowed_tools": plan.get("allowed_tools") or [],
                        "approval_tools": plan.get("approval_tools") or []})
                    meta = {"class": plan.get("class"), "tier": "frontier", "model": model,
                            "usage": {"tokens_in": tokens_in, "tokens_out": tokens_out},
                            "cost_usd": cost}
                    return reply, meta
                result_text = str(gwr.get("result") or gwr.get("reason") or "")
                await _emit(conversation_id, "agent.tool.result",
                            {"tool": gw_tool, "status": status, "result_summary": result_text[:80]})
                tool_results.append({"type": "tool_result", "tool_use_id": tu.get("id", ""),
                                     "content": result_text})
            messages.append({"role": "user", "content": tool_results})
            continue

        # end_turn (or any non-tool_use stop): the model's text is the final reply.
        reply = comp.get("text", "") or "".join(
            b.get("text", "") for b in blocks if b.get("type") == "text")
        break

    meta = {"class": plan.get("class"), "tier": "frontier", "model": model,
            "usage": {"tokens_in": tokens_in, "tokens_out": tokens_out}, "cost_usd": cost}
    return reply, meta


# ---------------------------------------------------------------------------
# OpenCode real-turn mode (§10, §12) — drives a live `opencode serve` over HTTP.
#
# Verified against opencode 1.17.15's real API:
#   POST /session                     -> create a session (returns {id})
#   POST /session/{id}/message        -> push a turn {model:{providerID,modelID}, agent, parts}
#                                        (blocks until the assistant message completes)
#   GET  /event  (SSE)                -> stream events; we map them to AgentEvents
#   POST /session/{id}/abort          -> cancel the running turn
# Event -> AgentEvent mapping:
#   message.part.delta field=text     -> agent.text.delta
#   message.part.delta field=reasoning-> agent.thinking (once)
#   message.part.updated part.type=tool, state.status running/completed/error
#                                     -> agent.tool.call / agent.tool.result
#   session.idle                      -> turn done -> agent.done
# ---------------------------------------------------------------------------


def _write_task_jwt(jwt: str | None = None) -> None:
    """Write the TASK JWT to the tmpfs path the gateway-auth config reads (§11.2, §13).

    OpenCode presents this JWT to the MCP Gateway per turn; the Orchestrator mounts it into
    a tmpfs (never an env var on disk). Best-effort: a missing path/JWT just means no write.

    `jwt` is the per-turn JWT minted hot by the prompt-layer for THIS turn (correct task_id +
    origin + pre-taint, §17.6.3). When None (offline dev/CI, no PROMPT_LAYER_URL), fall back to
    the static env TASK_JWT — the legacy path that keeps current tests/offline runs working.
    """
    value = jwt or OPENCODE_TASK_JWT
    if not (OPENCODE_TASK_JWT_PATH and value):
        return
    try:
        p = Path(OPENCODE_TASK_JWT_PATH)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(value)
    except OSError:
        pass  # tmpfs not present in this environment — the turn still runs (gateway may 401)


async def _opencode_task_jwt(conversation_id: str, text: str, org_id: str,
                             channel: str, untrusted: bool, user_id: str) -> str | None:
    """Mint a per-turn TASK JWT via the prompt-layer /v1/plan (§17.6.3, "le TASK JWT est frappé
    à chaud par le Prompt Layer au moment du run").

    The static env TASK_JWT is minted ONCE with a fixed origin/task_id, so every OpenCode turn —
    including a webhook-injected one — presents the gateway the SAME identity, which is never
    tainted; `github.create_pr`/`slack.send_message`/… (egressClass=public) are then NOT
    reclassified to E_GUARD_TAINTED_EGRESS and exfiltration proceeds. Calling /v1/plan here mints
    a JWT carrying THIS turn's task_id + origin (scheduled for a webhook turn) and triggers
    build_task's pre-taint `taint.taint(tid)` on that task_id, so the gateway's egress gate fires.

    NOTE (ADR-012 seam): the prompt-layer taint ledger and the gateway taint ledger are the same
    store only when REDIS_URL is set for BOTH processes. This mints + pre-taints the per-turn
    task_id; the deployment must wire a shared REDIS_URL so the gateway's isTainted() sees it.
    """
    import httpx

    # Same inbound shape /v1/plan gets on the integrated path — real channel/untrusted/user_id.
    inbound = {"message_id": "m", "user_id": user_id, "org_id": org_id,
               "conversation_id": conversation_id, "channel": channel,
               "untrusted": untrusted, "text": text}
    async with httpx.AsyncClient(timeout=10) as http:
        pr = await http.post(f"{PROMPT_LAYER_URL}/v1/plan", json={"inbound": inbound})
        pr.raise_for_status()  # a non-2xx must raise (fail closed) rather than run untainted
        return pr.json().get("task_jwt")


def _short_args(args) -> str:
    if not isinstance(args, dict) or not args:
        return ""
    return ", ".join(f"{k}={v}" for k, v in list(args.items())[:3])[:80]


async def _opencode_turn(conversation_id: str, task_id: str, text: str, org_id: str,
                         channel: str = "web", untrusted: bool = False,
                         user_id: str = "usr_dev") -> None:
    """Drive one real turn through `opencode serve`, mapping its events to AgentEvents."""
    import httpx

    base = OPENCODE_SERVER_URL.rstrip("/")
    try:
        # Per-turn TASK JWT (§17.6.3): when the pipeline is reachable, mint the JWT hot via
        # /v1/plan so it carries THIS turn's task_id + origin + pre-taint, then hand THAT to
        # OpenCode. Offline (no PROMPT_LAYER_URL) we fall back to the static env TASK_JWT so
        # current tests/offline runs still work. A /v1/plan failure while configured raises here
        # and is caught below (E_TOOL_UPSTREAM_ERROR) — fail closed, never run untainted.
        task_jwt = None
        if PROMPT_LAYER_URL:
            task_jwt = await _opencode_task_jwt(conversation_id, text, org_id,
                                                channel, untrusted, user_id)
        _write_task_jwt(task_jwt)
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, read=None)) as http:
            sr = await http.post(f"{base}/session", json={"title": f"turn:{task_id}"})
            sr.raise_for_status()
            session_id = sr.json()["id"]
            reply, meta = await asyncio.wait_for(
                _opencode_drive(http, base, session_id, conversation_id, text),
                timeout=OPENCODE_TURN_TIMEOUT,
            )
    except _Cancelled:
        # abort was already requested inside the drive loop; terminate the WS cleanly.
        await _emit(conversation_id, "agent.error", {"code": "E_CANCELLED", "message": "Tour annulé."})
        return
    except Exception as exc:  # noqa: BLE001 — a turn must ALWAYS terminate the WS (§21)
        await _emit(conversation_id, "agent.error",
                    {"code": "E_TOOL_UPSTREAM_ERROR",
                     "message": f"OpenCode a échoué : {str(exc)[:160]}"})
        await _emit(conversation_id, "agent.done", {
            "task_id": task_id, "reply": "",
            "usage": {"tokens_in": 0, "tokens_out": 0},
            "cost_usd": 0.0, "model": None, "class": None})
        return

    await _emit(conversation_id, "agent.done", {
        "task_id": task_id, "reply": reply,
        "usage": meta.get("usage", {"tokens_in": 0, "tokens_out": 0}),
        "cost_usd": meta.get("cost_usd", 0.0), "model": meta.get("model"), "class": None})


async def _opencode_drive(http, base: str, session_id: str, conversation_id: str, text: str):
    """Open the event stream, push the turn, and map events until session.idle.

    Returns (reply, meta). Raises _Cancelled on user cancel. The prompt POST is fired as a
    task AFTER the stream is open so no event is missed; its awaited result is the
    authoritative reply + usage (falls back to the streamed text deltas)."""
    reply_parts: list[str] = []
    seen_call: set[str] = set()
    seen_done: set[str] = set()
    thinking_emitted = False

    async with http.stream("GET", f"{base}/event",
                           headers={"accept": "text/event-stream"}) as es:
        prompt_task = asyncio.create_task(_opencode_prompt(http, base, session_id, text))
        lines = es.aiter_lines()
        try:
            while True:
                # session.idle is the terminal and arrives AFTER all message.part.delta events, so
                # we must NOT break the instant the prompt POST returns (that truncates the delta
                # stream). Stream freely until the prompt completes; then wait only a short grace
                # for session.idle / trailing events — bounding a delayed/absent session.idle
                # without burning the full turn timeout or dropping deltas.
                try:
                    if prompt_task.done():
                        line = await asyncio.wait_for(lines.__anext__(), timeout=OPENCODE_IDLE_GRACE)
                    else:
                        line = await lines.__anext__()
                except (asyncio.TimeoutError, StopAsyncIteration):
                    break
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[len("data:"):].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    ev = json.loads(payload)
                except json.JSONDecodeError:
                    continue

                if is_cancelled(conversation_id):
                    await _opencode_abort(http, base, session_id)
                    prompt_task.cancel()
                    raise _Cancelled()

                props = ev.get("properties") or {}
                sid = props.get("sessionID")
                if sid is not None and sid != session_id:
                    continue  # another session's event
                etype = ev.get("type")

                if etype == "message.part.delta":
                    field = props.get("field")
                    delta = props.get("delta") or ""
                    if field == "text" and delta:
                        reply_parts.append(delta)
                        await _emit(conversation_id, "agent.text.delta", {"text": delta})
                    elif field == "reasoning" and delta and not thinking_emitted:
                        thinking_emitted = True
                        await _emit(conversation_id, "agent.thinking", {})
                elif etype == "message.part.updated":
                    part = props.get("part") or {}
                    if part.get("type") == "tool":
                        await _map_tool_part(conversation_id, part, seen_call, seen_done)
                elif etype == "session.idle":
                    # Terminal ONLY for this session — an idle carrying a missing/foreign
                    # sessionID must not end another turn's drive loop (the generic filter above
                    # lets sid=None through, so guard the terminal explicitly). The bounded grace
                    # above (once prompt_task.done()) handles a delayed/absent session.idle.
                    if sid == session_id:
                        break
        finally:
            if not prompt_task.done():
                prompt_task.cancel()

    reply, meta = await prompt_task  # re-raises a prompt failure -> handled by _opencode_turn
    return (reply or "".join(reply_parts)), meta


async def _opencode_prompt(http, base: str, session_id: str, text: str):
    """POST the turn; returns (reply_text, meta) from the completed assistant message."""
    body = {
        "model": {"providerID": OPENCODE_PROVIDER_ID, "modelID": OPENCODE_MODEL_ID},
        "agent": OPENCODE_AGENT,
        "parts": [{"type": "text", "text": text}],
    }
    r = await http.post(f"{base}/session/{session_id}/message", json=body)
    r.raise_for_status()
    data = r.json()
    info = data.get("info") or {}
    parts = data.get("parts") or []
    reply = "".join(p.get("text", "") for p in parts if p.get("type") == "text")
    tokens = info.get("tokens") or {}
    meta = {
        "usage": {"tokens_in": int(tokens.get("input", 0) or 0),
                  "tokens_out": int(tokens.get("output", 0) or 0)},
        "cost_usd": float(info.get("cost", 0.0) or 0.0),
        "model": info.get("modelID"),
    }
    return reply, meta


async def _map_tool_part(conversation_id: str, part: dict, seen_call: set, seen_done: set) -> None:
    """Map an OpenCode tool part's state transitions to agent.tool.call / agent.tool.result."""
    call_id = part.get("callID") or part.get("id")
    tool = part.get("tool")
    state = part.get("state") or {}
    status = state.get("status")

    async def _ensure_call() -> None:
        if call_id not in seen_call:
            seen_call.add(call_id)
            await _emit(conversation_id, "agent.tool.call",
                        {"tool": tool, "args_summary": _short_args(state.get("input"))})

    if status == "running":
        await _ensure_call()
    elif status == "completed":
        await _ensure_call()
        if call_id not in seen_done:
            seen_done.add(call_id)
            await _emit(conversation_id, "agent.tool.result",
                        {"tool": tool, "status": "ok",
                         "result_summary": str(state.get("output") or "")[:80]})
    elif status == "error":
        await _ensure_call()
        if call_id not in seen_done:
            seen_done.add(call_id)
            await _emit(conversation_id, "agent.tool.result",
                        {"tool": tool, "status": "error",
                         "result_summary": str(state.get("error") or "")[:80]})


async def _opencode_abort(http, base: str, session_id: str) -> None:
    try:
        await http.post(f"{base}/session/{session_id}/abort")
    except Exception:  # noqa: BLE001 — abort is best-effort; we still emit E_CANCELLED
        pass


def _chunks(s: str, n: int):
    for i in range(0, len(s), n):
        yield s[i : i + n]
