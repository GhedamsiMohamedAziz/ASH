# MCP connector template

> **Status:** scaffold (instructions.md §14.3, N3 "à créer une fois") · not itself a deployed
> connector — copy this directory to bootstrap a new one.

A minimal, hardened MCP server so a new N3 ("maison") connector is ~80 lines of domain TypeScript
on top of shared, pre-hardened pieces:

- **`src/connector.ts`** — the domain interface (`ExampleBackend`), a `StubBackend` (offline,
  deterministic, keyless — the whole chain runs with no token/network) and `TemplateMcp.tools()`,
  the tool-name → handler map the Gateway/MCP server dispatches to. Exposes one working example
  tool, `example.read`, with pagination + 256 KB truncation already wired — not a stub to delete,
  a reference to copy the shape of.
- **`src/rest.ts`** — the real-backend counterpart (`RestBackend`), implementing the same
  `ExampleBackend` interface so swapping stub → real is a one-line change in `server.ts`. Maps
  every upstream failure to a `packages/errors` §21 taxonomy code.
- **`src/http-client.ts`** — `ResilientHttpClient`: exponential-backoff retries on 429/5xx, a
  circuit breaker, and a per-attempt timeout, generalized so a real connector's `rest.ts` just
  constructs one and calls `.request()` instead of raw `fetch`.
- **`src/pagination.ts`** — `paginate()` (cursor-as-offset) and `truncateJson()` (256 KB cap,
  drops trailing items and flags `truncated: true`).
- **`src/otel.ts`** — a no-op `Tracer`/`Span` seam (`getTracer()`/`setTracer()`); every tool call
  runs inside `getTracer().startSpan(...)`, so wiring real OTel later touches one function, no
  call sites.
- **`src/server.ts`** — the MCP streamable-HTTP bootstrap (JSON-RPC `initialize` /
  `tools/list` / `tools/call` / `ping` / `notifications/*`), mirroring
  `services/mcp-gateway/src/mcp.ts`'s framing so a connector deployed standalone speaks the exact
  protocol the Gateway/opencode expect. AuthN/AuthZ (TASK JWT, `allowed_tools`, approval, taint,
  DLP, audit) stay in the Gateway (§13) — this server owns schema validation, pagination,
  truncation, retries/breaker and tracing for its own tools.
- **`Dockerfile`** — mirrors `services/mcp-servers/github/Dockerfile`.
- **`helm/mcp-server-template/`** — chart skeleton (`Chart.yaml` + `values.yaml`); see
  `helm/TODO.md` for what's intentionally left for when the platform's real Helm templates land.

## Forking a new connector

1. `cp -r services/mcp-servers/_template services/mcp-servers/<connector>`
2. Rename `package.json`'s `name`, and follow every `TODO(connector)` comment in `src/`.
3. Work `docs/connector-onboarding.md`'s 9-point checklist end to end.
4. `npm test` — all green before wiring into the Gateway.

```bash
npm test    # node --test test/*.test.ts
```
