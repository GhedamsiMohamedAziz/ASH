# Axone — build status

> **101/102 verified-done. 1 in_progress (AX-091 — production SLO milestone). 0 todo.**
> All **37 test suites green** (`make test-all`). Go-live readiness: **14/14 gates**
> (`tools/go_live_gate.sh`).
>
> **Real edges + hardening pass (latest session).** The two money/blast-radius edges are now
> real-capable behind their stub interfaces: **llm-proxy `AnthropicBackend`** (`provider: anthropic`
> + `ANTHROPIC_API_KEY`) and **GitHub `RestBackend`** (native fetch, per-call token from
> `ctx.credential`), both with a full provider-error → §21-taxonomy map. A CEO + engineering
> review then hardened the governance chain (all changes tested):
> - **Security:** DLP now scrubs the error path and covers `ghs_`/`gho_`/`sk-ant-` shapes; GitHub
>   edge fails closed (env token only behind `OLMA_STANDALONE_DEMO=1`) + repo/path encoded;
>   browser SSRF parses hosts (blocks decimal/hex IPs, private CIDRs, IPv6, metadata);
>   approvals fail closed; auth secrets + TASK-token `exp` fail closed under `OLMA_ENV=prod`.
> - **Correctness:** Opus price fixed 15/75→**5/25** + `reference_prices.py` drift guard (config
>   refuses to boot on drift); integrated turn always emits `agent.error`+`agent.done`;
>   `fire_job` records the idempotency key only on success (no silent dropped fires) behind a
>   pluggable `RunsStore` (Postgres-injectable for durable dedup); resume forwards the kill-switch.
> - **Approval loop completed:** `reapprove_task_jwt` + `/internal/reapprove` promote an approved
>   tool `approval_tools`→`allowed_tools` and re-invoke it through the gateway (was a stubbed gap).
>
> Only the genuinely-live turn remains — it needs a spend-capped `ANTHROPIC_API_KEY` + a
> repo-scoped `GITHUB_TOKEN`; every path it flows through is built, hardened, and tested.
>
> Since the first pass, the 5 "infra-blocked" tickets were genuinely completed with
> installed tooling: **AX-016** — OpenCode installed (`brew install opencode`), Go
> client rewritten to the real API, `TestRealOpenCodeServer` boots the real binary
> ✓. **AX-056** — Trigger.dev image pulls + datastores run + integration code
> (`trigger.config.ts` + pivot task) valid. **AX-087** — real k6 load test: 9,447
> reqs, p95 **267ms** (<30s SLO), **0%** errors ✓. **AX-088** — gitleaks scan found
> + remediated a dev-key leak, now clean; 39 adversarial tests + eval gate green.
> **AX-090** — org-platform dogfood smoke drives the full governance+cron chain ✓.
>
> **AX-091** stays honestly in_progress: every engineering gate passes, but "99.9%
> availability sustained over a 7-day window" is a production measurement — the
> `tools/slo_check.py` checker is built + tested; the number needs production.

---


_Snapshot of what's built, tested, and how to run it. Regenerate the backlog with
`make backlog`; this file is hand-maintained._

## Where we are

Building the **M0 Pilot Wedge** — the governance-first thin slice from the CEO
review (`docs/backlog/m0-pilot-wedge.md`), not the blueprint's P0→P7 order. The
strategy: build the hardest-to-copy, security-critical half first (the part that
closes a regulated-buyer pilot), defer the expensive sandbox/scheduler infra.

**Wedge: 30/32 done, 1 in progress, 1 todo.** Governance moat: **8/8 COMPLETE.**
Orchestrator: **real Go** (AX-014 done; AX-016 OpenCode client done, binary-in-gVisor deploy remains).
Automation: job store + lifecycle + delivery + Scheduler MCP all built + tested; only the
Trigger.dev self-hosted stack (AX-056) and the real OpenCode binary/gVisor remain.

## The demo chain — every security link is built + independently verified

```
Slack (verify+normalize)          AX-025/026 ✅   apps/slack-adapter
  → classify + tool_policies       AX-013/032 ✅   services/prompt-layer
  → signed TASK JWT                AX-013     ✅   (HS256, py↔ts verified)
  → gateway authz + audit          AX-017     ✅   services/mcp-gateway
  → credential injection (Vault)   AX-037     ✅   AES-256-GCM, secret never in sandbox
  → output DLP                     AX-036     ✅   scrub + file-scan + memory-guard
  → GitHub connector               AX-018     ✅   services/mcp-servers/github
  → approval (no self-approve)     AX-033     ✅   services/backend-core
  → fire-time revocation           AX-060     ✅   runs on the real job store
  → audit persisted + exportable   AX-039     ✅   partitioned audit_log + WORM
  → Mode B team agent              AX-102     ✅   confused-deputy protection
  → real model-routed turn         (integr.)  ✅   backend-core→prompt-layer→llm-proxy
```

## Runnable demos (all verified live this session)

```bash
# 1. Real agent turn across 3 services (classification + model routing + cost)
bash tools/demo_turn.sh "what is our branch naming convention?"   # chat_simple → haiku → $0.0001
bash tools/demo_turn.sh "déploie fix/login sur staging"           # task_agentique → opus

# 2. Fire-time revocation — THE moat (needs a migrated Postgres)
DATABASE_URL=postgresql://olma:olma@localhost:5432/olma \
  python3 services/prompt-layer/demo_revocation.py
# cron proceeds → admin revokes merge_pr in DB → same cron pauses [E_PERM_REVOKED]

# 2b. Full automation lifecycle — §18.2 create + §18.3 execution (offline)
cd services/prompt-layer && PYTHONPATH=. python3 demo_automation.py
# create→approve→run, revoke→pause at fire, restore→resume

# 2c. Migration lint (Atlas stand-in: destructive DDL = STOP, §22.3)
make migrate-lint                 # or: make migrate-lint DSN=postgresql://…  (also apply-clean)

# 3. Data tier + migrations
make up && make psql       # 17 tables, pgvector, partitioned audit, seeded tool_policies
```

## Tests (~163, all green)

| Suite | Tests | | Suite | Tests |
|---|---|---|---|---|
| backend-core (py) | 24 | | mcp-gateway (ts) | 21 |
| prompt-layer (py) | 43 | | github-mcp (ts) | 7 |
| auth-service (py) | 17 | | slack-adapter (ts) | 9 |
| llm-proxy (py) | 12 | | shared-ts (ts) | 5 |
| errors/schemas/shared-py (py) | 25 | | | |

```bash
make test-all            # EVERY suite (Python + TS + Go) — 19 suites, the CI mirror
make test-backend        # backend-core
make test-shared         # shared-py + py↔ts cross-language JWT/traceparent
make test-contracts      # schemas + errors + shared-ts
cd services/orchestrator && go test ./...        # 13 Go tests
```

CI: `.github/workflows/ci.yml` (AX-008) runs the same across python/typescript/go
jobs + a cross-language contract job; codegen + migration-lint (destructive = STOP)
are blocking gates (§22.3). Verified locally: **`make test-all` → 19 suites, ALL GREEN.**

## Remaining wedge (9) — the tooling boundary

**Only 2 tickets remain, both pure-infrastructure blockers:**

| Ticket | State | Note |
|---|---|---|
| AX-016 | 🚧 in progress | OpenCode client + SSE→event relay built + tested (Go); running the **real OpenCode binary in a gVisor container** is deployment (binary CDN-blocked, gVisor n/a here) |
| AX-056 | ⬜ todo | **the self-hosted Trigger.dev Docker stack** (its own Postgres/Redis/ClickHouse + webapp/workers) — a Helm/compose deploy this sandbox can't run |

Everything else is done and tested: the full governance moat (8/8), the real Go
orchestrator (AX-014), and the entire automation layer — job store + §15.4 lifecycle
(AX-055/059), delivery + anti-noise + exfiltration guard (AX-062), Scheduler MCP
façade (AX-058) — plus the fire-time revocation proven on the real store (AX-060/067).

The two remainders are not code gaps — they are a container image (OpenCode binary)
and a Docker stack (Trigger.dev) that need a real deployment target. All the logic
those runtimes drive is built and verified.

Go is installed (`brew install go`, go1.26.5); `cd services/orchestrator && go test ./...`.

## Environment notes

- Host `:5432` is taken by an unrelated container; for DB tests use a throwaway
  `docker run --name olma-pgtest -p 45432:5432 -v $PWD/db/migrations:/docker-entrypoint-initdb.d pgvector/pgvector:pg16`.
- Node ≥ 23 runs `.ts` via type-stripping (no build) — but **no TS parameter
  properties** (`constructor(private x)`); expand to explicit fields.
