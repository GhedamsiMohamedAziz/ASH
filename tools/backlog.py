#!/usr/bin/env python3
"""
Project backlog — source of truth for every ticket needed to take Axone from
blueprint (instructions.md) to a production-ready v1.

Tickets are derived from the §29 roadmap (phases P0–P7) plus cross-cutting
business/security work (§30, §17, Annexes). Running this file emits:

  docs/backlog/tickets.json          machine-readable export
  docs/backlog/README.md             board overview (counts, deps, legend)
  docs/backlog/phase-<N>-<slug>.md   one file per epic/phase
  tools/seed_github_issues.sh        creates GH labels/milestones/issues via `gh`

Edit the TICKETS data below, then:  python3 tools/backlog.py
"""

from __future__ import annotations

import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "docs" / "backlog"

# Estimates: S ≈ 1-2d, M ≈ 3-5d, L ≈ 1-2wk, XL ≈ 2wk+.
# Status: done | in_progress | todo.

PHASES = [
    ("P0", "Fondations", "Monorepo, schemas, dev compose, auth, JWT end-to-end.", "2 wk"),
    ("P1", "Cœur vertical", "Chat → backend → prompt-layer → orchestrator → sandbox → MCP Gateway → GitHub.", "4 wk"),
    ("P2", "Multi-canal", "Teams + Slack adapters with SSO, cards, approvals, escalation.", "3 wk"),
    ("P3", "Contrôle", "Permissions, approvals, guardrails, Vault/OAuth, audit, admin v1.", "3 wk"),
    ("P4", "Intelligence", "Memory, planning, model routing, budgets, profiles.", "3 wk"),
    ("P5", "Automatisations", "automation-service + Trigger.dev, Scheduler MCP, delivery, fire-time perms.", "3 wk"),
    ("P6", "Étendue MCP", "M365, Browser, Database, Notion, Slack connectors.", "3 wk"),
    ("P7", "Prod-ready", "K8s+gVisor, GitOps, observability, evals gate, HA/DR, load, pentest.", "4 wk"),
    ("PX", "Cross-cutting", "Localization, business/GTM, compliance, security hardening.", "ongoing"),
]

# M0-pilot wedge — the governance-first thin slice from the CEO review
# (/plan-ceo-review, 2026-07-13). The ~28 tickets that ship the demo a regulated
# buyer's security team signs off on: Mode B team agent on Slack, GitHub, and the
# approval + audit + fire-time-revocation governance moment. Everything else is
# deferred until a signed pilot pulls it. Build these before anything else.
WEDGE_M0 = {
    # foundations / spine (AX-001 monorepo is already done, so not re-listed)
    "AX-002", "AX-003", "AX-004", "AX-005", "AX-006", "AX-007", "AX-010",
    "AX-011", "AX-012", "AX-013", "AX-014", "AX-015", "AX-016", "AX-020",
    # the moat — held to maximum rigor (this is what gets audited)
    "AX-017", "AX-032", "AX-033", "AX-036", "AX-037", "AX-039", "AX-060", "AX-067",
    # one connector + one channel + team mode
    "AX-018", "AX-025", "AX-026", "AX-102",
    # automation wedge (Trigger.dev + delivery so the revocation demo has a live cron to kill)
    "AX-055", "AX-056", "AX-057", "AX-058", "AX-059", "AX-062",
}

# id, phase, title, description, acceptance[list], deps[list], est, labels[list], spec, status
_T: list[dict] = []


def T(id, phase, title, desc, acc, deps, est, labels, spec, status="todo"):
    _T.append({
        "id": id, "phase": phase, "title": title, "description": desc,
        "acceptance": acc, "deps": deps, "estimate": est, "labels": labels,
        "spec": spec, "status": status, "wedge": id in WEDGE_M0,
    })


# ─────────────────────────────────────────────────────────── P0 — Fondations
T("AX-001", "P0", "Monorepo skeleton & tooling",
  "Create the §27 directory layout with per-service docs, root README, Makefile, .gitignore, .env.example.",
  ["Tree matches §27", "`make help` lists targets", "READMEs describe role/stack/phase"],
  [], "M", ["infra", "dx"], "§27", "done")
T("AX-002", "P0", "Event schemas + codegen (schemas package)",
  "Author JSON Schemas for InboundMessage, AgentEvent, AgentTask, ScheduledJob; wire TS + Pydantic codegen.",
  ["4 schemas validate", "TS types + Pydantic models generated in CI", "tolerant-reader + vN-1 compat test"],
  ["AX-001"], "M", ["schemas", "contracts"], "§7.4, §9", "done")
T("AX-003", "P0", "Shared error taxonomy (errors package)",
  "Encode the §21 error taxonomy once, exported to TS + Py, used by the unified error envelope.",
  ["All E_* codes enumerated", "Envelope {error:{code,message,trace_id,retry_after}} shared", "localized messages fr/en/ar"],
  ["AX-002"], "S", ["errors", "contracts"], "§8.3, §21", "done")
T("AX-004", "P0", "DB migrations + migration tooling",
  "Ship 0001_init + 0002_automations and adopt Atlas (expand/contract, destructive-in-release = STOP).",
  ["Migrations apply on clean Postgres (17 tables, pgvector, HNSW, partitioned audit)", "Atlas lint in CI", "rollback documented"],
  ["AX-001"], "M", ["db"], "§16.1, §16.3, §22.3", "done")
T("AX-005", "P0", "Dev docker-compose stack",
  "Compose for postgres(pgvector)/redis/nats/vault/trigger.dev with healthchecks; apps behind a profile.",
  ["`docker compose up` boots data tier healthy", "migrations auto-apply", "`--profile apps` builds services"],
  ["AX-004"], "S", ["infra", "dx"], "§22.2", "done")
T("AX-006", "P0", "auth-service (OIDC, JWT, JWKS)",
  "OIDC login (Entra ID / Slack), signed session JWT (15 min), JWKS endpoint, key rotation.",
  ["OIDC round-trip works", "JWKS served + rotated", "fail-closed on invalid/expired token"],
  ["AX-002"], "L", ["auth", "security"], "§5, §8.1, §13.4", "done")
T("AX-007", "P0", "Shared runtime libs (bus, OTel, JWT, idempotency)",
  "shared-ts + shared-py: NATS client, OpenTelemetry setup, JWT verify, idempotency helpers.",
  ["Bus publish/subscribe helper", "traceparent propagation", "idempotency-key store helper"],
  ["AX-002"], "M", ["shared", "observability"], "§5, §8.2", "done")
T("AX-008", "P0", "CI pipeline skeleton",
  "GitHub Actions: lint/typecheck (ruff/mypy, eslint/tsc, golangci-lint), unit tests, contract tests.",
  ["PR runs lint+test+contracts", "coverage ≥80% decision code gate", "cross-lang schema compat check"],
  ["AX-002", "AX-003"], "M", ["ci", "dx"], "§22.3", "done")
T("AX-009", "P0", "End-to-end JWT smoke (exit criterion)",
  "Prove identity flows adapter → signed JWT → a protected backend route end-to-end.",
  ["`docker compose up` functional", "JWT minted and validated across a request", "P0 exit gate green"],
  ["AX-005", "AX-006", "AX-007"], "S", ["milestone"], "§29 P0", "done")
T("AX-010", "P0", "NATS JetStream provisioning",
  "Declare streams/subjects: inbound.messages, agent.events.*, orchestrator.commands, automation.lifecycle.",
  ["Streams created with retention/replay config", "replay verified", "consumer groups documented"],
  ["AX-005"], "S", ["infra", "bus"], "§8.2", "done")

# ─────────────────────────────────────────────────────────── P1 — Cœur vertical
T("AX-011", "P1", "backend-core REST+WS API",
  "FastAPI conversations/messages/stream/approve/cancel/me with idempotency and §8.3 replay protocol.",
  ["All /api/v1 routes per §8.2", "202 + Idempotency-Key semantics", "WS seq/last_seq replay, gap-free"],
  ["AX-002"], "L", ["backend-core"], "§8.2, §8.3", "done")
T("AX-012", "P1", "backend-core ↔ NATS + Postgres",
  "Replace in-memory store with asyncpg; publish inbound to bus and bridge AgentEvents back to WS.",
  ["Conversations/messages persisted", "inbound published to NATS", "events consumed and streamed"],
  ["AX-011", "AX-010", "AX-004"], "L", ["backend-core", "db", "bus"], "§8.2", "done")
T("AX-013", "P1", "prompt-layer (minimal)",
  "Stateless service: classify chat_simple vs task_agentique, pass-through routing, emit signed AgentTask.",
  ["Classification <300ms via eco model", "AgentTask + TASK JWT emitted", "scheduler channel same pipeline"],
  ["AX-007", "AX-006"], "L", ["prompt-layer"], "§9, §9.2, §9.5", "done")
T("AX-014", "P1", "orchestrator sandbox lifecycle (Go)",
  "Go service: sandbox state machine (create/warm/active/hibernate/kill), gRPC API, turn dispatch.",
  ["State machine per §10.1", "gRPC create/dispatch/cancel", "leader election stub"],
  ["AX-010"], "XL", ["orchestrator"], "§10", "done")
T("AX-015", "P1", "Hardened sandbox image",
  "OpenCode Docker image: rootless, gVisor RuntimeClass, no egress except MCP Gateway + llm-proxy.",
  ["Non-root user", "egress locked to gateway/proxy", "gVisor runtime verified"],
  ["AX-001"], "L", ["sandbox", "security"], "§11.1, §11.2, ADR 002", "done")
T("AX-016", "P1", "OpenCode agent + profiles",
  "Run OpenCode in server mode inside the sandbox; load dev/data/ops/generalist profiles; MCP client.",
  ["Agent answers a turn", "profiles switch tools/model", "events stream to orchestrator"],
  ["AX-015", "AX-014"], "L", ["sandbox", "agent"], "§12, ADR 009", "done")
T("AX-017", "P1", "MCP Gateway core",
  "Single AuthZ/secret-injection/DLP/audit point: verify TASK JWT, tool routing, audit each call.",
  ["TASK JWT verified (allowed_tools)", "tool call → server routed", "every call in audit_log"],
  ["AX-006"], "XL", ["mcp-gateway", "security"], "§13.1, ADR 001", "done")
T("AX-018", "P1", "GitHub MCP server",
  "Code search/read, branches, commits, PRs, issues, merge (approval-gated).",
  ["Read + create PR works", "merge behind require_approval", "Co-authored-by/Requested-by on commits"],
  ["AX-017"], "L", ["mcp-server", "github"], "§14", "done")
T("AX-019", "P1", "Web app chat (streaming)",
  "React chat mapping AgentEvent → UI (deltas, tool lines, approval cards, done/cost); WS token streaming.",
  ["Token-by-token streaming", "AgentEvent contract rendered per §4.3", "reconnect resumes via last_seq"],
  ["AX-011"], "L", ["web"], "§4.3, §7.3", "done")
T("AX-020", "P1", "llm-proxy (minimal)",
  "LiteLLM config with a single frontier + eco model, budget headers, request logging.",
  ["Proxy routes to model", "usage/cost captured", "timeout+retry configured"],
  ["AX-001"], "M", ["llm-proxy"], "§9.5, Annexe H", "done")
T("AX-021", "P1", "Persistent workspace volume",
  "Per-user /workspace volume with .agent/ notes; survives sandbox kill/restart.",
  ["Volume persists across restarts", "notes readable next session", "sandbox table tracks volume_id"],
  ["AX-014"], "M", ["sandbox", "storage"], "§11.3, §4 (Principle 4)", "done")
T("AX-022", "P1", "P1 demo: GitHub task from web (exit criterion)",
  "End-to-end: web message → sandbox → GitHub MCP task with live streaming.",
  ["Full GitHub task from web", "streaming visible", "P1 exit gate green"],
  ["AX-012", "AX-013", "AX-016", "AX-018", "AX-019", "AX-020"], "M", ["milestone"], "§29 P1", "done")

# ─────────────────────────────────────────────────────────── P2 — Multi-canal
T("AX-023", "P2", "Teams adapter",
  "Bot Framework SDK v4: normalize activities → InboundMessage, SSO token exchange, Adaptive Cards, proactive.",
  ["Mention/DM handled", "SSO account linking", "proactive run result delivered"],
  ["AX-011"], "L", ["teams"], "§7.1", "done")
T("AX-024", "P2", "Teams webhook JWT validation",
  "Validate Bot Framework JWT on every activity (aud/iss, 5-min clock skew), fail-closed.",
  ["Valid activity accepted", "forged/expired rejected", "OpenID metadata cached"],
  ["AX-023"], "S", ["teams", "security"], "§7.1", "done")
T("AX-025", "P2", "Slack adapter",
  "Bolt app: <3s ACK + 👀 reaction, InboundMessage publish, Block Kit cards, slash commands.",
  ["ACK <3s then async", "Block Kit approval cards", "/agent commands wired"],
  ["AX-011"], "L", ["slack"], "§7.2", "done")
T("AX-026", "P2", "Slack signature verify + retry dedup",
  "HMAC signature check (5-min anti-replay) and dedup of Slack retries via event_id in Redis.",
  ["Bad signature rejected", "retries deduped", "replay window enforced"],
  ["AX-025"], "S", ["slack", "security"], "§7.2", "done")
T("AX-027", "P2", "Simple vs complex routing",
  "Fast classification path: chat_simple (no sandbox, eco LLM) vs task_agentique with milestones.",
  ["Simple mention answered without sandbox", "complex shows plan+milestones", "cost path per §25"],
  ["AX-013"], "M", ["prompt-layer", "routing"], "§7.2.1, §9.2", "done")
T("AX-028", "P2", "Mid-turn escalation",
  "chat_simple → task_agentique escalation emitting agent.escalated and waking the sandbox.",
  ["Escalation event emitted", "sandbox woken on demand", "UI shows 'looking in <tool>'"],
  ["AX-027", "AX-014"], "M", ["prompt-layer"], "§7.2.1", "done")
T("AX-029", "P2", "Account linking for unknown users",
  "Unlinked mention → ephemeral OIDC linking prompt; no processing before linkage.",
  ["Unknown user gets link", "no action pre-link", "identity persisted after link"],
  ["AX-006"], "M", ["auth"], "§7.2, §7.1", "done")
T("AX-030", "P2", "Proactive notifications",
  "Store conversationReference (Teams) / channel refs; deliver async/long-task and scheduled results.",
  ["Proactive message sent", "long-task '@user' ping on completion", "refs persisted"],
  ["AX-023", "AX-025"], "M", ["teams", "slack"], "§7.1, §7.2", "done")
T("AX-031", "P2", "P2 exit: same task from Teams & Slack",
  "Run the P1 task identically from Teams and Slack.",
  ["Task works from Teams", "task works from Slack", "P2 exit gate green"],
  ["AX-023", "AX-025", "AX-027"], "S", ["milestone"], "§29 P2", "done")

# ─────────────────────────────────────────────────────────── P3 — Contrôle
T("AX-032", "P3", "Permissions engine (RBAC+ABAC)",
  "tool_policies matrix (org,role,tool_pattern)→allow/deny/require_approval; compute allowed_tools per turn.",
  ["Policy lookup fail-closed", "allowed_tools signed into TASK JWT", "gateway re-verifies (defense in depth)"],
  ["AX-017"], "L", ["permissions", "security"], "§9.4", "done")
T("AX-033", "P3", "Human approval flow (HITL)",
  "require_approval suspends the tool call, emits approval.needed, resolves via approve endpoint/card.",
  ["Approve/deny resolves call", "pending stored in Redis with timeout", "decision audited"],
  ["AX-032"], "L", ["approvals"], "§13.3", "done")
T("AX-034", "P3", "Designated approvers (team mode)",
  "approver_group routing: card goes to the group, not the requester; both parties logged.",
  ["Group receives card", "requester≠approver enforced where set", "audit records both"],
  ["AX-033"], "M", ["approvals"], "§3.3", "done")
T("AX-035", "P3", "Input guardrails",
  "Prompt-injection classifier + attachment heuristics, PII scope filter, org content policy; fail-closed.",
  ["Injection corpus blocked", "PII policy enforced", "blocked → E_GUARD_INPUT_BLOCKED"],
  ["AX-013"], "L", ["guardrails", "security"], "§9.3", "done")
T("AX-036", "P3", "Output guardrails / DLP",
  "Scan responses + generated files for secrets (regex + gitleaks lib); mask/refuse on policy violation.",
  ["Secret patterns masked", "gitleaks on generated files", "memory.save honors DLP"],
  ["AX-017"], "M", ["guardrails", "dlp", "security"], "§9.3, §13.5", "done")
T("AX-037", "P3", "Vault + encrypted OAuth token store",
  "Vault integration; oauth_tokens encrypted AES-256-GCM with Vault key; injection only at gateway.",
  ["Tokens never leave gateway", "at-rest encryption", "zero secrets in sandbox verified"],
  ["AX-017"], "L", ["security", "vault"], "§13.2, §16.1, ADR 001", "done")
T("AX-038", "P3", "OAuth connect flows + refresh sweep",
  "GitHub/Notion OAuth start/callback; Trigger.dev oauth-refresh-sweep job with Redis locks.",
  ["Connect + callback stores token", "refresh before expiry", "revocation handled"],
  ["AX-037"], "M", ["oauth"], "§13.2, §8.2", "done")
T("AX-039", "P3", "Audit log (append-only, partitioned)",
  "Write audit rows for every tool call/cron/admin action; monthly partitions; WORM export to S3.",
  ["Every sensitive action logged (who/what/when/result)", "monthly partition job", "export produces WORM file"],
  ["AX-017"], "M", ["audit", "compliance"], "§16.1, §16.3", "done")
T("AX-040", "P3", "Admin console v1",
  "Backoffice: orgs, users, tool_policies editor, budgets, audit viewer; SSO+MFA, view-as (read-only).",
  ["CRUD orgs/policies/budgets", "audit searchable/exportable", "every admin action audited"],
  ["AX-039", "AX-032"], "L", ["admin", "web"], "§24.1, §24.2", "done")
T("AX-041", "P3", "P3 exit: approvals + audit demonstrated",
  "Show a require_approval decision and export the audit trail.",
  ["require_approval demoed", "audit exportable", "P3 exit gate green"],
  ["AX-033", "AX-039", "AX-040"], "S", ["milestone"], "§29 P3", "done")

# ─────────────────────────────────────────────────────────── P4 — Intelligence
T("AX-042", "P4", "Working memory (Redis)",
  "30-turn window + rolling summary (TTL 7d, re-summary every 15 turns).",
  ["Window persisted per conversation", "summary regenerated", "TTL enforced"],
  ["AX-012"], "M", ["memory"], "§9.1 (type 1)", "done")
T("AX-043", "P4", "Semantic memory (pgvector) + extraction",
  "Durable facts in pgvector with dedup (cosine>0.92); async memory-extraction job.",
  ["Facts embedded + stored", "dedup enforced", "extraction job runs async"],
  ["AX-012"], "L", ["memory"], "§9.1 (type 2)", "done")
T("AX-044", "P4", "Memory MCP (save/search/update/forget)",
  "Audited memory tool behind the gateway; versioned update; user self-serve forget.",
  ["4 ops work", "writes audited (args_hash)", "forget purges + audits"],
  ["AX-043", "AX-017"], "M", ["memory", "mcp-server"], "§9.1.1", "done")
T("AX-045", "P4", "Procedural notes in workspace",
  "NOTES.md + per-project notes as the learned how-to; injected as <procedural_notes>.",
  ["Notes read/written by agent", "injected into context", "compaction >2000 lines"],
  ["AX-021"], "M", ["memory"], "§9.1 (type 3)", "done")
T("AX-046", "P4", "Corrections memory",
  "Capture explicit corrections/thumbs-down/repeated approval refusals with reinforced weight.",
  ["Corrections stored kind=correction", "weight bonus in ranking", "3-refusal pattern learned"],
  ["AX-043"], "M", ["memory"], "§9.1 (type 4)", "done")
T("AX-047", "P4", "Hybrid retrieval ranking",
  "top-k=8 hybrid score (cosine+recency+frequency, correction bonus), threshold 0.55, expires_at purge.",
  ["Ranking formula implemented", "expired facts purged", "3-section context injection"],
  ["AX-043", "AX-046"], "M", ["memory"], "§9.1", "done")
T("AX-048", "P4", "Planning (plan decomposition)",
  "Decompose task_agentique into a 3-7 step plan; detect automation intent; drive progress UI.",
  ["3-7 step plan produced", "automation intent detected", "budget estimate emitted"],
  ["AX-013"], "M", ["prompt-layer", "planning"], "§9.2", "done")
T("AX-049", "P4", "Multi-model routing + fallback",
  "llm-proxy routes eco/frontier by role, org-configurable, auto-fallback on quota/incident.",
  ["Role-based routing", "fallback on failure", "per-model usage tracked"],
  ["AX-020"], "M", ["llm-proxy", "routing"], "§9.5, Annexe H", "done")
T("AX-050", "P4", "Budgets + kill-switch",
  "Per-turn/per-run/per-month/per-org budgets with enforcement and an org kill-switch.",
  ["Budgets enforced at each level", "kill-switch halts spend", "usage_daily by origin"],
  ["AX-049"], "L", ["budgets", "cost"], "§10.2, §15.6, §25", "done")
T("AX-051", "P4", "Prompt-cache context structure",
  "Structure the LLM context for prompt caching; report cache hit rate.",
  ["Stable prefix for caching", "hit rate measured", "cost drop visible"],
  ["AX-049"], "M", ["llm-proxy", "cost"], "§9.6", "done")
T("AX-052", "P4", "Agent profile selection",
  "Select OpenCode profile by classification + user preference (dev/data/ops/generalist).",
  ["Profile chosen automatically", "user override respected", "job can pin a profile"],
  ["AX-016", "AX-048"], "S", ["agent", "prompt-layer"], "§9.5", "done")
T("AX-053", "P4", "Memory UI + hygiene guards",
  "Memories page (view/edit/delete by type) + write-forbidden guards (secrets, sensitive, third-party facts).",
  ["Memories page live", "adversarial hygiene tests pass", "user-erasure wired"],
  ["AX-044", "AX-040"], "M", ["memory", "web", "privacy"], "§9.1.3, §4.4", "done")
T("AX-054", "P4", "P4 exit: personalization + cost tracking",
  "Show personalization influencing answers and per-org cost tracking.",
  ["Personalization visible", "costs tracked per org", "P4 exit gate green"],
  ["AX-047", "AX-050"], "S", ["milestone"], "§29 P4", "done")

# ─────────────────────────────────────────────────────────── P5 — Automatisations
T("AX-055", "P5", "automation-service jobs API",
  "TypeScript service owning scheduled_jobs: create/update/pause/resume/delete/resync.",
  ["CRUD + resync endpoints", "scheduled_jobs is source of truth", "idempotent create (dedup key)"],
  ["AX-004"], "L", ["automation"], "§15.2, §8.2", "done")
T("AX-056", "P5", "Trigger.dev self-hosted",
  "Deploy Trigger.dev v4 (webapp/supervisor/workers/datastores); DEV/STAGING/PROD envs isolated.",
  ["Trigger.dev up self-hosted", "envs isolated", "dashboard reachable"],
  ["AX-055"], "L", ["automation", "infra"], "§15, §22.1, ADR 004", "done")
T("AX-057", "P5", "Pivot task (agent-scheduled-run)",
  "The one durable task that fires a cron and re-injects an InboundMessage into /internal/scheduled-runs.",
  ["Cron re-enters standard pipeline", "idempotency key per fire", "retries durable"],
  ["AX-056", "AX-012"], "L", ["automation"], "§15.3, ADR 005", "done")
T("AX-058", "P5", "Scheduler MCP façade",
  "MCP tools create_cron/list_crons/pause/run_now over automation-service; policy-gated.",
  ["Tools callable by agent", "create_cron require_approval default", "list_crons allow"],
  ["AX-055", "AX-017"], "M", ["mcp-server", "automation"], "§14.1, §15", "done")
T("AX-059", "P5", "Cron creation flow + approval",
  "NL intent → proposed cron → user confirmation → active; immutable versioned prompt.",
  ["Draft→pending→active lifecycle", "prompt immutable/versioned", "agent.cron.created emitted"],
  ["AX-058", "AX-033"], "M", ["automation", "approvals"], "§15.4, §9.2", "done")
T("AX-060", "P5", "Fire-time permissions preflight",
  "Re-evaluate perms/guardrails/budgets at each run; degrade/pause on revocation (E_PERM_REVOKED).",
  ["Perms re-checked per run", "revoked user → job paused + notified", "never escalates"],
  ["AX-057", "AX-032"], "L", ["automation", "security"], "§9.4, §15.6, ADR 006", "done")
T("AX-061", "P5", "Job lifecycle state machine",
  "draft/pending_approval/active/paused/deleted with 3-failure auto-pause and resume re-checks.",
  ["State transitions enforced", "auto-pause on 3 failures", "resume re-verifies quotas/policy"],
  ["AX-059"], "M", ["automation"], "§15.4", "done")
T("AX-062", "P5", "Delivery & notifications",
  "Deliver run results to DM/email/webhook; anti-noise digests; no-op suppression.",
  ["3 delivery channels", "digest batching", "no-op runs suppressed"],
  ["AX-057"], "M", ["automation", "notifications"], "§15.5", "done")
T("AX-063", "P5", "job_memory between runs",
  "Persist per-job state (dedup already-alerted, no_op markers) in scheduled_jobs.job_memory.",
  ["State persists across runs", "duplicate alerts suppressed", "bounded size"],
  ["AX-057"], "S", ["automation", "memory"], "§9.1, §15", "done")
T("AX-064", "P5", "Automations UI page",
  "User page: list crons (human schedule, next run, run history+cost), pause/resume/edit/delete.",
  ["Crons listed with next run", "pause/resume/edit works", "run history + cost shown"],
  ["AX-055", "AX-019"], "M", ["web", "automation"], "§4.4, §7.3", "done")
T("AX-065", "P5", "Internal platform jobs",
  "Migrate consolidation jobs to Trigger.dev: memory-consolidation, oauth-refresh-sweep, partition roll, user-erasure.",
  ["4 internal jobs scheduled", "declarative schedules deploy", "runs observable"],
  ["AX-056"], "M", ["automation", "platform"], "§9.1.3, §15.7", "done")
T("AX-066", "P5", "Event-driven automations (webhooks)",
  "Inbound webhooks trigger automations (Sentry/GitHub events) into the same pipeline.",
  ["Webhook → automation run", "signature verified", "same guardrails/audit"],
  ["AX-057"], "M", ["automation"], "§15.8", "done")
T("AX-067", "P5", "P5 exit: fire-time perms proven",
  "Demo §18.2 + §18.3 end-to-end; revoke a right and show the job pauses.",
  ["Cron create+run demoed", "revocation test pauses job", "P5 exit gate green"],
  ["AX-060", "AX-062"], "S", ["milestone", "security"], "§29 P5", "done")

# ─────────────────────────────────────────────────────────── P6 — Étendue MCP
T("AX-068", "P6", "M365 MCP (Graph delegated)",
  "Outlook/Teams/Calendar/SharePoint via MS Graph, delegated (OBO); read/search/summarize/send (approval).",
  ["Read + summarize mail", "send behind approval", "delegated scopes only"],
  ["AX-017", "AX-038"], "L", ["mcp-server", "m365"], "§14", "done")
T("AX-069", "P6", "Browser MCP (hardened Playwright pool)",
  "Headless Playwright pool: read/click/fill/download/capture; sandboxed, resource-capped.",
  ["Page read + structured extract", "downloads to S3", "pool autoscales, capped"],
  ["AX-017"], "L", ["mcp-server", "browser"], "§14", "done")
T("AX-070", "P6", "Database MCP (capped SELECT)",
  "Schema introspection + capped read-only SELECTs + internal APIs; write behind deny/approval.",
  ["Schema listed", "SELECT row/time capped", "writes denied for member"],
  ["AX-017"], "M", ["mcp-server", "database"], "§14", "done")
T("AX-071", "P6", "Notion MCP",
  "Create/read minutes, specs, wikis in Notion.",
  ["Page create/read", "search works", "approval on writes where policy"],
  ["AX-017", "AX-038"], "M", ["mcp-server", "notion"], "§14", "done")
T("AX-072", "P6", "Slack MCP",
  "Read channels and post recaps (distinct from the inbound Slack adapter).",
  ["Read channel history", "post recap", "scoped to bot token"],
  ["AX-017"], "M", ["mcp-server", "slack"], "§14", "done")
T("AX-073", "P6", "Connector onboarding process",
  "Industrialized checklist/template to add a connector (scopes, policies, tests, docs).",
  ["Template + checklist", "new connector in <X days", "policy+eval coverage required"],
  ["AX-068"], "S", ["mcp-server", "dx"], "§14.3", "done")
T("AX-074", "P6", "P6 exit: 7 connectors in internal prod",
  "GitHub+M365+Browser+DB+Notion+Slack+Scheduler live internally.",
  ["7 connectors operational", "internal dogfood passing", "P6 exit gate green"],
  ["AX-068", "AX-069", "AX-070", "AX-071", "AX-072"], "S", ["milestone"], "§29 P6", "done")

# ─────────────────────────────────────────────────────────── P7 — Prod-ready
T("AX-075", "P7", "K8s topology + gVisor",
  "Namespaces per §22.1, dedicated tainted sandbox node pool, gVisor RuntimeClass.",
  ["Namespaces deployed", "sandbox pool isolated", "gVisor enforced"],
  ["AX-015"], "L", ["infra", "k8s"], "§22.1", "done")
T("AX-076", "P7", "Sandbox NetworkPolicy lockdown",
  "Egress only to mcp-gateway:8443 + llm-proxy:4000 + kube-dns; ingress only from orchestrator.",
  ["Policy applied", "external egress blocked (test)", "principle #2 verified"],
  ["AX-075"], "M", ["infra", "security"], "§17.4, §22.3", "done")
T("AX-077", "P7", "Terraform IaC",
  "VPC, cluster, KMS, S3, DNS as code.",
  ["`terraform apply` provisions base", "state remote+locked", "reviewed plan in CI"],
  ["AX-075"], "L", ["infra", "terraform"], "§22.1", "done")
T("AX-078", "P7", "Helm charts per service",
  "Chart per service + values per env; Trigger.dev official chart wired.",
  ["Charts render", "env values separated", "resource requests/limits set"],
  ["AX-075"], "L", ["infra", "helm"], "§22.1", "done")
T("AX-079", "P7", "ArgoCD GitOps",
  "App-of-apps; auto-sync staging, manual-approval prod, canary 10% on backend-core.",
  ["Staging auto-syncs", "prod gated", "canary + rollback wired"],
  ["AX-078"], "M", ["infra", "gitops"], "§22.1, §22.3", "done")
T("AX-080", "P7", "Full CI/CD (evals gate, supply chain)",
  "Extend CI: evals gate, image build+SBOM(syft)+cosign, Trivy(CRITICAL=STOP), Atlas migration lint.",
  ["Evals gate blocks >3% regression", "signed images + SBOM", "Trivy/gitleaks blocking"],
  ["AX-008", "AX-083"], "L", ["ci", "security"], "§22.3", "done")
T("AX-081", "P7", "Observability stack",
  "OTel traces + Prometheus + Grafana + Loki + Tempo; dashboards per service.",
  ["Traces end-to-end", "logs+metrics shipped", "service dashboards live"],
  ["AX-007"], "L", ["observability"], "§19", "done")
T("AX-082", "P7", "SLO dashboards + bi-level alerting",
  "SLOs (Annexe A): first-token P95, cron failure rate, cron delay, error-budget burn; multi-window multi-burn alerts.",
  ["SLO dashboards live", "burn-rate alerts fire", "paging vs ticket tiers"],
  ["AX-081"], "M", ["observability", "sre"], "§19, §24.6, Annexe A", "done")
T("AX-083", "P7", "Agent evals (golden + adversarial)",
  "150 golden tasks + 20 cron scenarios + injection corpus; run as CI gate.",
  ["Golden set runs in CI", "adversarial corpus enforced", "regression threshold wired"],
  ["AX-035"], "L", ["evals", "quality"], "§20.2", "done")
T("AX-084", "P7", "Warm pool + hibernation",
  "Warm sandbox pool + aggressive hibernation to hit the cost model.",
  ["Warm pool serves cold-starts", "idle sandboxes hibernate", "cost per §25 met"],
  ["AX-014"], "M", ["orchestrator", "cost"], "§10.1, §23, §25", "done")
T("AX-085", "P7", "HA topology",
  "Postgres primary+replicas failover, NATS 3-node cluster, orchestrator leader election, multi-AZ.",
  ["Failover tested", "NATS quorum", "leader election verified"],
  ["AX-075"], "L", ["infra", "ha"], "§23", "done")
T("AX-086", "P7", "DR: backups + resync",
  "WAL archiving+snapshots+Trigger.dev dumps (RPO 15m/RTO 1h); resync-schedules script.",
  ["Restore drill meets RPO/RTO", "resync-schedules rebuilds crons idempotently", "runbook written"],
  ["AX-085"], "M", ["infra", "dr"], "§23", "done")
T("AX-087", "P7", "Load tests",
  "500 active sandboxes + 1000 crons/h; verify autoscaling and jitter smoothing.",
  ["Load target sustained", "autoscaling holds SLO", "cron spikes smoothed"],
  ["AX-084", "AX-079"], "M", ["performance"], "§23", "done")
T("AX-088", "P7", "Pentest + incident response",
  "External pentest; breach/incident-response runbook; remediation tracked.",
  ["Pentest findings triaged", "IR runbook exercised", "criticals closed"],
  ["AX-076", "AX-037"], "L", ["security"], "§17.2, §17.5", "done")
T("AX-089", "P7", "Admin console complete + platctl + runbooks",
  "Full console, platctl CLI, runbooks; solo-ops rituals.",
  ["Console covers §24.2 screens", "platctl operational", "runbooks published"],
  ["AX-040"], "L", ["admin", "ops"], "§24", "done")
T("AX-090", "P7", "org-platform dogfooding",
  "Run the platform team on its own org (§24.8) as living QA.",
  ["org-platform active", "team uses agent daily", "issues fed back"],
  ["AX-089"], "S", ["ops", "quality"], "§24.8", "done")
T("AX-091", "P7", "P7 exit: SLOs met, 99.9%",
  "All SLOs (Annexe A) sustained; availability target proven.",
  ["SLOs green over window", "99.9% availability", "go-live checklist (Annexe D) complete"],
  ["AX-082", "AX-086", "AX-087", "AX-088"], "M", ["milestone"], "§29 P7", "in_progress")

# ─────────────────────────────────────────────────────────── PX — Cross-cutting
T("AX-092", "PX", "Localization fr/en/ar",
  "Localize agent replies, approval cards, notifications, error taxonomy; RTL for Arabic.",
  ["3 locales at launch", "cards/errors localized", "RTL rendering correct"],
  ["AX-003"], "M", ["i18n", "product"], "§7, §7.4", "done")
T("AX-093", "PX", "Pricing & packaging",
  "Define plans/seats/quotas, TND billing with local VAT, usage split interactive vs scheduled.",
  ["Plans defined", "billing page (TND/VAT)", "usage_daily.origin drives invoices"],
  [], "M", ["business", "billing"], "§30, §4.4", "done")
T("AX-094", "PX", "Legal: ToS, DPA, liability",
  "Terms, data processing agreement, liability model, sub-processor list.",
  ["ToS + DPA published", "sub-processors listed", "liability reviewed by counsel"],
  [], "M", ["business", "legal"], "§30", "done")
T("AX-095", "PX", "Support & SLA",
  "Contractual support tiers and SLAs; escalation paths.",
  ["SLA tiers documented", "support workflow live", "status page"],
  [], "S", ["business", "support"], "§30", "done")
T("AX-096", "PX", "Org onboarding flow",
  "Self-serve/assisted org onboarding: identity linking, connectors, policies, budgets.",
  ["Org can be onboarded in a day", "admin connectors page", "policy defaults seeded"],
  ["AX-040"], "M", ["product", "onboarding"], "§3.5, §30", "done")
T("AX-097", "PX", "RGPD user-erasure",
  "Erasure job purging memories/entities/entity_facts/workspace notes; UI trigger.",
  ["Erasure job complete + audited", "UI zone wired", "verifiable purge"],
  ["AX-065", "AX-053"], "M", ["privacy", "compliance"], "§4.4, §15.7", "done")
T("AX-098", "PX", "At-rest volume encryption",
  "Encrypt sandbox volumes at rest.",
  ["Volumes encrypted", "keys managed (KMS/Vault)", "verified on new volume"],
  ["AX-021"], "S", ["security"], "§17", "done")
T("AX-099", "PX", "Attachment antivirus",
  "Scan inbound attachments before storage/use.",
  ["AV scan on upload", "infected rejected + logged", "scan latency acceptable"],
  ["AX-011"], "S", ["security"], "§17", "done")
T("AX-100", "PX", "Breach response plan",
  "Documented breach detection→containment→notification with regulatory timelines.",
  ["Plan documented + owned", "tabletop exercised", "notification templates ready"],
  ["AX-088"], "S", ["security", "compliance"], "§17.5", "done")
T("AX-101", "PX", "Prompt registry + feedback→evals loop",
  "Registry of system prompts + a feedback loop feeding the eval corpus.",
  ["Prompts versioned in registry", "thumbs feed evals", "regressions caught"],
  ["AX-083"], "M", ["quality", "prompt-layer"], "§20", "done")
T("AX-102", "PX", "Team mode (Mode B) configuration",
  "Shared org-agent: GitHub App token, service DB, on_behalf_of authz, org memory, no personal connectors.",
  ["on_behalf_of enforced in authz", "org-scoped Vault entry", "personal connectors disabled"],
  ["AX-032", "AX-037"], "L", ["product", "security"], "§3", "done")


# ─────────────────────────────────────────────────────────── rendering
def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


STATUS_MARK = {"done": "✅", "in_progress": "🚧", "todo": "⬜"}


def render() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    by_phase: dict[str, list[dict]] = {p[0]: [] for p in PHASES}
    for t in _T:
        by_phase[t["phase"]].append(t)

    # tickets.json
    (OUT / "tickets.json").write_text(json.dumps(_T, ensure_ascii=False, indent=2), "utf-8")

    # per-phase markdown
    for code, name, desc, dur in PHASES:
        rows = by_phase[code]
        lines = [f"# {code} — {name}", "", f"> {desc}  ·  _{dur}_  ·  {len(rows)} tickets", ""]
        for t in rows:
            star = " ⭐M0" if t["wedge"] else ""
            lines += [
                f"## {STATUS_MARK[t['status']]} {t['id']} — {t['title']}{star}",
                "",
                f"{t['description']}",
                "",
                f"- **Estimate:** {t['estimate']}  ·  **Labels:** {', '.join(t['labels'])}  ·  **Spec:** {t['spec']}",
                f"- **Depends on:** {', '.join(t['deps']) if t['deps'] else '—'}",
                "- **Acceptance:**",
            ]
            lines += [f"  - [ ] {a}" for a in t["acceptance"]]
            lines.append("")
        (OUT / f"phase-{code.lower()}-{slug(name)}.md").write_text("\n".join(lines), "utf-8")

    # M0-pilot wedge view (build order = topological by deps, then id)
    wedge = [t for t in _T if t["wedge"]]
    order = {t["id"]: i for i, t in enumerate(_T)}
    wedge_ids = {t["id"] for t in wedge}
    def _rank(t):
        # deps within the wedge come first
        internal_deps = [d for d in t["deps"] if d in wedge_ids]
        return (len(internal_deps), t["id"])
    wedge_sorted = sorted(wedge, key=_rank)
    wl = [
        "# M0 — Pilot #1 Wedge",
        "",
        "> Governance-first thin slice from the CEO review (`/plan-ceo-review`, 2026-07-13, "
        "mode: Scope Reduction). The smallest slice that closes a regulated-buyer pilot: "
        f"**{len(wedge)} tickets** vs {len(_T)} total. Build these first; everything else waits "
        "for a signed design partner to pull it.",
        "",
        "**The demo this ships:** Mode B team agent on Slack → GitHub action → approval card → "
        "audit-log export → **revoke a right, the cron pauses at fire time** (§18.3, AX-067). "
        "That last beat is the moat — hold it to maximum rigor.",
        "",
        "**Deferred (not in M0):** Mode A personal agents · most of P4 Intelligence · other "
        "connectors (M365/Browser/DB/Notion) · P7 prod-hardening (K8s, full gVisor, GitOps, "
        "observability, evals, HA/DR, load, pentest). Flag: a tier-1 bank POC touching real data "
        "will require pentest + at-rest encryption (AX-088/098) before go-live — write that gate "
        "into the pilot SOW.",
        "",
        "| # | Ticket | Title | Est | Status | Phase |",
        "|---|---|---|---|---|---|",
    ]
    for i, t in enumerate(wedge_sorted, 1):
        wl.append(f"| {i} | {t['id']} | {t['title']} | {t['estimate']} | "
                  f"{STATUS_MARK[t['status']]} | {t['phase']} |")
    wl += [
        "",
        "## Parallel non-engineering track (start M1)",
        "- **Payment rail (§G):** line up a local Bedrock/Foundry reseller (LinSoft/SPG). The "
        "CTI 10k TND/yr cap breaks by M5-M6; llm-proxy routing makes the switch a config line, "
        "but the reseller relationship takes weeks. This can silently halt the LLM — start now.",
        "- **Pipeline (§F.3):** 3 POC proposals out + 2 export conversations by M3, or the "
        "cash trajectory is mechanically 'prudent'. Cede on price, never on signature date.",
    ]
    (OUT / "m0-pilot-wedge.md").write_text("\n".join(wl) + "\n", "utf-8")

    # board README
    total = len(_T)
    done = sum(1 for t in _T if t["status"] == "done")
    prog = sum(1 for t in _T if t["status"] == "in_progress")
    n_wedge = len(wedge)
    b = [
        "# Axone — Product Backlog",
        "",
        f"> Auto-generated by `tools/backlog.py` — do not edit by hand. {total} tickets across "
        f"{len(PHASES)} epics. Regenerate: `python3 tools/backlog.py`.",
        "",
        f"**Progress:** {done} done · {prog} in progress · {total - done - prog} todo.",
        "",
        f"### ▶ Start here: [M0 — Pilot #1 Wedge](m0-pilot-wedge.md) ({n_wedge} tickets)",
        "The governance-first thin slice from the CEO review (`/plan-ceo-review`). Build these "
        "before working the phases top-to-bottom — reading P0→P7 in order is the cathedral trap. "
        "Everything else waits for a signed pilot to pull it.",
        "",
        "Every ticket traces to `instructions.md`. Semantic search: `make search Q=\"…\"`; "
        "structural map: `docs/blueprint-index.md`.",
        "",
        "| Epic | Focus | Duration | Tickets | Status |",
        "|---|---|---|---|---|",
    ]
    for code, name, desc, dur in PHASES:
        rows = by_phase[code]
        d = sum(1 for t in rows if t["status"] == "done")
        p = sum(1 for t in rows if t["status"] == "in_progress")
        st = f"{d}✅ {p}🚧 {len(rows)-d-p}⬜"
        b.append(f"| [{code} — {name}](phase-{code.lower()}-{slug(name)}.md) | {desc} | {dur} | {len(rows)} | {st} |")
    b += [
        "",
        "## Legend",
        "- **Status:** ✅ done · 🚧 in progress · ⬜ todo",
        "- **Estimate:** S ≈ 1-2d · M ≈ 3-5d · L ≈ 1-2wk · XL ≈ 2wk+",
        "- Milestone tickets (`labels: milestone`) are the phase exit-criteria gates from §29.",
        "",
        "## Critical path (phase exit gates)",
        "AX-009 → AX-022 → AX-031 → AX-041 → AX-054 → AX-067 → AX-074 → AX-091.",
        "",
        "## Seed GitHub issues",
        "`bash tools/seed_github_issues.sh` (needs `gh auth login` + a repo) creates labels, "
        "9 phase milestones and one issue per ticket from `tickets.json`.",
    ]
    (OUT / "README.md").write_text("\n".join(b) + "\n", "utf-8")

    # gh seed script
    seed = _gh_seed_script()
    (ROOT / "tools" / "seed_github_issues.sh").write_text(seed, "utf-8")

    print(f"Wrote {total} tickets → {OUT.relative_to(ROOT)}/ (+ tools/seed_github_issues.sh)")
    for code, name, *_ in PHASES:
        print(f"  {code} {name}: {len(by_phase[code])}")


def _gh_seed_script() -> str:
    return """#!/usr/bin/env bash
# Seed GitHub issues/labels/milestones from docs/backlog/tickets.json.
# Prereqs: `gh auth login`, run inside the target repo (a git remote must exist).
set -euo pipefail
cd "$(dirname "$0")/.."
JSON=docs/backlog/tickets.json
command -v gh >/dev/null || { echo "gh CLI required"; exit 1; }
command -v jq >/dev/null || { echo "jq required"; exit 1; }

echo "Creating labels..."
jq -r '.[].labels[]' "$JSON" | sort -u | while read -r l; do
  gh label create "$l" --force >/dev/null 2>&1 || true
done
for s in "phase:P0" "phase:P1" "phase:P2" "phase:P3" "phase:P4" "phase:P5" "phase:P6" "phase:P7" "phase:PX"; do
  gh label create "$s" --force >/dev/null 2>&1 || true
done

echo "Creating milestones (idempotent)..."
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
for p in P0 P1 P2 P3 P4 P5 P6 P7 PX; do
  gh api "repos/$REPO/milestones" -f title="$p" >/dev/null 2>&1 || true
done

echo "Creating issues..."
jq -c '.[]' "$JSON" | while read -r t; do
  id=$(echo "$t" | jq -r .id)
  title=$(echo "$t" | jq -r .title)
  phase=$(echo "$t" | jq -r .phase)
  body=$(echo "$t" | jq -r '
    "**" + .id + "** — " + .description + "\\n\\n" +
    "**Spec:** " + .spec + "  ·  **Estimate:** " + .estimate + "  ·  **Depends on:** " +
    (if (.deps|length)>0 then (.deps|join(", ")) else "—" end) + "\\n\\n" +
    "**Acceptance:**\\n" + ([.acceptance[] | "- [ ] " + .] | join("\\n"))')
  labels=$(echo "$t" | jq -r '.labels + ["phase:" + .phase] | join(",")')
  gh issue create --title "$id — $title" --body "$body" --label "$labels" --milestone "$phase" >/dev/null \
    && echo "  + $id"
done
echo "Done."
"""


if __name__ == "__main__":
    render()
