"""Agent runner — a bus CONSUMER (instructions.md §8.2, §9, §10).

Backend Core publishes an InboundMessage to `inbound.messages`; this runner
subscribes, runs the agent turn, and publishes AgentEvents to
`agent.events.{conversation_id}`. The bridge in main.py consumes them back.

Two modes:
  • stub (default) — a deterministic reply, no external calls (tests, offline).
  • integrated — when PROMPT_LAYER_URL + LLM_PROXY_URL are set, the runner calls
    the real prompt-layer (classify + AgentTask) and llm-proxy (completion), so a
    turn carries the real class, model tier and cost. This is the seam where the
    Orchestrator + OpenCode sandbox plug in for a full agentic turn (§10).
"""

from __future__ import annotations

import asyncio
import os

from olma_shared.bus import Message

from .bus import agent_events_subject, bus, clear_cancel, is_cancelled

PROMPT_LAYER_URL = os.getenv("PROMPT_LAYER_URL")
LLM_PROXY_URL = os.getenv("LLM_PROXY_URL")


def start_runner() -> None:
    """Wire the runner onto the bus. Idempotent-ish: call once at startup."""
    bus.subscribe("inbound.messages", _on_inbound)


async def _on_inbound(msg: Message) -> None:
    data = msg.data
    await _run_turn(data["conversation_id"], data["task_id"], data.get("text", ""),
                    org_id=data.get("org_id", "org_1"))


async def _emit(conversation_id: str, etype: str, data: dict) -> None:
    # Publish an event to this conversation's subject; the bridge assigns seq.
    await bus.publish(agent_events_subject(conversation_id), {"type": etype, "data": data})


async def _run_turn(conversation_id: str, task_id: str, text: str, org_id: str = "org_1") -> None:
    clear_cancel(conversation_id)
    await _emit(conversation_id, "agent.thinking", {})
    await asyncio.sleep(0)

    integrated = bool(PROMPT_LAYER_URL and LLM_PROXY_URL)
    if integrated:
        try:
            reply, meta = await _integrated_turn(conversation_id, text, org_id)
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


async def _integrated_turn(conversation_id: str, text: str, org_id: str):
    """Real turn: prompt-layer classifies + routes; llm-proxy completes (§9, §9.5)."""
    import httpx

    inbound = {"message_id": "m", "user_id": "usr_dev", "org_id": org_id,
               "conversation_id": conversation_id, "channel": "web", "text": text}
    async with httpx.AsyncClient(timeout=10) as http:
        pr = await http.post(f"{PROMPT_LAYER_URL}/v1/plan", json={"inbound": inbound})
        pr.raise_for_status()  # a non-2xx must raise, not .json()-crash into a silent hang
        plan = pr.json()
        # A chat_simple turn answers directly; an agentic turn would drive tools via
        # the gateway (that path is the Orchestrator's job, §10). Either way we get a
        # real model-routed completion for the reply.
        tier = "eco" if plan.get("class") == "chat_simple" else "frontier"
        await _emit(conversation_id, "agent.tool.call",
                    {"tool": "llm.complete", "args_summary": f"tier={tier}"})
        cr = await http.post(f"{LLM_PROXY_URL}/v1/complete", json={
            "tier": tier, "messages": [{"role": "user", "content": text}], "org_id": org_id,
        })
        cr.raise_for_status()
        comp = cr.json()
    meta = {"class": plan.get("class"), "tier": tier, "model": comp.get("model"),
            "usage": comp.get("usage"), "cost_usd": comp.get("cost_usd")}
    return comp.get("text", ""), meta


def _chunks(s: str, n: int):
    for i in range(0, len(s), n):
        yield s[i : i + n]
