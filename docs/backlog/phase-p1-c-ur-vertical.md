# P1 — Cœur vertical

> Chat → backend → prompt-layer → orchestrator → sandbox → MCP Gateway → GitHub.  ·  _4 wk_  ·  12 tickets

## ✅ AX-011 — backend-core REST+WS API ⭐M0

FastAPI conversations/messages/stream/approve/cancel/me with idempotency and §8.3 replay protocol.

- **Estimate:** L  ·  **Labels:** backend-core  ·  **Spec:** §8.2, §8.3
- **Depends on:** AX-002
- **Acceptance:**
  - [ ] All /api/v1 routes per §8.2
  - [ ] 202 + Idempotency-Key semantics
  - [ ] WS seq/last_seq replay, gap-free

## ✅ AX-012 — backend-core ↔ NATS + Postgres ⭐M0

Replace in-memory store with asyncpg; publish inbound to bus and bridge AgentEvents back to WS.

- **Estimate:** L  ·  **Labels:** backend-core, db, bus  ·  **Spec:** §8.2
- **Depends on:** AX-011, AX-010, AX-004
- **Acceptance:**
  - [ ] Conversations/messages persisted
  - [ ] inbound published to NATS
  - [ ] events consumed and streamed

## ✅ AX-013 — prompt-layer (minimal) ⭐M0

Stateless service: classify chat_simple vs task_agentique, pass-through routing, emit signed AgentTask.

- **Estimate:** L  ·  **Labels:** prompt-layer  ·  **Spec:** §9, §9.2, §9.5
- **Depends on:** AX-007, AX-006
- **Acceptance:**
  - [ ] Classification <300ms via eco model
  - [ ] AgentTask + TASK JWT emitted
  - [ ] scheduler channel same pipeline

## ✅ AX-014 — orchestrator sandbox lifecycle (Go) ⭐M0

Go service: sandbox state machine (create/warm/active/hibernate/kill), gRPC API, turn dispatch.

- **Estimate:** XL  ·  **Labels:** orchestrator  ·  **Spec:** §10
- **Depends on:** AX-010
- **Acceptance:**
  - [ ] State machine per §10.1
  - [ ] gRPC create/dispatch/cancel
  - [ ] leader election stub

## ✅ AX-015 — Hardened sandbox image ⭐M0

OpenCode Docker image: rootless, gVisor RuntimeClass, no egress except MCP Gateway + llm-proxy.

- **Estimate:** L  ·  **Labels:** sandbox, security  ·  **Spec:** §11.1, §11.2, ADR 002
- **Depends on:** AX-001
- **Acceptance:**
  - [ ] Non-root user
  - [ ] egress locked to gateway/proxy
  - [ ] gVisor runtime verified

## ✅ AX-016 — OpenCode agent + profiles ⭐M0

Run OpenCode in server mode inside the sandbox; load dev/data/ops/generalist profiles; MCP client.

- **Estimate:** L  ·  **Labels:** sandbox, agent  ·  **Spec:** §12, ADR 009
- **Depends on:** AX-015, AX-014
- **Acceptance:**
  - [ ] Agent answers a turn
  - [ ] profiles switch tools/model
  - [ ] events stream to orchestrator

## ✅ AX-017 — MCP Gateway core ⭐M0

Single AuthZ/secret-injection/DLP/audit point: verify TASK JWT, tool routing, audit each call.

- **Estimate:** XL  ·  **Labels:** mcp-gateway, security  ·  **Spec:** §13.1, ADR 001
- **Depends on:** AX-006
- **Acceptance:**
  - [ ] TASK JWT verified (allowed_tools)
  - [ ] tool call → server routed
  - [ ] every call in audit_log

## ✅ AX-018 — GitHub MCP server ⭐M0

Code search/read, branches, commits, PRs, issues, merge (approval-gated).

- **Estimate:** L  ·  **Labels:** mcp-server, github  ·  **Spec:** §14
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Read + create PR works
  - [ ] merge behind require_approval
  - [ ] Co-authored-by/Requested-by on commits

## ✅ AX-019 — Web app chat (streaming)

React chat mapping AgentEvent → UI (deltas, tool lines, approval cards, done/cost); WS token streaming.

- **Estimate:** L  ·  **Labels:** web  ·  **Spec:** §4.3, §7.3
- **Depends on:** AX-011
- **Acceptance:**
  - [ ] Token-by-token streaming
  - [ ] AgentEvent contract rendered per §4.3
  - [ ] reconnect resumes via last_seq

## ✅ AX-020 — llm-proxy (minimal) ⭐M0

LiteLLM config with a single frontier + eco model, budget headers, request logging.

- **Estimate:** M  ·  **Labels:** llm-proxy  ·  **Spec:** §9.5, Annexe H
- **Depends on:** AX-001
- **Acceptance:**
  - [ ] Proxy routes to model
  - [ ] usage/cost captured
  - [ ] timeout+retry configured

## ✅ AX-021 — Persistent workspace volume

Per-user /workspace volume with .agent/ notes; survives sandbox kill/restart.

- **Estimate:** M  ·  **Labels:** sandbox, storage  ·  **Spec:** §11.3, §4 (Principle 4)
- **Depends on:** AX-014
- **Acceptance:**
  - [ ] Volume persists across restarts
  - [ ] notes readable next session
  - [ ] sandbox table tracks volume_id

## ✅ AX-022 — P1 demo: GitHub task from web (exit criterion)

End-to-end: web message → sandbox → GitHub MCP task with live streaming.

- **Estimate:** M  ·  **Labels:** milestone  ·  **Spec:** §29 P1
- **Depends on:** AX-012, AX-013, AX-016, AX-018, AX-019, AX-020
- **Acceptance:**
  - [ ] Full GitHub task from web
  - [ ] streaming visible
  - [ ] P1 exit gate green
