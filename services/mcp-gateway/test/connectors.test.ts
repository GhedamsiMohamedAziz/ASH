// Browser + Database connector wiring tests (§13, §14, §17.6). Proves buildGateway() now mounts the
// REAL Browser and Database MCP surfaces through the SAME gateway path github.* uses: StubFetch/StubDb
// offline by default (keyless), the full auth chain (TASK_JWT verify → allowed_tools → approval →
// taint → DLP → audit) runs unchanged, and the newly-registered tools participate in the taint/egress
// reclassification (§17.6). MCP tools/list gating and the register() metadata guard are covered too.
// Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildGateway, createGatewayServer } from "../src/server.ts";
import { McpGateway } from "../src/gateway.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";
const ALLOW = () => ["example.com"]; // SSRF allow-list so the offline browse path can reach a host

// A TASK JWT valid against real wall-clock (buildGateway uses requireExp + real time, no `now`).
function taskJwt(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: "usr_1", org_id: "org_1",
    iss: "olma-prompt-layer", aud: "olma-mcp-gateway",
    iat: now - 5, exp: now + 3600,
    allowed_tools: [], approval_tools: [],
    ...overrides,
  }, SECRET);
}

// Build a gateway with the browser allow-list wired (StubFetch/StubDb defaults → offline/keyless),
// guarding GITHUB_TOKEN so the github path also stays on its stub. Returns the gateway.
function connectorGateway() {
  return buildGateway({ browserAllowList: ALLOW });
}

// GITHUB_TOKEN must be unset for buildGateway to serve stubs; guard it around each test.
function withEnv(fn: () => Promise<void>) {
  return async () => {
    const prev = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
    }
  };
}

// ---------------------------------------------------------------- registration + round-trip
test("browser.read_page round-trips via StubFetch through the gateway (audit row produced)", withEnv(async () => {
  const gw = connectorGateway();
  const before = gw.audit.length;
  const r = await gw.call({
    tool: "browser.read_page",
    args: { url: "https://example.com/hello" },
    taskJwt: taskJwt({ allowed_tools: ["browser.read_page"] }),
  });
  assert.equal(r.status, "ok");
  assert.match(String(r.result), /Stub page for example\.com/); // deterministic StubFetch output
  assert.equal(gw.audit.length, before + 1);
  assert.equal(gw.audit.at(-1)?.tool, "browser.read_page");
  assert.equal(gw.audit.at(-1)?.status, "ok");
}));

test("database.query round-trips via StubDb through the gateway (audit row produced)", withEnv(async () => {
  const gw = connectorGateway();
  const before = gw.audit.length;
  const r = await gw.call({
    tool: "database.query",
    args: { sql: "SELECT region, count(*) AS n FROM customers GROUP BY region" },
    taskJwt: taskJwt({ allowed_tools: ["database.query"] }),
  });
  assert.equal(r.status, "ok");
  assert.match(String(r.result), /"region":"north"/); // deterministic StubDb rows
  assert.equal(gw.audit.at(-1)?.tool, "database.query");
  assert.equal(gw.audit.at(-1)?.status, "ok");
}));

test("database.list_tables and database.describe round-trip through the gateway", withEnv(async () => {
  const gw = connectorGateway();
  const jwt = taskJwt({ allowed_tools: ["database.list_tables", "database.describe"] });
  const list = await gw.call({ tool: "database.list_tables", args: {}, taskJwt: jwt });
  assert.equal(list.status, "ok");
  assert.match(String(list.result), /customers/);
  const desc = await gw.call({ tool: "database.describe", args: { table: "orders" }, taskJwt: jwt });
  assert.equal(desc.status, "ok");
  assert.match(String(desc.result), /customer_id/);
}));

test("a token NOT allowing a connector tool is denied (E_PERM_TOOL_DENIED)", withEnv(async () => {
  const gw = connectorGateway();
  // Token allows only browser.read_page; database.query / browser.fetch are not in allowed_tools.
  const jwt = taskJwt({ allowed_tools: ["browser.read_page"] });
  const db = await gw.call({ tool: "database.query", args: { sql: "SELECT 1" }, taskJwt: jwt });
  assert.equal(db.status, "denied");
  assert.equal(db.code, "E_PERM_TOOL_DENIED");
  const fetchr = await gw.call({ tool: "browser.fetch", args: { url: "https://example.com" }, taskJwt: jwt });
  assert.equal(fetchr.status, "denied");
  assert.equal(fetchr.code, "E_PERM_TOOL_DENIED");
}));

// ---------------------------------------------------------------- taint reclassification (§17.6)
test("browser.read_page taints the turn; a later browser.fetch is forced to approval (interactive)", withEnv(async () => {
  const gw = connectorGateway();
  const jwt = taskJwt({
    task_id: "task_browser_taint",
    allowed_tools: ["browser.read_page", "browser.fetch"],
  });
  // 1. read_page ingests untrusted web content → taints the task (non-empty stringified result).
  const read = await gw.call({ tool: "browser.read_page", args: { url: "https://example.com/a" }, taskJwt: jwt });
  assert.equal(read.status, "ok");
  // 2. browser.fetch (egressClass public) on the now-tainted turn is reclassified BEFORE it runs —
  //    forced to human approval even though policy allows it. The taint gate fires ahead of the SSRF
  //    validator, so the URL is never even fetched.
  const fetchr = await gw.call({ tool: "browser.fetch", args: { url: "https://example.com/b" }, taskJwt: jwt });
  assert.equal(fetchr.status, "needs_approval");
  assert.equal(fetchr.code, "E_GUARD_TAINTED_EGRESS");
}));

test("tainted SCHEDULED run: browser.fetch fails outright (E_GUARD_TAINTED_EGRESS)", withEnv(async () => {
  const gw = connectorGateway();
  const jwt = taskJwt({
    task_id: "task_browser_taint_sched",
    origin: "scheduled",
    allowed_tools: ["browser.read_page", "browser.fetch"],
  });
  await gw.call({ tool: "browser.read_page", args: { url: "https://example.com/a" }, taskJwt: jwt }); // taints
  const fetchr = await gw.call({ tool: "browser.fetch", args: { url: "https://example.com/b" }, taskJwt: jwt });
  assert.equal(fetchr.status, "denied");
  assert.equal(fetchr.code, "E_GUARD_TAINTED_EGRESS");
}));

test("database.query (egress none) does NOT gate a later read even after tainting", withEnv(async () => {
  const gw = connectorGateway();
  const jwt = taskJwt({ task_id: "task_db_none", allowed_tools: ["database.query"] });
  const first = await gw.call({ tool: "database.query", args: { sql: "SELECT 1" }, taskJwt: jwt });
  assert.equal(first.status, "ok"); // tainted the turn (rows are untrusted) …
  const second = await gw.call({ tool: "database.query", args: { sql: "SELECT 2" }, taskJwt: jwt });
  assert.equal(second.status, "ok"); // … but egressClass "none" is never gated by taint
}));

// ---------------------------------------------------------------- register() metadata guard intact
test("register() still throws for a connector tool missing taint metadata (§17.6.2)", () => {
  const gw = new McpGateway(SECRET, {});
  // @ts-expect-error — missing meta must throw at registration, not run unclassified
  assert.throws(() => gw.register("browser.read_page", async () => "y"), /egress metadata/);
});

// ---------------------------------------------------------------- MCP tools/list catalog gating
async function listen(server: ReturnType<typeof createGatewayServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
}

async function toolsList(server: ReturnType<typeof createGatewayServer>, jwt: string): Promise<string[]> {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const json = (await res.json()) as any;
  return (json.result?.tools ?? []).map((t: any) => t.name).sort();
}

test("MCP tools/list surfaces browser/database tools ONLY when the token allows them", withEnv(async () => {
  const gw = connectorGateway();
  const server = createGatewayServer(gw);
  await listen(server);
  try {
    // A token allowing exactly one browser + one database tool lists exactly those (github hidden).
    const names = await toolsList(server, taskJwt({ allowed_tools: ["browser.read_page", "database.query"] }));
    assert.deepEqual(names, ["browser_read_page", "database_query"]);

    // A token with no connector tools surfaces none of them (catalog never leaks).
    const ghOnly = await toolsList(server, taskJwt({ allowed_tools: ["github.search"] }));
    assert.deepEqual(ghOnly, ["github_search"]);

    // The full connector set lists under a broad token.
    const all = await toolsList(server, taskJwt({
      allowed_tools: ["browser.read_page", "browser.fetch", "database.query", "database.list_tables", "database.describe"],
    }));
    assert.deepEqual(all, [
      "browser_fetch", "browser_read_page", "database_describe", "database_list_tables", "database_query",
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}));
