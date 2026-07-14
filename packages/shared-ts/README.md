# packages/shared-ts (AX-007)

Shared runtime helpers for the TypeScript services (mcp-gateway, mcp-servers,
automation-service). Node-stdlib-only (`node:crypto`); wire-compatible with
`packages/shared-py`.

| Module | Role | Status |
|---|---|---|
| `src/jwt.ts` | HS256 sign/verify, fail-closed, no `alg:none` bypass (§13.4). | ✅ cross-verified with Python |
| `src/telemetry.ts` | W3C `traceparent` generate/parse/child (§8.1, §19). | ✅ cross-verified with Python |
| `src/bus.ts` | `InMemoryBus` (trailing-* wildcard) + `DedupeGuard` (prod: NATS JetStream). | ✅ mirrors shared-py |
| `src/idempotency.ts` | `InMemoryStore` w/ TTL (prod: Redis). | ✅ mirrors shared-py |

Tests: `node --test test/shared.test.ts` (5) — bus wildcard/unsubscribe, dedup,
idempotency remember/get/ttl. Same contract + semantics as `packages/shared-py`.

**Cross-language proof:** `packages/shared-ts/src/xcheck.ts` verifies a
Python-signed JWT in TS and round-trips one back; `make test-shared` runs the
full py↔ts JWT + traceparent compatibility check. Requires Node ≥ 23 (runs `.ts`
via native type-stripping — no build step).
