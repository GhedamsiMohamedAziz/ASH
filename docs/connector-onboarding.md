# Connector onboarding checklist

> Source: instructions.md §14.3 ("Outillage à créer une fois"). Use this checklist for every new
> MCP connector — N1 (remote officiel), N2 (open source self-hosted) or N3 (maison, forked from
> `services/mcp-servers/_template/`). Not every point applies to every level (see the per-point
> notes), but skipping one silently is how a connector ships without audit/DLP/limits coverage.

## Before you start

- **N3 only:** `cp -r services/mcp-servers/_template services/mcp-servers/<connector>`, rename
  `package.json`, and work every `TODO(connector)` comment in `src/` — see that directory's
  `README.md` for the file-by-file breakdown (backend interface, `StubBackend`, resilient HTTP
  client, pagination/truncation, OTel seam, streamable-HTTP bootstrap).
- **N1/N2:** confirm the vendor publishes a Streamable HTTP endpoint (SSE is deprecated per §14.2)
  before writing anything — most of this checklist becomes config, not code.

## The 9 points

### ① App OAuth + scopes minimaux
Register the OAuth app with the provider (or generate a scoped service/API token). Grant the
**minimum** scopes the connector's tools actually call — not the vendor's "recommended" bundle.
Record the scope list next to the connector's tool list (e.g. in its `README.md`) so a future
scope-creep review has a baseline to diff against.

### ② Entrée Vault
Store client id/secret (or the service token) in the Vault-backed credential store, never in
source or `.env` committed to git. The dev/test stand-in for this is
`services/mcp-gateway/src/vault.ts` (`InMemoryVault` + `CredentialResolver`, AES-256-GCM sealed
tokens, §13.2) — prod points the same interface at HashiCorp Vault's transit engine. Per-user
OAuth tokens land via `POST /v1/connect` (see `services/mcp-gateway/src/server.ts`); org/service
tokens are seeded with `resolver.storeOrg(...)`.

### ③ Config Gateway (catalogue, limites)
Declare the connector in the Gateway: base URL, tool-name prefix, per-call timeout, retry/breaker
limits (`services/mcp-servers/_template/src/http-client.ts`'s `ResilientHttpClient` is the
reusable piece — tune `retries`/`baseDelayMs`/`breaker.failureThreshold` to the provider's
documented rate limits). Register every tool via `McpGateway.register(name, handler, meta)`
(`services/mcp-gateway/src/gateway.ts`) — registration **throws** if `meta.ingestsUntrusted` /
`meta.egressClass` is missing (§17.6.2), so this step cannot be half-done.

### ④ tool_policies
Add default policy rows (`org_id`, `role`, `tool_pattern`, `effect`) so the connector's tools
resolve to `allow` / `require_approval` / `deny` per §14.2's table (e.g. reads allow, writes
require_approval) instead of falling through to the fail-closed default deny. Evaluated by
`services/prompt-layer/app/policy.py`'s `PolicyEngine` against the `tool_policies` table (§16.1).

### ⑤ NetworkPolicy si self-host (N2/N3)
For anything not a vendor-hosted remote: restrict inbound to the Gateway pod only, egress to the
real upstream + cluster DNS. Model it on `infra/helm/networkpolicy-sandbox.yaml` (the equivalent
lockdown for sandboxes, §17.4) — see `services/mcp-servers/_template/helm/TODO.md` for the
connector-side chart's current state (`Chart.yaml` + `values.yaml` only; a `templates/` manifest
is intentionally left as a TODO there until the platform's own Helm templates land).

### ⑥ Évals golden set
3-5 golden-set tasks that exercise the connector end to end (a real call per tool, StubBackend or
recorded fixtures for CI) — this is what actually proves the connector works, not just that it
compiles. Follow the pattern in `services/mcp-servers/github/test/github.test.ts` (unit tests
against `StubBackend`, then integration tests running the SAME calls through
`services/mcp-gateway/src/gateway.ts` so TASK JWT → allowed_tools → approval → audit is proven, not
assumed) — the connector-eval pyramid described in §20.2.

### ⑦ Dashboard Grafana (latence/erreurs)
Add the connector to the observability dashboards (§19): call latency (p50/p95), error rate by
`code` (the §21 taxonomy — `packages/errors/errors.json` is the shared source of truth for TS +
Python), and circuit-breaker state transitions. Every Gateway audit entry already carries
`{tool, status, latency}` (`services/mcp-gateway/src/gateway.ts`'s `AuditEntry`) — the dashboard
panel is a query over that, not new instrumentation.

### ⑧ Runbook connecteur
Write an incident runbook at `docs/runbooks/<NN>-<connector>-down.md`, following the existing
shape (`docs/runbooks/01-llm-provider-down.md`, `docs/runbooks/03-vault-sealed.md`): symptoms,
how to confirm it's this connector vs. the Gateway itself, mitigation (does `E_CONN_NEEDS_CONNECTION`
mean the user reconnects, or is the org-wide service token dead?), and rollback (disable the
connector's tools in `tool_policies` without a redeploy).

### ⑨ Annonce utilisateurs + doc d'usage
Update the connectors catalogue surfaced in the Web App (`/connections` — see
`services/backend-core/app/main.py`'s `_gateway_connections`/`GET /connections` handling) with the
new provider, its identity type (OAuth user / delegated / service token — §13.2/§14), and a short
usage doc for end users (what it can do, what still requires approval). Announce it wherever the
org's other connector launches were announced (Slack/Teams channel, changelog).

## Sign-off

A connector is onboarded when all 9 points above are checked AND:

- `npm test` (or `pytest`) is green for the connector's own package.
- The connector's tools are reachable through a live TASK JWT via the real Gateway
  (`POST /mcp` end to end — not just unit tests against the tool map directly).
- `docs/go-live-checklist.md`'s connector-relevant items are updated if this is a first-of-kind
  identity type or egress class for the org.
