// Database MCP (instructions.md §14). Schema introspection + capped read-only
// SELECTs; writes are denied at the tool layer (and by tool_policies for members).
// The Gateway injects a read-only DB credential (§13.2); this layer adds SQL-level
// safety so a read tool can never mutate or run away.

const WRITE_KEYWORDS = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|MERGE|REPLACE|COPY)\b/i;
const MULTI_STATEMENT = /;\s*\S/; // a second statement after a ';'
const DEFAULT_ROW_CAP = 1000;

export interface QueryGuardResult {
  ok: boolean;
  sql?: string; // possibly rewritten with an enforced LIMIT
  reason?: string;
  code?: string;
}

// Validate + cap a read query (§14). Rejects writes, multi-statements, and injects
// a LIMIT if none is present so a SELECT can never return unbounded rows.
export function guardSelect(sql: string, rowCap = DEFAULT_ROW_CAP): QueryGuardResult {
  const trimmed = sql.trim().replace(/;\s*$/, "");
  if (!/^select\b/i.test(trimmed) && !/^with\b/i.test(trimmed)) {
    return { ok: false, code: "E_PERM_TOOL_DENIED", reason: "only SELECT/WITH reads are allowed" };
  }
  if (WRITE_KEYWORDS.test(trimmed)) {
    return { ok: false, code: "E_PERM_TOOL_DENIED", reason: "write keyword in a read query" };
  }
  if (MULTI_STATEMENT.test(trimmed)) {
    return { ok: false, code: "E_VALIDATION", reason: "multiple statements not allowed" };
  }
  // Enforce a row cap: honor an existing LIMIT if <= cap, else clamp / add one.
  const m = trimmed.match(/\blimit\s+(\d+)\b/i);
  let sqlOut = trimmed;
  if (m) {
    if (Number(m[1]) > rowCap) sqlOut = trimmed.replace(/\blimit\s+\d+\b/i, `LIMIT ${rowCap}`);
  } else {
    sqlOut = `${trimmed} LIMIT ${rowCap}`;
  }
  return { ok: true, sql: sqlOut };
}

export interface DbBackend {
  introspect(ctx: { credential: string }): Promise<Array<{ table: string; columns: string[] }>>;
  runSelect(sql: string, ctx: { credential: string }): Promise<Record<string, unknown>[]>;
}

// Offline stub backend so the tool surface runs without a real DB.
export class StubBackend implements DbBackend {
  async introspect() {
    return [
      { table: "customers", columns: ["id", "region", "churned_at"] },
      { table: "orders", columns: ["id", "customer_id", "total"] },
    ];
  }
  async runSelect(sql: string) {
    return [{ region: "north", n: 12 }, { region: "south", n: 7 }];
  }
}

export class DatabaseMcp {
  private backend: DbBackend;
  private rowCap: number;
  constructor(backend: DbBackend = new StubBackend(), rowCap = DEFAULT_ROW_CAP) {
    this.backend = backend;
    this.rowCap = rowCap;
  }

  tools(): Record<string, (args: any, ctx: { credential: string }) => Promise<unknown>> {
    return {
      "database.schema": (_a, ctx) => this.backend.introspect(ctx),
      "database.read": async (a: { sql: string }, ctx) => {
        const g = guardSelect(String(a.sql ?? ""), this.rowCap);
        if (!g.ok) return { error: { code: g.code, message: g.reason } };
        return { rows: await this.backend.runSelect(g.sql!, ctx), sql: g.sql };
      },
      // database.write intentionally rejects here; tool_policies also denies it for members.
      "database.write": async () => ({
        error: { code: "E_PERM_TOOL_DENIED", message: "writes require approval + power_user" },
      }),
    };
  }
}
