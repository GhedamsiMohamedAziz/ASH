// AX-070 Database MCP tests. Run: node --test test/database.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DatabaseMcp,
  StubDb,
  guardQuery,
  type DbBackend,
  type ToolContext,
  type TableRef,
  type ColumnInfo,
} from "../src/database.ts";

const ctx: ToolContext = { userId: "usr_1", orgId: "org_1", credential: "vault:db-readonly" };

// =================================================================== guardQuery: allowed reads

test("plain SELECT gets a LIMIT injected", () => {
  const g = guardQuery("SELECT region, count(*) FROM customers GROUP BY region");
  assert.ok(g.ok);
  assert.match(g.sql!, /LIMIT 1000$/);
});

test("existing LIMIT above cap is clamped", () => {
  const g = guardQuery("SELECT * FROM orders LIMIT 999999", 1000);
  assert.ok(g.ok);
  assert.match(g.sql!, /LIMIT 1000\b/);
  assert.doesNotMatch(g.sql!, /999999/);
});

test("small existing LIMIT is preserved as-is", () => {
  const g = guardQuery("SELECT * FROM orders LIMIT 5");
  assert.ok(g.ok);
  assert.match(g.sql!, /LIMIT 5$/);
});

test("WITH (read-only CTE) is allowed", () => {
  const g = guardQuery("WITH recent AS (SELECT * FROM orders WHERE total > 100) SELECT * FROM recent");
  assert.ok(g.ok);
});

test("lowercase select is allowed (case-insensitive)", () => {
  assert.ok(guardQuery("select 1").ok);
});

test("trailing semicolon is tolerated on an otherwise-single statement", () => {
  const g = guardQuery("SELECT 1;");
  assert.ok(g.ok);
});

test("empty/whitespace-only query is rejected", () => {
  assert.equal(guardQuery("").ok, false);
  assert.equal(guardQuery("   ").ok, false);
  assert.equal(guardQuery("   ").code, "E_VALIDATION");
});

// ============================================================ guardQuery: blocked write vectors

const BLOCKED_LEADING: Array<[string, string]> = [
  ["INSERT", "INSERT INTO customers (id) VALUES (1)"],
  ["UPDATE", "UPDATE customers SET churned_at = now()"],
  ["DELETE", "DELETE FROM customers"],
  ["DROP", "DROP TABLE customers"],
  ["ALTER", "ALTER TABLE customers ADD COLUMN x int"],
  ["TRUNCATE", "TRUNCATE customers"],
  ["CALL", "CALL update_stats()"],
  ["GRANT", "GRANT SELECT ON customers TO analyst_role"],
  ["REVOKE", "REVOKE SELECT ON customers FROM analyst_role"],
  ["REPLACE INTO (MySQL upsert)", "REPLACE INTO customers (id) VALUES (1)"],
  ["MERGE INTO", "MERGE INTO customers USING staged ON customers.id = staged.id WHEN MATCHED THEN UPDATE SET x = 1"],
  ["EXECUTE", "EXECUTE prepared_stmt"],
  ["VACUUM", "VACUUM customers"],
  ["lowercase insert", "insert into customers values (1)"],
];

for (const [label, sql] of BLOCKED_LEADING) {
  test(`blocked: ${label}`, () => {
    const g = guardQuery(sql);
    assert.equal(g.ok, false);
    assert.equal(g.code, "E_PERM_TOOL_DENIED");
  });
}

test("blocked: stacked statement — SELECT 1; DROP TABLE x", () => {
  const g = guardQuery("SELECT 1; DROP TABLE x");
  assert.equal(g.ok, false);
  assert.equal(g.code, "E_VALIDATION");
});

test("blocked: two SELECTs stacked", () => {
  const g = guardQuery("SELECT 1; SELECT 2");
  assert.equal(g.ok, false);
  assert.equal(g.code, "E_VALIDATION");
});

test("blocked: comment-smuggled stacked write — SELECT/*x*/ 1; DELETE FROM x", () => {
  const g = guardQuery("SELECT/*x*/ 1; DELETE FROM x");
  assert.equal(g.ok, false);
});

test("blocked: CTE-wrapped write — WITH t AS (INSERT ... RETURNING id) SELECT * FROM t", () => {
  const g = guardQuery("WITH t AS (INSERT INTO customers DEFAULT VALUES RETURNING id) SELECT * FROM t");
  assert.equal(g.ok, false);
  assert.equal(g.code, "E_PERM_TOOL_DENIED");
});

test("blocked: CTE-wrapped DELETE", () => {
  const g = guardQuery("WITH deleted AS (DELETE FROM customers WHERE churned_at < now() RETURNING id) SELECT * FROM deleted");
  assert.equal(g.ok, false);
});

test("blocked: SELECT ... INTO <table> (Postgres write disguised as a read)", () => {
  const g = guardQuery("SELECT * INTO new_table FROM customers");
  assert.equal(g.ok, false);
  assert.equal(g.code, "E_PERM_TOOL_DENIED");
});

test("blocked: SELECT ... INTO OUTFILE (MySQL file write)", () => {
  const g = guardQuery("SELECT * FROM customers INTO OUTFILE '/tmp/dump.csv'");
  assert.equal(g.ok, false);
});

test("blocked: row-locking read — SELECT ... FOR UPDATE", () => {
  const g = guardQuery("SELECT * FROM customers WHERE id = 1 FOR UPDATE");
  assert.equal(g.ok, false);
  assert.equal(g.code, "E_PERM_TOOL_DENIED");
});

test("blocked: row-locking read — SELECT ... FOR SHARE", () => {
  const g = guardQuery("SELECT * FROM customers WHERE id = 1 FOR SHARE");
  assert.equal(g.ok, false);
});

test("blocked: SET (session mutation, e.g. SET ROLE)", () => {
  const g = guardQuery("SET ROLE admin");
  assert.equal(g.ok, false);
});

test("blocked: DO block (Postgres anonymous procedural write)", () => {
  const g = guardQuery("DO $$ BEGIN DELETE FROM customers; END $$");
  assert.equal(g.ok, false);
});

// Side-effecting FUNCTION CALLS: these lead with SELECT and carry no write keyword, so a plain
// keyword denylist waves them through. The mutation/disclosure hides inside the function (dblink_exec
// even opens its OWN connection). The SIDE_EFFECT_FUNCS denylist fails them fast; the read-only
// transaction in PgBackend is the deeper control.
const BLOCKED_SIDE_EFFECT_FUNCS: Array<[string, string]> = [
  ["setval", "SELECT setval('s',99999)"],
  ["nextval", "SELECT nextval('s')"],
  ["lo_import", "SELECT lo_import('/etc/passwd')"],
  ["pg_read_file", "SELECT pg_read_file('/etc/passwd')"],
  ["dblink_exec (opens its own connection, bypassing the read-only credential)", "SELECT dblink_exec('dbname=app','DELETE FROM orders')"],
];

for (const [label, sql] of BLOCKED_SIDE_EFFECT_FUNCS) {
  test(`blocked: side-effecting function — ${label}`, () => {
    const g = guardQuery(sql);
    assert.equal(g.ok, false);
    assert.equal(g.code, "E_PERM_TOOL_DENIED");
  });
}

// ================================================= guardQuery: false-positive avoidance (allowed)

test("allowed: a write keyword inside a string literal is just data, not SQL", () => {
  const g = guardQuery("SELECT * FROM logs WHERE action = 'delete'");
  assert.ok(g.ok, g.reason);
});

test("allowed: a write keyword inside a line comment is inert", () => {
  const g = guardQuery("SELECT 1 -- ; DROP TABLE x");
  assert.ok(g.ok, g.reason);
});

test("allowed: a write keyword inside a block comment is inert", () => {
  const g = guardQuery("SELECT 1 /* DROP everything, just kidding */ FROM (SELECT 1 AS x) t");
  assert.ok(g.ok, g.reason);
});

test("allowed: a quoted identifier containing a write word is just a name", () => {
  const g = guardQuery('SELECT "delete_flag" FROM customers');
  assert.ok(g.ok, g.reason);
});

test("allowed: MySQL backtick identifiers named like keywords are not false-rejected", () => {
  const g = guardQuery("SELECT `update`, `set` FROM t");
  assert.ok(g.ok, g.reason);
});

test("blocked: a real write is not hidden by backtick identifiers (INSERT INTO `t` ...)", () => {
  const g = guardQuery("INSERT INTO `t` (id) VALUES (1)");
  assert.equal(g.ok, false);
  assert.equal(g.code, "E_PERM_TOOL_DENIED");
});

test("allowed: leading TABLE is the Postgres read shorthand (TABLE orders)", () => {
  const g = guardQuery("TABLE orders");
  assert.ok(g.ok, g.reason);
  assert.match(g.sql!, /LIMIT 1000$/);
});

// ======================================================================================= StubDb

test("StubDb is deterministic and offline (no credential/network needed)", async () => {
  const db = new StubDb();
  const tables = await db.listTables();
  assert.deepEqual(tables.map((t) => t.table).sort(), ["customers", "orders"]);
  const described = await db.describeTable("orders");
  assert.ok(described);
  assert.deepEqual(described!.columns.map((c) => c.name), ["id", "customer_id", "total"]);
  assert.equal(await db.describeTable("nope"), null);
  const rows = await db.runQuery("SELECT * FROM customers LIMIT 1000");
  assert.ok(Array.isArray(rows) && rows.length > 0);
});

// =================================================================================== MCP tools

test("database.query runs a capped SELECT via the backend and returns rows", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.query"]({ sql: "SELECT region FROM customers" }, ctx);
  assert.ok(Array.isArray(r.items));
  assert.equal(r.items.length, 2);
  assert.match(r.sql, /LIMIT 1000$/);
  assert.equal(r.truncated, false);
});

test("database.query rejects a write and never calls the backend", async () => {
  let called = false;
  const backend: DbBackend = {
    async listTables() { return []; },
    async describeTable() { return null; },
    async runQuery() { called = true; return []; },
  };
  const t = new DatabaseMcp(backend).tools();
  const r: any = await t["database.query"]({ sql: "DELETE FROM customers" }, ctx);
  assert.equal(r.error.code, "E_PERM_TOOL_DENIED");
  assert.equal(called, false, "a rejected write must never reach the backend");
});

test("database.list_tables lists the stub tables", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.list_tables"]({}, ctx);
  const names = r.items.map((x: TableRef) => x.table);
  assert.ok(names.includes("customers"));
  assert.ok(names.includes("orders"));
});

test("database.describe returns columns for a known table", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.describe"]({ table: "customers" }, ctx);
  const names = r.items.map((c: ColumnInfo) => c.name);
  assert.deepEqual(names, ["id", "region", "churned_at"]);
});

test("database.describe returns E_NOT_FOUND for an unknown table", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.describe"]({ table: "nope" }, ctx);
  assert.equal(r.error.code, "E_NOT_FOUND");
});

test("database.describe rejects a non-identifier table argument (defense in depth)", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.describe"]({ table: "customers; DROP TABLE x" }, ctx);
  assert.equal(r.error.code, "E_VALIDATION");
});

test("there is no database.write tool — writes are a separate server behind require_approval", () => {
  const t = new DatabaseMcp().tools();
  assert.equal(t["database.write"], undefined);
  assert.deepEqual(Object.keys(t).sort(), ["database.describe", "database.list_tables", "database.query"]);
});

// ===================================================================================== pagination

test("database.list_tables paginates with a cursor", async () => {
  const backend: DbBackend = {
    async listTables(): Promise<TableRef[]> {
      return Array.from({ length: 7 }, (_, i) => ({ schema: "public", table: `t${i}` }));
    },
    async describeTable() { return null; },
    async runQuery() { return []; },
  };
  const mcp = new DatabaseMcp(backend, { defaultPageSize: 3 });
  const t = mcp.tools();

  const page1: any = await t["database.list_tables"]({}, ctx);
  assert.equal(page1.items.length, 3);
  assert.ok(page1.nextCursor);

  const page2: any = await t["database.list_tables"]({ cursor: page1.nextCursor }, ctx);
  assert.equal(page2.items.length, 3);
  assert.ok(page2.nextCursor);

  const page3: any = await t["database.list_tables"]({ cursor: page2.nextCursor }, ctx);
  assert.equal(page3.items.length, 1);
  assert.equal(page3.nextCursor, undefined, "the final page has no next cursor");
});

// ============================================================================== row cap wiring

test("a custom rowCap is enforced in the SQL sent to the backend", async () => {
  let seenSql = "";
  const backend: DbBackend = {
    async listTables() { return []; },
    async describeTable() { return null; },
    async runQuery(sql) { seenSql = sql; return []; },
  };
  const t = new DatabaseMcp(backend, { rowCap: 5 }).tools();
  await t["database.query"]({ sql: "SELECT * FROM customers" }, ctx);
  assert.match(seenSql, /LIMIT 5$/);
});

// ==================================================================== 256 KB response truncation

test("database.query truncates a large result set to 256 KB and flags truncated", async () => {
  const bigNote = "x".repeat(600);
  const backend: DbBackend = {
    async listTables() { return []; },
    async describeTable() { return null; },
    async runQuery() {
      return Array.from({ length: 1000 }, (_, i) => ({ id: i, note: bigNote }));
    },
  };
  const t = new DatabaseMcp(backend, { rowCap: 1000, defaultPageSize: 500, maxPageSize: 500 }).tools();
  const r: any = await t["database.query"]({ sql: "SELECT * FROM customers", pageSize: 500 }, ctx);

  assert.equal(r.truncated, true);
  assert.ok(r.items.length < 500, "rows must have been dropped to fit the byte budget");
  const rebuilt = JSON.stringify({ items: r.items, nextCursor: r.nextCursor, truncated: true });
  assert.ok(Buffer.byteLength(rebuilt, "utf8") <= 256 * 1024);
});

test("database.list_tables truncates when the table list is large", async () => {
  const backend: DbBackend = {
    async listTables(): Promise<TableRef[]> {
      return Array.from({ length: 2000 }, (_, i) => ({ schema: "public", table: `very_long_table_name_${i}_${"y".repeat(80)}` }));
    },
    async describeTable() { return null; },
    async runQuery() { return []; },
  };
  const t = new DatabaseMcp(backend, { defaultPageSize: 2000, maxPageSize: 2000 }).tools();
  const r: any = await t["database.list_tables"]({ pageSize: 2000 }, ctx);

  assert.equal(r.truncated, true);
  const rebuilt = JSON.stringify({ items: r.items, nextCursor: r.nextCursor, truncated: true });
  assert.ok(Buffer.byteLength(rebuilt, "utf8") <= 256 * 1024);
});
