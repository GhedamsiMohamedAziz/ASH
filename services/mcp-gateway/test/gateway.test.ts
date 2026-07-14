// AX-017 gateway tests. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { McpGateway } from "../src/gateway.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";
import { scrub } from "../src/dlp.ts";

const SECRET = "dev-task-jwt-secret";

function taskJwt(overrides: Record<string, unknown> = {}): string {
  return sign(
    {
      sub: "usr_1",
      org_id: "org_1",
      iss: "olma-prompt-layer",
      aud: "olma-mcp-gateway",
      iat: 1000,
      exp: 2000,
      allowed_tools: ["github.search", "github.create_pr", "github.merge_pr"],
      approval_tools: ["github.merge_pr"],
      ...overrides,
    },
    SECRET,
  );
}

function newGateway() {
  const gw = new McpGateway(SECRET, { iss: "olma-prompt-layer", aud: "olma-mcp-gateway", now: 1500 });
  gw.register("github.search", async () => "found 3 results");
  gw.register("github.create_pr", async (_a, ctx) => `PR opened with credential ${ctx.credential}`);
  gw.register("github.merge_pr", async () => "merged");
  gw.register("github.leak", async () => "token ghp_" + "a".repeat(36));
  return gw;
}

test("handler error reason is DLP-scrubbed (not just success output)", async () => {
  const gw = new McpGateway(SECRET, { iss: "olma-prompt-layer", aud: "olma-mcp-gateway", now: 1500 });
  const secret = "Bearer ghp_" + "a".repeat(36);
  gw.register("github.search", async () => { throw new Error(`upstream said: ${secret}`); });
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: taskJwt() });
  assert.equal(r.status, "error");
  assert.ok(!r.reason!.includes(secret), "raw token must not appear in the returned reason");
  assert.match(r.reason!, /\[REDACTED:/);
  // and the audit row is scrubbed too
  assert.ok(!gw.audit.at(-1)!.reason!.includes(secret));
});

test("allowed tool executes and is audited ok", async () => {
  const gw = newGateway();
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: taskJwt() });
  assert.equal(r.status, "ok");
  assert.equal(r.result, "found 3 results");
  assert.equal(gw.audit.at(-1)?.status, "ok");
  assert.equal(gw.audit.at(-1)?.tool, "github.search");
});

test("credential is injected, never in the token", async () => {
  const gw = newGateway();
  const r = await gw.call({ tool: "github.create_pr", args: {}, taskJwt: taskJwt() });
  assert.equal(r.status, "ok");
  assert.match(r.result!, /vault:stub/); // handler saw an injected credential
});

test("tool not in allowed_tools is denied (defense in depth)", async () => {
  const gw = newGateway();
  // github.search allowed, but ask for database.write which is NOT in the claim
  const r = await gw.call({ tool: "database.write", args: {}, taskJwt: taskJwt() });
  assert.equal(r.status, "denied");
  assert.equal(r.code, "E_PERM_TOOL_DENIED");
});

test("approval tool is gated, not executed inline", async () => {
  const gw = newGateway();
  const r = await gw.call({ tool: "github.merge_pr", args: {}, taskJwt: taskJwt() });
  assert.equal(r.status, "needs_approval");
  // must NOT have run the merge handler
  assert.equal(gw.audit.at(-1)?.status, "needs_approval");
});

test("invalid/forged token is denied fail-closed", async () => {
  const gw = newGateway();
  const forged = taskJwt() + "tamper";
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: forged });
  assert.equal(r.status, "denied");
  assert.equal(r.code, "E_AUTH_INVALID_TOKEN");
});

test("expired token is denied", async () => {
  const gw = new McpGateway(SECRET, { now: 9999 }); // past exp=2000
  gw.register("github.search", async () => "x");
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: taskJwt() });
  assert.equal(r.status, "denied");
});

test("DLP scrubs secrets from tool results", async () => {
  const gw = newGateway();
  const jwt = taskJwt({ allowed_tools: ["github.leak"], approval_tools: [] });
  const r = await gw.call({ tool: "github.leak", args: {}, taskJwt: jwt });
  assert.equal(r.status, "ok");
  assert.doesNotMatch(r.result!, /ghp_[A-Za-z0-9]{36}/); // secret masked
  assert.match(r.result!, /REDACTED:github_token/);
  assert.deepEqual(r.redacted, ["github_token"]);
});

test("on_behalf_of drives the audited subject (team mode)", async () => {
  const gw = newGateway();
  const jwt = taskJwt({ sub: "agent-org@org_1", on_behalf_of: "usr_mehdi" });
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: jwt });
  assert.equal(r.status, "ok");
  assert.equal(gw.audit.at(-1)?.on_behalf_of, "usr_mehdi");
  assert.equal(gw.audit.at(-1)?.actor, "agent-org@org_1");
});

test("dlp unit: multiple secret shapes", () => {
  const { text, redacted } = scrub("key AKIA" + "A".repeat(16) + " and Bearer " + "x".repeat(25));
  assert.match(text, /REDACTED:aws_access_key/);
  assert.ok(redacted.includes("aws_access_key"));
  assert.ok(redacted.includes("bearer"));
});
