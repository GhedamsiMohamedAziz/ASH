# packages/schemas

Single source of truth for cross-service event contracts (instructions.md §7.4,
Principle #6 "un événement, un contrat"). TS types + Pydantic models are meant to
be **generated** from these JSON Schemas — never hand-written per service.

| Schema | Contract | Notes |
|---|---|---|
| `inbound_message.schema.json` | `InboundMessage` | Produced by all adapters + automation-service. |
| `agent_event.schema.json` | `AgentEvent` | Streamed to clients; carries `seq` for replay (§8.3). |
| `agent_task.schema.json` | `AgentTask` | Prompt Layer → Orchestrator, with the signed TASK JWT (§9). |
| `scheduled_job.schema.json` | `ScheduledJob` | Mirrors `scheduled_jobs` (§16.1); see `db/migrations/0002_automations.sql`. |

**Rules:** additive evolution only (never remove/rename a field within a major
version); bump `schema_version`; consumers are tolerant readers. Codegen wiring
(`quicktype`/`datamodel-codegen`) lands in Phase 0.
