# M0 — Pilot #1 Wedge

> Governance-first thin slice from the CEO review (`/plan-ceo-review`, 2026-07-13, mode: Scope Reduction). The smallest slice that closes a regulated-buyer pilot: **32 tickets** vs 102 total. Build these first; everything else waits for a signed design partner to pull it.

**The demo this ships:** Mode B team agent on Slack → GitHub action → approval card → audit-log export → **revoke a right, the cron pauses at fire time** (§18.3, AX-067). That last beat is the moat — hold it to maximum rigor.

**Deferred (not in M0):** Mode A personal agents · most of P4 Intelligence · other connectors (M365/Browser/DB/Notion) · P7 prod-hardening (K8s, full gVisor, GitOps, observability, evals, HA/DR, load, pentest). Flag: a tier-1 bank POC touching real data will require pentest + at-rest encryption (AX-088/098) before go-live — write that gate into the pilot SOW.

| # | Ticket | Title | Est | Status | Phase |
|---|---|---|---|---|---|
| 1 | AX-002 | Event schemas + codegen (schemas package) | M | ✅ | P0 |
| 2 | AX-004 | DB migrations + migration tooling | M | ✅ | P0 |
| 3 | AX-015 | Hardened sandbox image | L | ✅ | P1 |
| 4 | AX-020 | llm-proxy (minimal) | M | ✅ | P1 |
| 5 | AX-003 | Shared error taxonomy (errors package) | S | ✅ | P0 |
| 6 | AX-005 | Dev docker-compose stack | S | ✅ | P0 |
| 7 | AX-006 | auth-service (OIDC, JWT, JWKS) | L | ✅ | P0 |
| 8 | AX-007 | Shared runtime libs (bus, OTel, JWT, idempotency) | M | ✅ | P0 |
| 9 | AX-010 | NATS JetStream provisioning | S | ✅ | P0 |
| 10 | AX-011 | backend-core REST+WS API | L | ✅ | P1 |
| 11 | AX-014 | orchestrator sandbox lifecycle (Go) | XL | ✅ | P1 |
| 12 | AX-017 | MCP Gateway core | XL | ✅ | P1 |
| 13 | AX-018 | GitHub MCP server | L | ✅ | P1 |
| 14 | AX-025 | Slack adapter | L | ✅ | P2 |
| 15 | AX-026 | Slack signature verify + retry dedup | S | ✅ | P2 |
| 16 | AX-032 | Permissions engine (RBAC+ABAC) | L | ✅ | P3 |
| 17 | AX-033 | Human approval flow (HITL) | L | ✅ | P3 |
| 18 | AX-036 | Output guardrails / DLP | M | ✅ | P3 |
| 19 | AX-037 | Vault + encrypted OAuth token store | L | ✅ | P3 |
| 20 | AX-039 | Audit log (append-only, partitioned) | M | ✅ | P3 |
| 21 | AX-055 | automation-service jobs API | L | ✅ | P5 |
| 22 | AX-056 | Trigger.dev self-hosted | L | ✅ | P5 |
| 23 | AX-062 | Delivery & notifications | M | ✅ | P5 |
| 24 | AX-013 | prompt-layer (minimal) | L | ✅ | P1 |
| 25 | AX-016 | OpenCode agent + profiles | L | ✅ | P1 |
| 26 | AX-057 | Pivot task (agent-scheduled-run) | L | ✅ | P5 |
| 27 | AX-058 | Scheduler MCP façade | M | ✅ | P5 |
| 28 | AX-059 | Cron creation flow + approval | M | ✅ | P5 |
| 29 | AX-060 | Fire-time permissions preflight | L | ✅ | P5 |
| 30 | AX-067 | P5 exit: fire-time perms proven | S | ✅ | P5 |
| 31 | AX-102 | Team mode (Mode B) configuration | L | ✅ | PX |
| 32 | AX-012 | backend-core ↔ NATS + Postgres | L | ✅ | P1 |

## Parallel non-engineering track (start M1)
- **Payment rail (§G):** line up a local Bedrock/Foundry reseller (LinSoft/SPG). The CTI 10k TND/yr cap breaks by M5-M6; llm-proxy routing makes the switch a config line, but the reseller relationship takes weeks. This can silently halt the LLM — start now.
- **Pipeline (§F.3):** 3 POC proposals out + 2 export conversations by M3, or the cash trajectory is mechanically 'prudent'. Cede on price, never on signature date.
