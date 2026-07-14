// AX-070 Database MCP tests. Run: node --test test/database.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseMcp, StubBackend, guardSelect } from "../src/database.ts";

const ctx = { credential: "vault:db-readonly" };

// ---------------------------------------------------------------- SQL guard (§14)
test("plain SELECT gets a LIMIT injected", () => {
  const g = guardSelect("SELECT region, count(*) FROM customers GROUP BY region");
  assert.ok(g.ok);
  assert.match(g.sql!, /LIMIT 1000$/);
});

test("existing LIMIT above cap is clamped", () => {
  const g = guardSelect("SELECT * FROM orders LIMIT 999999", 1000);
  assert.match(g.sql!, /LIMIT 1000/);
});

test("small existing LIMIT is preserved", () => {
  const g = guardSelect("SELECT * FROM orders LIMIT 5");
  assert.match(g.sql!, /LIMIT 5/);
});

test("WITH (CTE) read is allowed", () => {
  const g = guardSelect("WITH x AS (SELECT 1) SELECT * FROM x");
  assert.ok(g.ok);
});

test("INSERT is denied", () => {
  const g = guardSelect("INSERT INTO customers VALUES (1)");
  assert.equal(g.ok, false);
  assert.equal(g.code, "E_PERM_TOOL_DENIED");
});

test("UPDATE disguised in a SELECT is denied", () => {
  const g = guardSelect("SELECT 1; UPDATE customers SET churned_at = now()");
  assert.equal(g.ok, false); // multi-statement OR write keyword
});

test("DROP is denied", () => {
  assert.equal(guardSelect("DROP TABLE customers").ok, false);
});

// ---------------------------------------------------------------- MCP tools (§14)
test("database.read runs a capped SELECT", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.read"]({ sql: "SELECT region FROM customers" }, ctx);
  assert.ok(Array.isArray(r.rows));
  assert.match(r.sql, /LIMIT 1000/);
});

test("database.read rejects a write", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.read"]({ sql: "DELETE FROM customers" }, ctx);
  assert.equal(r.error.code, "E_PERM_TOOL_DENIED");
});

test("database.schema introspects tables", async () => {
  const t = new DatabaseMcp().tools();
  const schema: any = await t["database.schema"]({}, ctx);
  assert.ok(schema.some((s: any) => s.table === "customers"));
});

test("database.write is always denied at the tool layer", async () => {
  const t = new DatabaseMcp().tools();
  const r: any = await t["database.write"]({ sql: "x" }, ctx);
  assert.equal(r.error.code, "E_PERM_TOOL_DENIED");
});
