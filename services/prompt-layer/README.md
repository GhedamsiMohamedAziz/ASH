# Prompt Layer

> **Status:** Phase 1 (AX-013, runnable + tested) · **Spec:** instructions.md §9, §9.2–9.5

Stateless control layer **before** the agent. Consumes an InboundMessage, runs
the 5-stage pipeline, emits a validated **AgentTask** with a signed **TASK JWT**.

```
InboundMessage → [1 memory] → [2 planning/classify] → [3 guardrails] → [4 permissions] → [5 routing] → AgentTask + TASK JWT
```

| Stage | This build (AX-013) | Spec |
|---|---|---|
| Planning | `classify.py` — chat_simple vs task_agentique, reversible, recurrence detection | §9.2, §7.2.1 |
| Guardrails | prompt-injection heuristic, **fail-closed** → `E_GUARD_INPUT_BLOCKED` | §9.3 |
| Permissions | `policy.py` PolicyEngine over the `tool_policies` matrix (pattern match, exact>wildcard, fail-closed); `deny` → excluded (AX-032) | §9.4 |
| Routing | tier (eco/frontier) + agent profile by class | §9.5 |
| Memory | no-op hook (lands in P4) | §9.1 |

- **TASK JWT** (`pipeline._sign_task_jwt`): HS256 via `olma_shared.jwt` for dev
  (prod: auth-service RS256 + JWKS, §13.4). Claims: `sub`, `org_id`, `allowed_tools`,
  `approval_tools`, 15-min `exp`. Team mode sets `sub=agent-org@<org>` + `on_behalf_of` (§3.2).
- **Scheduler channel** traverses the same pipeline (`origin=scheduled`); the emitted
  task is identical (§9 intro).

```bash
python3 -m pytest                     # 13 tests
uvicorn app.main:app --port 8000      # POST /v1/plan, /v1/classify, GET /healthz
```

## Permissions (AX-032)

`policy.PolicyEngine` evaluates `(org_id, role, tool)` → `allow | require_approval |
deny` against the `tool_policies` matrix. Trailing-`*` patterns supported; most
specific wins (exact > longer prefix > `*`); no match → deny (fail-closed). Prod
loads rows per org via `load_from_postgres` (seed: `db/migrations/0003_seed_policies.sql`);
loading per run is what makes permissions **re-evaluate at fire time** for crons (§15.6).

## Next
- Real eco-model classification (Haiku few-shot) behind the same `{class, confidence}` contract.
- Wire the memory stage (§9.1).
- Consume `inbound.messages` off the bus and emit AgentTask to the Orchestrator (currently HTTP).
