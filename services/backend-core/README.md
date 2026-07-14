# Backend Core

> **Status:** Phase 1 vertical-slice scaffold (runnable) · **Spec:** instructions.md §8.2, §8.3

REST + WebSocket API: conversations, messages, streaming, approvals, cancel.
Talks to the bus and never to the LLM or sandboxes directly (§8.2). In this slice
the store is in-memory and the agent turn is stubbed (`app/runner.py`) so the API
surface and the §8.3 `seq`/replay streaming contract are exercisable today.

- **Stack:** Python 3.12 + FastAPI · **Contracts:** `packages/schemas`.

## Endpoints (`/api/v1`)

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | liveness |
| GET | `/me` | dev user + connections |
| POST | `/conversations` | create → 201 |
| GET | `/conversations` | cursor-paginated |
| GET | `/conversations/{id}/messages` | history |
| POST | `/conversations/{id}/messages` | `Idempotency-Key` required → 202 `{message_id, task_id, stream}` |
| WS | `/conversations/{id}/stream` | `{"type":"subscribe","last_seq":N}` → replays missed events then streams live |
| POST | `/conversations/{id}/approve` | HITL ack (§13.3) |
| POST | `/conversations/{id}/cancel` | cancels the in-flight turn |

## Run & test

```bash
cd services/backend-core
uvicorn app.main:app --reload --port 8000     # http://localhost:8000/docs
python3 -m pytest                             # 8 tests: REST contract + WS replay
```

## Architecture (AX-012 — bus-decoupled)

Backend Core never calls the LLM/sandboxes directly (§8.2). Flow:

```
POST /messages ──persist──▶ publish inbound.messages ──▶ runner (bus consumer)
                                                              │ agent.events.{conv}
   WebSocket ◀── bridge assigns seq ◀── store.record_event ◀─┘
```

- `bus.py` — process-global `InMemoryBus` (prod: NATS JetStream); subjects `inbound.messages`, `agent.events.{conv}`.
- `runner.py` — bus consumer; the stubbed agent turn (prod: Prompt Layer + Orchestrator + OpenCode).
- `main.py` bridge — consumes `agent.events.*`, owns the monotonic `seq` (§8.3), persists the assistant reply.
- `pgstore.py` — asyncpg persistence for `conversations` + `messages`, selected when `DATABASE_URL` is set (else in-memory). Events/WS stay in-memory (transient).
- Shared `olma_shared.idempotency` + `olma_errors.envelope` replace the local versions.

```bash
python3 -m pytest                       # 10 pass + 1 pg test skipped
DATABASE_URL=postgresql://olma:olma@localhost:5432/olma python3 -m pytest  # runs the pg test
```

## Integrated turn (real classification + model routing + cost)

The runner (`app/runner.py`) has two modes. Set `PROMPT_LAYER_URL` + `LLM_PROXY_URL`
and a turn calls the real prompt-layer (classify → tier) and llm-proxy (completion),
so `agent.done` carries the real `class`, `model` and `cost_usd`. Unset → deterministic
stub (tests, offline).

```bash
bash tools/demo_turn.sh "what is our branch naming convention?"   # → chat_simple, eco, haiku, $0.0001
bash tools/demo_turn.sh "déploie fix/login sur staging"           # → task_agentique, frontier, opus
```

The demo boots llm-proxy + prompt-layer + backend-core and streams one turn over
HTTP+WS. This is the seam where the **Orchestrator + OpenCode sandbox (AX-014/016,
Go + gVisor)** plug in for a full agentic turn — not built here (no Go/gVisor in
this env); the runner stands in for that executor.

## Next (Phase 1 proper)

- Swap `InMemoryBus` → real NATS JetStream (`infra/nats` streams exist, AX-010).
- Real JWT auth (`sub`) from auth-service (§13.4) instead of the fixed dev user (AX-006 is built).
- `/internal/scheduled-runs` (mTLS) for the automation-service (§8.2, §15).
- The Go orchestrator + OpenCode sandbox behind the runner seam (AX-014/016).
