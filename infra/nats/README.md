# infra/nats (AX-010)

JetStream streams for the internal bus (instructions.md §8.2). `streams.json` is
the declarative source of truth; `tools/provision_nats.py` reconciles a NATS
server to it (idempotent — safe to re-run).

| Stream | Subjects | Role |
|---|---|---|
| `INBOUND` | `inbound.messages`, `inbound.messages.>` | Normalized inbound events from adapters + automation-service (§7.4). |
| `AGENT_EVENTS` | `agent.events.>` | Per-conversation AgentEvents; **replay source** for gap-free WS resume via `last_seq` (§8.3). |
| `ORCHESTRATOR` | `orchestrator.commands`, `.>` | Sandbox turn commands (§10.3). |
| `AUTOMATION` | `automation.lifecycle`, `.>` | Cron lifecycle events (§15). |

All `limits` retention, `file` storage, `num_replicas: 1` (dev; bump for HA §23).

## Provision

```bash
docker compose up -d nats
make nats-provision          # or: NATS_URL=nats://localhost:4222 python3 tools/provision_nats.py
```

Re-running updates streams in place (reconciles subjects/retention) — never
duplicates.

## Consumers & DLQ (follow-up)

Consumers are created per-service with durable names (e.g. `backend-core-events`,
`orchestrator-cmds`) using queue groups for horizontal scale. Per-subject dead-letter
handling (§21: "DLQ NATS par sujet avec rejeu outillé") lands as a follow-up: a
`*.DLQ` stream per domain plus a replay CLI. Consumer + DLQ provisioning will extend
this same declarative file.
