# Database MCP

> **Status:** Phase 1 (AX-070, runnable + tested) · **Spec:** instructions.md §14

Read-only connector for internal Postgres/MySQL databases. Tools: `database.query`,
`database.list_tables`, `database.describe`. The MCP Gateway (§13) injects a **read-only**
service-account credential and enforces AuthZ, so this layer never sees a raw admin credential.
There is intentionally no write tool — see "Read-only enforcement" below.

## Tools

| Tool | Args | Notes |
| --- | --- | --- |
| `database.query` | `sql` (required), `pageSize?`, `cursor?` | Runs a guarded, row-capped, paginated SELECT/WITH read. |
| `database.list_tables` | `pageSize?`, `cursor?` | Lists tables visible to the read-only credential. |
| `database.describe` | `table` (required) | Column name/type/nullability for one table. |

JSON Schemas for all three live in `src/database.ts` (`TOOL_SCHEMAS`), ready to drop into a
gateway's MCP catalog (mirrors `mcp-gateway/src/mcp.ts`'s `MCP_TOOLS` for `github.*`) — wiring
that gateway file is out of scope for this connector (owned by `mcp-gateway`).

## Read-only enforcement (the security core)

`guardQuery()` in `src/database.ts` is fail-closed: it normalizes the SQL text with
`maskStringsAndComments()` — replacing the *contents* of every `'...'` string, `"..."` quoted
identifier, `$$...$$`/`$tag$...$tag$` dollar-quoted string, `-- ...` line comment and (possibly
nested) `/* ... */` block comment with same-length spaces — and only then runs the security
checks below. This means a write keyword or a stacking `;` hidden inside a comment or a string
literal can neither sneak a write past the guard NOR falsely trip it (e.g.
`WHERE action = 'delete'` or `-- see the DROP ticket` are both allowed).

A query is rejected unless it is a **single top-level `SELECT` or `WITH` statement**. Blocked,
wherever they appear (top level, inside a CTE, after a stacked `;`):

`INSERT` · `UPDATE` · `DELETE` · `DROP` · `ALTER` · `TRUNCATE` · `CREATE` · `GRANT` · `REVOKE` ·
`MERGE` · `REPLACE`/`UPSERT` · `COPY` · `CALL` · `EXEC`/`EXECUTE` · `DO` · `VACUUM` · `REINDEX` ·
`CLUSTER` · `LOCK` · `COMMENT` · `REFRESH` · `LOAD` · `ATTACH`/`DETACH` · `PRAGMA` · `RENAME` ·
`SET` · `INTO` (blocks `SELECT ... INTO <table>` and `... INTO OUTFILE`, both writes despite
starting with `SELECT`) · `FOR UPDATE`/`FOR SHARE` row-locking reads.

Also rejected: **stacked statements** (`SELECT 1; DROP TABLE x`) and **CTE-wrapped writes**
(`WITH t AS (INSERT INTO x ... RETURNING id) SELECT * FROM t` — the keyword scan runs over the
whole normalized text, so a write buried inside a CTE body is caught the same as one at top
level). Every one of these vectors has a dedicated test in `test/database.test.ts`.

**Writes are a separate server behind `require_approval` (§14).** This connector never
implements or executes a write — `database.write` does not exist in `tools()`, and there is no
code path anywhere here that can reach anything other than `SELECT`/`WITH`.

## Identity / service-account seam

- **Pluggable backend** (`src/database.ts`): `StubDb` is offline + deterministic so the whole
  chain runs with no credential/network — the default and what every test in `test/` exercises.
- **Real backend** (`src/pg.ts`): `PgBackend` implements the same `DbBackend` interface. `pg` is
  imported **lazily** (only when a query actually runs), so it is **not a hard dependency** —
  mirrors `mcp-gateway/src/taint.ts`'s lazy `import("redis")`. The credential is read only from
  `ctx.credential` (gateway-injected from Vault, §13.2) — never an ambient env var — and a
  missing credential fails closed (`PgCredentialMissing` / `E_CONN_NEEDS_CONNECTION`).
- **Parameterized inputs, no interpolation:** `database.describe`'s `table` argument is validated
  against a strict identifier regex at the tool layer, and in `PgBackend.describeTable` it is
  bound as `$1` against `information_schema.columns` — never concatenated into SQL text.
  `database.query`'s `sql` is inherently free text (that's the tool), which is exactly why the
  guard above is the safety layer for it instead.

## Bound results

- **Row cap:** every guarded query gets a `LIMIT` — injected if absent, clamped if it exceeds the
  cap (default 1000, configurable via `DatabaseMcpOpts.rowCap`).
- **Pagination + 256 KB truncation:** every tool response is paginated (`pageSize`/`cursor`) and
  truncated to 256 KB via `services/mcp-servers/_template/src/pagination.ts` — the shared §14
  "règles communes" helper (`paginate`, `truncateJson`, `MAX_RESPONSE_BYTES`), reused here rather
  than reimplemented.

```bash
cd services/mcp-servers/database && npm test
# 54 tests: guard allow/deny matrix (incl. false-positive avoidance), MCP tool surface,
# pagination, row-cap wiring, 256 KB truncation, StubDb, PgBackend (fake-pool, no network)
```

## Known SQL-parse edge cases

- The guard is a hand-rolled string/comment/dollar-quote masker plus keyword regex, not a full
  SQL parser. It always defaults to **reject** on ambiguity (fail-closed), but two things aren't
  modeled: MySQL backtick-quoted identifiers (`` `delete` ``) are not masked like `'...'`/`"..."`
  — a backtick-quoted column literally named after a write keyword would still be flagged (a
  false rejection, never a false allow); and a `;` or keyword split across a comment in a way a
  real SQL engine would still parse as one token is assumed not to occur (true for standard
  comment-as-whitespace semantics in Postgres/MySQL — a comment cannot splice two half-tokens
  into one keyword).
- `EXPLAIN` is not allowed at all, even the non-`ANALYZE` form, specifically to avoid the
  `EXPLAIN ANALYZE` variant, which actually **executes** the wrapped statement (including a
  write). Out of scope for this pass.

## Next

- MySQL backend behind the same `DbBackend` interface (currently Postgres-only via `PgBackend`).
- Register these tools with a running gateway (`mcp-gateway/src/mcp.ts`'s `MCP_TOOLS`), the way
  `github.*` is — out of scope here (gateway wiring belongs to that service).
