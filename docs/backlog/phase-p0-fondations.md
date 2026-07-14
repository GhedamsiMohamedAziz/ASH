# P0 — Fondations

> Monorepo, schemas, dev compose, auth, JWT end-to-end.  ·  _2 wk_  ·  10 tickets

## ✅ AX-001 — Monorepo skeleton & tooling

Create the §27 directory layout with per-service docs, root README, Makefile, .gitignore, .env.example.

- **Estimate:** M  ·  **Labels:** infra, dx  ·  **Spec:** §27
- **Depends on:** —
- **Acceptance:**
  - [ ] Tree matches §27
  - [ ] `make help` lists targets
  - [ ] READMEs describe role/stack/phase

## ✅ AX-002 — Event schemas + codegen (schemas package) ⭐M0

Author JSON Schemas for InboundMessage, AgentEvent, AgentTask, ScheduledJob; wire TS + Pydantic codegen.

- **Estimate:** M  ·  **Labels:** schemas, contracts  ·  **Spec:** §7.4, §9
- **Depends on:** AX-001
- **Acceptance:**
  - [ ] 4 schemas validate
  - [ ] TS types + Pydantic models generated in CI
  - [ ] tolerant-reader + vN-1 compat test

## ✅ AX-003 — Shared error taxonomy (errors package) ⭐M0

Encode the §21 error taxonomy once, exported to TS + Py, used by the unified error envelope.

- **Estimate:** S  ·  **Labels:** errors, contracts  ·  **Spec:** §8.3, §21
- **Depends on:** AX-002
- **Acceptance:**
  - [ ] All E_* codes enumerated
  - [ ] Envelope {error:{code,message,trace_id,retry_after}} shared
  - [ ] localized messages fr/en/ar

## ✅ AX-004 — DB migrations + migration tooling ⭐M0

Ship 0001_init + 0002_automations and adopt Atlas (expand/contract, destructive-in-release = STOP).

- **Estimate:** M  ·  **Labels:** db  ·  **Spec:** §16.1, §16.3, §22.3
- **Depends on:** AX-001
- **Acceptance:**
  - [ ] Migrations apply on clean Postgres (17 tables, pgvector, HNSW, partitioned audit)
  - [ ] Atlas lint in CI
  - [ ] rollback documented

## ✅ AX-005 — Dev docker-compose stack ⭐M0

Compose for postgres(pgvector)/redis/nats/vault/trigger.dev with healthchecks; apps behind a profile.

- **Estimate:** S  ·  **Labels:** infra, dx  ·  **Spec:** §22.2
- **Depends on:** AX-004
- **Acceptance:**
  - [ ] `docker compose up` boots data tier healthy
  - [ ] migrations auto-apply
  - [ ] `--profile apps` builds services

## ✅ AX-006 — auth-service (OIDC, JWT, JWKS) ⭐M0

OIDC login (Entra ID / Slack), signed session JWT (15 min), JWKS endpoint, key rotation.

- **Estimate:** L  ·  **Labels:** auth, security  ·  **Spec:** §5, §8.1, §13.4
- **Depends on:** AX-002
- **Acceptance:**
  - [ ] OIDC round-trip works
  - [ ] JWKS served + rotated
  - [ ] fail-closed on invalid/expired token

## ✅ AX-007 — Shared runtime libs (bus, OTel, JWT, idempotency) ⭐M0

shared-ts + shared-py: NATS client, OpenTelemetry setup, JWT verify, idempotency helpers.

- **Estimate:** M  ·  **Labels:** shared, observability  ·  **Spec:** §5, §8.2
- **Depends on:** AX-002
- **Acceptance:**
  - [ ] Bus publish/subscribe helper
  - [ ] traceparent propagation
  - [ ] idempotency-key store helper

## ✅ AX-008 — CI pipeline skeleton

GitHub Actions: lint/typecheck (ruff/mypy, eslint/tsc, golangci-lint), unit tests, contract tests.

- **Estimate:** M  ·  **Labels:** ci, dx  ·  **Spec:** §22.3
- **Depends on:** AX-002, AX-003
- **Acceptance:**
  - [ ] PR runs lint+test+contracts
  - [ ] coverage ≥80% decision code gate
  - [ ] cross-lang schema compat check

## ✅ AX-009 — End-to-end JWT smoke (exit criterion)

Prove identity flows adapter → signed JWT → a protected backend route end-to-end.

- **Estimate:** S  ·  **Labels:** milestone  ·  **Spec:** §29 P0
- **Depends on:** AX-005, AX-006, AX-007
- **Acceptance:**
  - [ ] `docker compose up` functional
  - [ ] JWT minted and validated across a request
  - [ ] P0 exit gate green

## ✅ AX-010 — NATS JetStream provisioning ⭐M0

Declare streams/subjects: inbound.messages, agent.events.*, orchestrator.commands, automation.lifecycle.

- **Estimate:** S  ·  **Labels:** infra, bus  ·  **Spec:** §8.2
- **Depends on:** AX-005
- **Acceptance:**
  - [ ] Streams created with retention/replay config
  - [ ] replay verified
  - [ ] consumer groups documented
