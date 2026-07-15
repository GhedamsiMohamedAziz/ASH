// Real Postgres backend (instructions.md §14) — drops in behind the SAME DbBackend interface as
// StubDb, so `new DatabaseMcp(new PgBackend())` makes every tool call real with zero change to
// the tool surface. "pg" is imported LAZILY (only when a query actually runs), so it is NOT a
// hard dependency: the offline/keyless dev+test path (StubDb) never needs it installed — mirrors
// mcp-gateway/src/taint.ts's RedisTaint lazy `import("redis")`.
//
// The credential is NEVER read from source or an ambient env var here: it comes per-call from
// ctx.credential, which the Gateway injects from Vault (§13.2) — a READ-ONLY service-account
// connection string/role scoped by policy, never a raw admin credential. A missing credential
// fails closed (throws PgCredentialMissing), it never falls back to a shared/ambient connection.
//
// Every input that reaches SQL text here is either (a) the already-guarded read-only query text
// produced by guardQuery() in database.ts, or (b) a bound parameter ($1). Table names are NEVER
// string-interpolated into a query — see describeTable's $1 bind against information_schema.

import type { ColumnInfo, DbBackend, TableRef, ToolContext } from "./database.ts";

export class PgCredentialMissing extends Error {
  code = "E_CONN_NEEDS_CONNECTION";
  constructor() {
    super("no read-only database credential for this user/org");
    this.name = "PgCredentialMissing";
  }
}

// Minimal shape of a "pg" pooled client — a single connection checked out of the pool, so a
// BEGIN / SET TRANSACTION READ ONLY / query / ROLLBACK sequence all runs on the SAME connection
// (a bare pool.query() gives no such guarantee).
export interface PgClientLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

// Minimal shape of the "pg" Pool this file relies on — avoids a hard static dependency on the
// package's types (which aren't installed in the offline/keyless default path). `connect` is
// optional only so an offline test seam can omit it; the real pg Pool always provides it, and
// runQuery requires it to enforce the read-only transaction (see below).
export interface PgPoolLike {
  query(text: string, params?: unknown[]): Promise<{ rows: any[] }>;
  connect?(): Promise<PgClientLike>;
  end(): Promise<void>;
}

export class PgBackend implements DbBackend {
  private pools = new Map<string, Promise<PgPoolLike>>();
  private poolFactory: (connectionString: string) => Promise<PgPoolLike>;

  // `poolFactory` is injectable so tests can drive this class with a fake pool — no real "pg"
  // install, no network — the same seam RestBackend uses for `fetchImpl` (github/src/rest.ts).
  constructor(opts: { poolFactory?: (connectionString: string) => Promise<PgPoolLike> } = {}) {
    this.poolFactory = opts.poolFactory ?? PgBackend.defaultPoolFactory;
  }

  private static async defaultPoolFactory(connectionString: string): Promise<PgPoolLike> {
    const { Pool } = await import("pg");
    return new Pool({ connectionString, max: 4 }) as unknown as PgPoolLike;
  }

  private pool(ctx: ToolContext): Promise<PgPoolLike> {
    if (!ctx.credential) throw new PgCredentialMissing();
    let p = this.pools.get(ctx.credential);
    if (!p) {
      p = this.poolFactory(ctx.credential);
      this.pools.set(ctx.credential, p);
    }
    return p;
  }

  async listTables(ctx: ToolContext): Promise<TableRef[]> {
    const pool = await this.pool(ctx);
    const res = await pool.query(
      `SELECT table_schema AS schema, table_name AS table
         FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
        ORDER BY table_schema, table_name`,
    );
    return res.rows.map((r) => ({ schema: r.schema, table: r.table }));
  }

  async describeTable(table: string, ctx: ToolContext): Promise<{ table: string; columns: ColumnInfo[] } | null> {
    const pool = await this.pool(ctx);
    // Bound parameter — the table name is never concatenated into the SQL text.
    const res = await pool.query(
      `SELECT column_name AS name, data_type AS type, (is_nullable = 'YES') AS nullable
         FROM information_schema.columns
        WHERE table_name = $1
        ORDER BY ordinal_position`,
      [table],
    );
    if (res.rows.length === 0) return null;
    return {
      table,
      columns: res.rows.map((r) => ({ name: r.name, type: r.type, nullable: !!r.nullable })),
    };
  }

  async runQuery(sql: string, ctx: ToolContext): Promise<Record<string, unknown>[]> {
    // `sql` here is always the output of guardQuery() (database.ts) — already verified read-only
    // and row-capped before it ever reaches this method. No further args are interpolated.
    //
    // The string guard is defense-in-depth; THIS is the real read-only control. Enforcing it at the
    // DATABASE — not the string — is what catches mutation hidden inside a side-effecting function
    // call (setval/nextval, dblink_exec mutating this session, etc.) that a keyword denylist can
    // never fully cover: we run the query inside a `BEGIN; SET TRANSACTION READ ONLY; ...` block, so
    // the database itself rejects any write, then ROLLBACK so nothing this connection touched can
    // ever commit. It runs on a single checked-out client so all four statements share one
    // connection. (The real pg Pool always exposes connect(); the fallback below exists only for an
    // offline test seam that injects a pool without it, and that path is still gated by the string
    // guard upstream.)
    const pool = await this.pool(ctx);
    if (!pool.connect) {
      const res = await pool.query(sql);
      return res.rows;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET TRANSACTION READ ONLY");
      const res = await client.query(sql);
      await client.query("ROLLBACK");
      return res.rows;
    } catch (err) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback failure — surface the original error below
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
