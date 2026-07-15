// AX-017 gateway tests. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { McpGateway } from "../src/gateway.ts";
import { sign, loadJwks, verifyES256 } from "../../../packages/shared-ts/src/jwt.ts";
import { scrub } from "../src/dlp.ts";
import { InMemoryTaint, RedisTaint, taintStoreFromEnv } from "../src/taint.ts";

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

const M_READ = { ingestsUntrusted: true, egressClass: "none" as const };   // ingests untrusted content
const M_EGRESS = { ingestsUntrusted: false, egressClass: "public" as const }; // publishes out
const M_NONE = { ingestsUntrusted: false, egressClass: "none" as const };

function newGateway(taint?: any) {
  const gw = new McpGateway(SECRET, { iss: "olma-prompt-layer", aud: "olma-mcp-gateway", now: 1500 },
    undefined, taint);
  gw.register("github.search", async () => "found 3 results", M_READ);
  gw.register("github.create_pr", async (_a, ctx) => `PR opened with credential ${ctx.credential}`, M_EGRESS);
  gw.register("github.merge_pr", async () => "merged", M_EGRESS);
  gw.register("github.leak", async () => "token ghp_" + "a".repeat(36), M_NONE);
  return gw;
}

test("handler error reason is DLP-scrubbed (not just success output)", async () => {
  const gw = new McpGateway(SECRET, { iss: "olma-prompt-layer", aud: "olma-mcp-gateway", now: 1500 });
  const secret = "Bearer ghp_" + "a".repeat(36);
  gw.register("github.search", async () => { throw new Error(`upstream said: ${secret}`); }, M_READ);
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
  gw.register("github.search", async () => "x", M_READ);
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

// ---------------------------------------------------------------- taint tracking (§17.6)
test("register REQUIRES egress metadata (invariant #4)", () => {
  const gw = new McpGateway(SECRET, {});
  // @ts-expect-error — missing meta must throw at registration, not run unclassified
  assert.throws(() => gw.register("x.tool", async () => "y"), /egress metadata/);
});

test("tainted interactive turn forces public-egress tool to approval (§17.6.3)", async () => {
  const gw = newGateway();
  const jwt = taskJwt({ task_id: "task_taint_1" });
  // 1. an ingests-untrusted tool returns a non-empty result → taints the task
  const s = await gw.call({ tool: "github.search", args: {}, taskJwt: jwt });
  assert.equal(s.status, "ok");
  // 2. a public-egress tool now needs approval — even though policy allows it
  const pr = await gw.call({ tool: "github.create_pr", args: {}, taskJwt: jwt });
  assert.equal(pr.status, "needs_approval");
  assert.equal(pr.code, "E_GUARD_TAINTED_EGRESS");
});

test("tainted SCHEDULED run fails public egress outright (E_GUARD_TAINTED_EGRESS)", async () => {
  const gw = newGateway();
  const jwt = taskJwt({ task_id: "task_taint_2", origin: "scheduled" });
  await gw.call({ tool: "github.search", args: {}, taskJwt: jwt });           // taints
  const pr = await gw.call({ tool: "github.create_pr", args: {}, taskJwt: jwt });
  assert.equal(pr.status, "denied");
  assert.equal(pr.code, "E_GUARD_TAINTED_EGRESS");
});

test("clean turn: public egress runs normally when no untrusted content ingested", async () => {
  const gw = newGateway();
  const jwt = taskJwt({ task_id: "task_clean" });
  const pr = await gw.call({ tool: "github.create_pr", args: {}, taskJwt: jwt });
  assert.equal(pr.status, "ok"); // never touched an ingests_untrusted tool → not tainted
});

test("taint is monotonic — a later clean tool does not un-taint the turn", async () => {
  const taint = new InMemoryTaint();
  const gw = newGateway(taint);
  const jwt = taskJwt({ task_id: "task_mono" });
  await gw.call({ tool: "github.search", args: {}, taskJwt: jwt });   // taints
  await gw.call({ tool: "github.leak", args: {}, taskJwt: jwt });     // egress none, clean
  assert.equal(taint.isTainted("task_mono"), true);                  // still tainted
  const pr = await gw.call({ tool: "github.create_pr", args: {}, taskJwt: jwt });
  assert.equal(pr.code, "E_GUARD_TAINTED_EGRESS");
});

test("taintStoreFromEnv: REDIS_URL unset -> InMemoryTaint (offline/keyless default, ADR-012)", () => {
  const store = taintStoreFromEnv({} as NodeJS.ProcessEnv);
  assert.ok(store instanceof InMemoryTaint);
});

test("taintStoreFromEnv: REDIS_URL set -> RedisTaint (shared with prompt-layer, §4.4)", () => {
  const store = taintStoreFromEnv({ REDIS_URL: "redis://localhost:6379" } as NodeJS.ProcessEnv);
  assert.ok(store instanceof RedisTaint);
});

// ---------------------------------------------------------------- ES256 TASK JWT seam (§13.4)
// End-to-end: the gateway verifies a Python-minted ES256 token (committed vector) via the
// JWKS-backed verifyToken strategy — the same path server.ts wires when TASK_JWT_ALG=ES256.
const FX = (n: string) => new URL(`../../../packages/shared-ts/test/fixtures/${n}`, import.meta.url).pathname;
const ES_JWKS = loadJwks(FX("task-jwt-es256.jwks.test.json"));
const ES_VECTOR = JSON.parse(readFileSync(FX("task-jwt-es256.vector.test.json"), "utf8"));

function es256Gateway() {
  const opts = { iss: "olma-prompt-layer", aud: "olma-mcp-gateway", requireExp: true, now: ES_VECTOR.now };
  const gw = new McpGateway(SECRET, opts, undefined, undefined,
    (token: string) => verifyES256(token, ES_JWKS, opts));
  gw.register("github.search", async () => "found 3 results", M_READ);
  gw.register("github.create_pr", async (_a, ctx) => `PR opened with credential ${ctx.credential}`, M_EGRESS);
  return gw;
}

test("ES256: gateway accepts a Python-minted TASK JWT (cross-language round-trip)", async () => {
  const gw = es256Gateway();
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: ES_VECTOR.token });
  assert.equal(r.status, "ok");
});

test("ES256: gateway denies a tampered ES256 token (fail-closed)", async () => {
  const gw = es256Gateway();
  const tampered = ES_VECTOR.token.slice(0, -4) + (ES_VECTOR.token.endsWith("AAAA") ? "BBBB" : "AAAA");
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: tampered });
  assert.equal(r.status, "denied");
  assert.equal(r.code, "E_AUTH_INVALID_TOKEN");
});

test("ES256: gateway denies an HS256 token when ES256 is configured (no silent fallback)", async () => {
  const gw = es256Gateway();
  // A perfectly valid HS256 token must NOT verify under the ES256 verifier.
  const hs = taskJwt({ iat: ES_VECTOR.now, exp: 9999999999, allowed_tools: ["github.search"] });
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: hs });
  assert.equal(r.status, "denied");
  assert.equal(r.code, "E_AUTH_INVALID_TOKEN");
});
