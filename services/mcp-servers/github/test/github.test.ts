// AX-018 GitHub MCP tests. Run: node --test test/github.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubMcp, StubBackend, trailerFor } from "../src/github.ts";
import { McpGateway } from "../../../mcp-gateway/src/gateway.ts";
import { sign } from "../../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";
const ctx = { userId: "usr_1", orgId: "org_1", credential: "vault:stub" };

function jwtWith(allowed: string[], approval: string[] = []): string {
  return sign(
    { sub: "usr_1", org_id: "org_1", iat: 1000, exp: 2000,
      allowed_tools: allowed, approval_tools: approval },
    SECRET,
  );
}

// ---------------------------------------------------------------- unit
test("search returns matching paths", async () => {
  const t = new GithubMcp().tools();
  const r = (await t["github.search"]({ query: "login" }, ctx)) as string[];
  assert.deepEqual(r, ["src/login.ts", "test/login.test.ts"]);
});

test("create_pr returns a PR with a requested-by trailer (team mode §3.2)", async () => {
  const t = new GithubMcp().tools();
  const pr = (await t["github.create_pr"](
    { repo: "acme/checkout", head: "fix/login", title: "fix login" }, ctx)) as any;
  assert.equal(pr.number, 42);
  assert.match(pr.url, /acme\/checkout\/pull\/42/);
  assert.match(pr.trailer, /Requested-by: usr_1/);
});

test("list_issues returns open issues", async () => {
  const t = new GithubMcp().tools();
  const issues = (await t["github.list_issues"]({ repo: "acme/x" }, ctx)) as any[];
  assert.equal(issues.length, 2);
});

test("trailer names the requester and co-author", () => {
  assert.match(trailerFor(ctx), /Requested-by: usr_1/);
  assert.match(trailerFor(ctx), /Co-authored-by:/);
});

// ---------------------------------------------------------------- integration through the gateway
test("gateway routes an allowed github tool to the MCP backend", async () => {
  const gw = new McpGateway(SECRET, { now: 1500 });
  const mcp = new GithubMcp(new StubBackend());
  // register each github tool with the gateway (credential injected by the gateway)
  for (const [name, fn] of Object.entries(mcp.tools())) {
    gw.register(name, async (args, gctx) => JSON.stringify(await fn(args, gctx)));
  }
  const r = await gw.call({
    tool: "github.create_pr",
    args: { repo: "acme/checkout", head: "fix/login", title: "fix login" },
    taskJwt: jwtWith(["github.create_pr"]),
  });
  assert.equal(r.status, "ok");
  const pr = JSON.parse(r.result!);
  assert.equal(pr.number, 42);
  assert.equal(gw.audit.at(-1)?.status, "ok");
  assert.equal(gw.audit.at(-1)?.tool, "github.create_pr");
});

test("gateway blocks a github tool absent from the TASK JWT (defense in depth)", async () => {
  const gw = new McpGateway(SECRET, { now: 1500 });
  const mcp = new GithubMcp();
  for (const [name, fn] of Object.entries(mcp.tools())) {
    gw.register(name, async (args, gctx) => JSON.stringify(await fn(args, gctx)));
  }
  // token only allows search; merge must be denied even though the tool exists
  const r = await gw.call({
    tool: "github.merge_pr",
    args: { repo: "acme/x", number: 42 },
    taskJwt: jwtWith(["github.search"]),
  });
  assert.equal(r.status, "denied");
  assert.equal(r.code, "E_PERM_TOOL_DENIED");
});

test("gateway gates merge_pr when it is an approval tool", async () => {
  const gw = new McpGateway(SECRET, { now: 1500 });
  const mcp = new GithubMcp();
  for (const [name, fn] of Object.entries(mcp.tools())) {
    gw.register(name, async (args, gctx) => JSON.stringify(await fn(args, gctx)));
  }
  const r = await gw.call({
    tool: "github.merge_pr",
    args: { repo: "acme/x", number: 42 },
    taskJwt: jwtWith(["github.merge_pr"], ["github.merge_pr"]),
  });
  assert.equal(r.status, "needs_approval");
});
