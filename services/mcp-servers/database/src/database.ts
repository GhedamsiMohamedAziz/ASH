// Database MCP (instructions.md §14 "Database | Postgres/MySQL + APIs internes | Comptes de
// service read-only ; écritures = serveur séparé + require_approval"). Exposes READ-ONLY tools
// only: database.query (guarded/capped SELECT), database.list_tables, database.describe. There
// is intentionally NO write tool here — mutating statements are rejected outright by the guard
// below, and a real write path (if ever built) is a SEPARATE server behind require_approval,
// never this one.
//
// Mirrors services/mcp-servers/github/src/github.ts: a StubDb (offline, deterministic) so the
// whole chain runs with no credential/network, and a real backend (pg.ts) that drops in behind
// the SAME DbBackend interface with zero change to the tool surface. The Gateway (§13) injects a
// READ-ONLY service-account credential per call; this layer never sees a raw admin credential.
//
// Read-only enforcement is the security core of this connector: guardQuery() normalizes the SQL
// (masking string/identifier literals, dollar-quoted strings and comments so none of them can
// hide — or fake — a keyword), then default-denies anything that is not a single top-level
// SELECT/WITH statement. See WRITE_KEYWORDS/LOCKING_READ below for the full blocked-vector list.

import { paginate, truncateJson, MAX_RESPONSE_BYTES } from "../../_template/src/pagination.ts";

export interface ToolContext {
  userId: string;
  orgId: string;
  credential: string; // read-only DB credential injected by the gateway from Vault (§13.2)
}

const DEFAULT_ROW_CAP = 1000;
const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Every one of these, as a whole word, anywhere in the normalized (comment/string-masked) query
// marks it a write or a session/administrative mutation — never allowed through this read-only
// tool, no matter where it appears (top level, inside a CTE, after a stacked ';'). INTO covers
// `SELECT ... INTO <table>` (Postgres) and `... INTO OUTFILE` (MySQL), both of which mutate
// despite starting with SELECT. SET blocks session mutation (e.g. `SET ROLE`, `SET search_path`).
const WRITE_KEYWORDS =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE|REPLACE|UPSERT|COPY|CALL|EXEC|EXECUTE|DO|VACUUM|REINDEX|CLUSTER|LOCK|COMMENT|REFRESH|LOAD|ATTACH|DETACH|PRAGMA|RENAME|INTO|SET)\b/i;

// Row-locking reads (`SELECT ... FOR UPDATE/SHARE`) hold locks meant to guard a later write —
// out of place for a stateless read-only credential, so treated as a write vector too.
const LOCKING_READ = /\bFOR\s+(UPDATE|SHARE|NO\s+KEY\s+UPDATE|KEY\s+SHARE)\b/i;

const LEADING_READ = /^\s*(SELECT|WITH)\b/i;
const LIMIT_CLAUSE = /\bLIMIT\s+(\d+)\b/i;

export interface QueryGuardResult {
  ok: boolean;
  sql?: string; // normalized SQL with an enforced/clamped LIMIT
  reason?: string;
  code?: string;
}

// Replaces the CONTENTS of every string literal ('...'), quoted identifier ("..."), dollar-quoted
// string ($$...$$ / $tag$...$tag$) and comment (-- ... / possibly-nested /* ... */) with spaces of
// the SAME length. This keeps every index in the output aligned with the input, so guardQuery can
// safely reuse match positions found in the masked text to slice the ORIGINAL text (e.g. to clamp
// a LIMIT), while the security checks below only ever see real, executable SQL text: a write
// keyword or a stacking ';' sitting inside a comment or a string literal can no longer hide a
// write, and — just as important — can no longer trigger a false rejection of a legitimate read
// (e.g. `WHERE action = 'delete'` or `-- see the DROP ticket`).
export function maskStringsAndComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i];
    const c2 = i + 1 < n ? sql[i + 1] : "";
    if (c === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === '"' && sql[j + 1] === '"') { j += 2; continue; }
        if (sql[j] === '"') { j += 1; break; }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "-" && c2 === "-") {
      let j = i;
      while (j < n && sql[j] !== "\n") j += 1;
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "/" && c2 === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql[j] === "/" && sql[j + 1] === "*") { depth += 1; j += 2; continue; }
        if (sql[j] === "*" && sql[j + 1] === "/") { depth -= 1; j += 2; continue; }
        j += 1;
      }
      out += " ".repeat(j - i);
      i = j;
      continue;
    }
    if (c === "$") {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const j = end === -1 ? n : end + tag.length;
        out += " ".repeat(j - i);
        i = j;
        continue;
      }
    }
    out += c;
    i += 1;
  }
  return out;
}

// The read-only guard (security core, §14). Rejects anything that is not a single top-level
// SELECT/WITH statement, then enforces a row cap by injecting or clamping a LIMIT. Fail-closed:
// on any doubt (an unmasked ';' left over, a banned keyword anywhere, a non-SELECT/WITH lead) the
// query is rejected, never executed.
export function guardQuery(sqlIn: string, rowCap = DEFAULT_ROW_CAP): QueryGuardResult {
  if (typeof sqlIn !== "string" || sqlIn.trim().length === 0) {
    return { ok: false, code: "E_VALIDATION", reason: "empty query" };
  }
  let src = sqlIn.trim();
  let cleaned = maskStringsAndComments(src);

  // Drop exactly one trailing statement terminator. The match runs against `cleaned`, so a ';'
  // hiding inside a trailing comment/string was already masked out and won't be mistaken for one.
  const trailingSemi = /;\s*$/.exec(cleaned);
  if (trailingSemi) {
    const cut = cleaned.length - trailingSemi[0].length;
    src = src.slice(0, cut);
    cleaned = cleaned.slice(0, cut);
  }
  while (cleaned.length > 0 && /\s$/.test(cleaned)) {
    src = src.slice(0, -1);
    cleaned = cleaned.slice(0, -1);
  }
  if (cleaned.trim().length === 0) {
    return { ok: false, code: "E_VALIDATION", reason: "empty query" };
  }

  if (!LEADING_READ.test(cleaned)) {
    return { ok: false, code: "E_PERM_TOOL_DENIED", reason: "only SELECT/WITH reads are allowed" };
  }
  // Any remaining ';' is a second statement (a stacked query) — real SQL text, since a ';' hiding
  // inside a string/comment was already masked out above.
  if (cleaned.includes(";")) {
    return { ok: false, code: "E_VALIDATION", reason: "multiple statements are not allowed" };
  }
  if (WRITE_KEYWORDS.test(cleaned)) {
    return { ok: false, code: "E_PERM_TOOL_DENIED", reason: "write or admin keyword in a read query" };
  }
  if (LOCKING_READ.test(cleaned)) {
    return { ok: false, code: "E_PERM_TOOL_DENIED", reason: "row-locking reads (FOR UPDATE/SHARE) are not allowed" };
  }

  // Enforce the row cap: honor an existing LIMIT <= cap, clamp a larger one, else append one.
  // The match position comes from `cleaned` (guaranteed real code, per the masking above) and is
  // reused to splice `src` — so a real LIMIT is edited in place, formatting/casing preserved.
  const m = LIMIT_CLAUSE.exec(cleaned);
  let sqlOut = src;
  if (m) {
    if (Number(m[1]) > rowCap) {
      sqlOut = src.slice(0, m.index) + `LIMIT ${rowCap}` + src.slice(m.index + m[0].length);
    }
  } else {
    sqlOut = `${src} LIMIT ${rowCap}`;
  }
  return { ok: true, sql: sqlOut };
}

export interface TableRef {
  schema?: string;
  table: string;
}

export interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
}

// Backend the façade calls. Injected so tests need no real database (mirrors GithubBackend).
export interface DbBackend {
  listTables(ctx: ToolContext): Promise<TableRef[]>;
  describeTable(table: string, ctx: ToolContext): Promise<{ table: string; columns: ColumnInfo[] } | null>;
  runQuery(sql: string, ctx: ToolContext): Promise<Record<string, unknown>[]>;
}

// Offline stub so the whole tool surface runs with no credential/network — deterministic, same
// shape as the real backend (pg.ts), used by default and by every test in this connector.
export class StubDb implements DbBackend {
  private tables: Record<string, ColumnInfo[]> = {
    customers: [
      { name: "id", type: "bigint", nullable: false },
      { name: "region", type: "text", nullable: false },
      { name: "churned_at", type: "timestamptz", nullable: true },
    ],
    orders: [
      { name: "id", type: "bigint", nullable: false },
      { name: "customer_id", type: "bigint", nullable: false },
      { name: "total", type: "numeric", nullable: false },
    ],
  };

  async listTables(): Promise<TableRef[]> {
    return Object.keys(this.tables).map((table) => ({ schema: "public", table }));
  }

  async describeTable(table: string): Promise<{ table: string; columns: ColumnInfo[] } | null> {
    const columns = this.tables[table];
    return columns ? { table, columns } : null;
  }

  async runQuery(_sql: string): Promise<Record<string, unknown>[]> {
    return [
      { region: "north", n: 12 },
      { region: "south", n: 7 },
    ];
  }
}

export interface DatabaseMcpOpts {
  rowCap?: number;
  defaultPageSize?: number;
  maxPageSize?: number;
}

export class DatabaseMcp {
  private backend: DbBackend;
  private rowCap: number;
  private defaultPageSize: number;
  private maxPageSize: number;

  constructor(backend: DbBackend = new StubDb(), opts: DatabaseMcpOpts = {}) {
    this.backend = backend;
    this.rowCap = opts.rowCap ?? DEFAULT_ROW_CAP;
    this.defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPageSize = opts.maxPageSize ?? Math.min(MAX_PAGE_SIZE, this.rowCap);
  }

  private pageSize(args: any): number {
    const n = Number(args?.pageSize ?? this.defaultPageSize);
    if (!Number.isFinite(n)) return this.defaultPageSize;
    return Math.min(Math.max(Math.trunc(n), 1), this.maxPageSize);
  }

  // NOTE: there is intentionally no "database.write" tool here. Writes require a SEPARATE service
  // behind require_approval (§14) — this connector never implements or executes one.
  tools(): Record<string, (args: any, ctx: ToolContext) => Promise<unknown>> {
    return {
      "database.query": (a, ctx) => this.query(a, ctx),
      "database.list_tables": (a, ctx) => this.listTables(a, ctx),
      "database.describe": (a, ctx) => this.describe(a, ctx),
    };
  }

  private async query(args: any, ctx: ToolContext) {
    const guard = guardQuery(String(args?.sql ?? ""), this.rowCap);
    if (!guard.ok) return { error: { code: guard.code, message: guard.reason } };
    const rows = await this.backend.runQuery(guard.sql!, ctx);
    const page = paginate(rows, args?.cursor ? String(args.cursor) : undefined, this.pageSize(args));
    const { json, truncated } = truncateJson({ items: page.items, nextCursor: page.nextCursor }, MAX_RESPONSE_BYTES);
    return {
      ...(JSON.parse(json) as { items: Record<string, unknown>[]; nextCursor?: string }),
      truncated,
      sql: guard.sql,
    };
  }

  private async listTables(args: any, ctx: ToolContext) {
    const all = await this.backend.listTables(ctx);
    const page = paginate(all, args?.cursor ? String(args.cursor) : undefined, this.pageSize(args));
    const { json, truncated } = truncateJson({ items: page.items, nextCursor: page.nextCursor }, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as { items: TableRef[]; nextCursor?: string }), truncated };
  }

  private async describe(args: any, ctx: ToolContext) {
    const table = String(args?.table ?? "");
    // Strict allow-list identifier check — table is never string-interpolated into SQL text
    // regardless (see PgBackend.describeTable's bound $1), but a bad identifier is rejected here
    // before it even reaches the backend.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
      return { error: { code: "E_VALIDATION", message: "invalid table name" } };
    }
    const result = await this.backend.describeTable(table, ctx);
    if (!result) return { error: { code: "E_NOT_FOUND", message: `table not found: ${table}` } };
    const { json, truncated } = truncateJson({ table: result.table, items: result.columns }, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as { table: string; items: ColumnInfo[] }), truncated };
  }
}

// JSON Schema for each tool's input (instructions.md §14 "strict JSON Schema"). Kept alongside the
// tool surface so wiring this connector into a gateway's MCP catalog (mirrors mcp-gateway/src/
// mcp.ts's MCP_TOOLS for github.*) is a straight copy — that gateway file itself is out of scope
// for this connector (owned by mcp-gateway).
export const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  "database.query": {
    description:
      "Run a read-only SQL query (a single SELECT, or a read-only WITH/CTE) against the " +
      "connected database through a read-only service account. Any non-SELECT statement, " +
      "stacked statement, or row-locking read is rejected before it reaches the database.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT or read-only WITH statement." },
        pageSize: { type: "number", description: `Rows per page (1-${MAX_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
      required: ["sql"],
    },
  },
  "database.list_tables": {
    description: "List tables visible to the read-only service account.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "number", description: `Tables per page (1-${MAX_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
    },
  },
  "database.describe": {
    description: "Describe a table's columns (name, type, nullability).",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (bare identifier, no schema-qualification)." },
      },
      required: ["table"],
    },
  },
};
