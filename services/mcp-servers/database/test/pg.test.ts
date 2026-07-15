// Real Postgres backend tests — drive PgBackend with an injected fake pool (no network, no
// "pg" install required: poolFactory is the seam, mirroring RestBackend's fetchImpl seam in
// services/mcp-servers/github/test/rest.test.ts). Proves the tool surface is unchanged, that
// table names are bound ($1) rather than interpolated, and that a missing credential fails
// closed. Run: node --test test/pg.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PgBackend, PgCredentialMissing, type PgPoolLike } from "../src/pg.ts";
import type { ToolContext } from "../src/database.ts";

const ctx: ToolContext = { userId: "usr_1", orgId: "org_1", credential: "postgres://readonly@db/olma" };

function fakePool(handlers: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> }): PgPoolLike {
  return { query: handlers.query, end: async () => {} };
}

test("listTables queries information_schema.tables with no interpolated input", async () => {
  const sink: any = {};
  const backend = new PgBackend({
    poolFactory: async () =>
      fakePool({
        query: async (text, params) => {
          sink.text = text;
          sink.params = params;
          return { rows: [{ schema: "public", table: "customers" }] };
        },
      }),
  });
  const r = await backend.listTables(ctx);
  assert.deepEqual(r, [{ schema: "public", table: "customers" }]);
  assert.match(sink.text, /information_schema\.tables/);
  assert.equal(sink.params, undefined, "listTables takes no user input to bind");
});

test("describeTable binds the table name as $1, never string-interpolated", async () => {
  const sink: any = {};
  const backend = new PgBackend({
    poolFactory: async () =>
      fakePool({
        query: async (text, params) => {
          sink.text = text;
          sink.params = params;
          return { rows: [{ name: "id", type: "bigint", nullable: false }] };
        },
      }),
  });
  const r = await backend.describeTable("customers; DROP TABLE x", ctx);
  assert.match(sink.text, /information_schema\.columns/);
  assert.match(sink.text, /\$1/);
  assert.doesNotMatch(sink.text, /DROP/i, "the table name must never be concatenated into the SQL text");
  assert.deepEqual(sink.params, ["customers; DROP TABLE x"]);
  assert.equal(r!.table, "customers; DROP TABLE x");
});

test("describeTable returns null when no columns come back (unknown table)", async () => {
  const backend = new PgBackend({ poolFactory: async () => fakePool({ query: async () => ({ rows: [] }) }) });
  const r = await backend.describeTable("nope", ctx);
  assert.equal(r, null);
});

test("runQuery executes the already-guarded SQL verbatim, with no extra interpolation", async () => {
  const sink: any = {};
  const backend = new PgBackend({
    poolFactory: async () =>
      fakePool({
        query: async (text, params) => {
          sink.text = text;
          sink.params = params;
          return { rows: [{ region: "north", n: 12 }] };
        },
      }),
  });
  const r = await backend.runQuery("SELECT region, count(*) AS n FROM customers GROUP BY region LIMIT 1000", ctx);
  assert.deepEqual(r, [{ region: "north", n: 12 }]);
  assert.equal(sink.text, "SELECT region, count(*) AS n FROM customers GROUP BY region LIMIT 1000");
  assert.equal(sink.params, undefined);
});

test("a missing credential fails closed with PgCredentialMissing (E_CONN_NEEDS_CONNECTION)", async () => {
  const backend = new PgBackend({ poolFactory: async () => fakePool({ query: async () => ({ rows: [] }) }) });
  await assert.rejects(
    () => backend.listTables({ ...ctx, credential: "" }),
    (err: unknown) => err instanceof PgCredentialMissing && (err as PgCredentialMissing).code === "E_CONN_NEEDS_CONNECTION",
  );
});

test("pools are cached per credential (one pool per distinct credential)", async () => {
  let factoryCalls = 0;
  const backend = new PgBackend({
    poolFactory: async () => {
      factoryCalls += 1;
      return fakePool({ query: async () => ({ rows: [] }) });
    },
  });
  await backend.listTables(ctx);
  await backend.listTables(ctx);
  await backend.describeTable("customers", ctx);
  assert.equal(factoryCalls, 1, "the same credential must reuse one pool, not open a new one per call");
});
