# packages/shared-py (AX-007)

Shared runtime helpers for the Python services (backend-core, prompt-layer,
auth-service). Stdlib-only by design; production backends (NATS, OpenTelemetry,
Redis) are optional extras plugged behind the same interfaces.

| Module | Role | Prod backend |
|---|---|---|
| `jwt` | HS256 sign/verify, fail-closed, `exp/nbf/iss/aud` checks, no `alg:none` bypass (§13.4). | RS256 + JWKS via auth-service (AX-006). |
| `idempotency` | `IdempotencyStore` protocol + `InMemoryStore` with TTL (§21, Principle #8). | Redis, 24h TTL (§16.2). |
| `bus` | `Bus` protocol + `InMemoryBus` (subject wildcards) + `DedupeGuard` for at-least-once (§8.2). | NATS JetStream (replay). |
| `telemetry` | W3C `traceparent` generate/parse/child (§8.1, §19). | OpenTelemetry SDK → Tempo. |

**Wire-compatible with `packages/shared-ts`** — JWT and traceparent formats are
verified identical across Python and TypeScript (see `make test-shared`), so a
token minted by a Python service verifies in the TS gateway and vice versa.

```bash
cd packages/shared-py && python3 -m pytest    # 13 tests
```
