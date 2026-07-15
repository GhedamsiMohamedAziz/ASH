// Server wiring tests (§13, ADR-012/ADR-017-adjacent). Proves buildGateway() mounts the REAL
// GitHub MCP surface — StubBackend offline by default, and RestBackend the moment GITHUB_TOKEN is
// set, with the token injected through the credential resolver (Vault stand-in), never ambient.
// The RestBackend path is exercised KEYLESSLY via an injected fetch. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildGateway } from "../src/server.ts";
import { RestBackend } from "../../mcp-servers/github/src/rest.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";

// A TASK JWT valid against real wall-clock (buildGateway uses requireExp + real time, no `now`).
function taskJwt(overrides: Record<string, unknown> = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub: "usr_1", org_id: "org_1",
    iss: "olma-prompt-layer", aud: "olma-mcp-gateway",
    iat: now - 5, exp: now + 3600,
    allowed_tools: ["github.search", "github.create_pr", "github.merge_pr"],
    approval_tools: [], // nothing gated here → create_pr executes without approval
    ...overrides,
  }, SECRET);
}

test("default (no GITHUB_TOKEN): StubBackend serves github.search offline", async () => {
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const gw = buildGateway();
    const r = await gw.call({ tool: "github.search", args: { query: "login" }, taskJwt: taskJwt() });
    assert.equal(r.status, "ok");
    assert.match(JSON.stringify(r.result), /src\/login\.ts/); // deterministic stub output
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
  }
});

test("default: github.create_pr goes through GithubMcp (PR object + requested-by trailer)", async () => {
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    const gw = buildGateway();
    const r = await gw.call({
      tool: "github.create_pr",
      args: { repo: "acme/x", head: "fix/login", base: "main", title: "t" },
      taskJwt: taskJwt(),
    });
    assert.equal(r.status, "ok");
    assert.match(JSON.stringify(r.result), /Requested-by: usr_1/); // trailer names the human (§3.2)
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
  }
});

test("GITHUB_TOKEN set: RestBackend makes a REAL call with the injected token (keyless via mock fetch)", async () => {
  const prev = process.env.GITHUB_TOKEN;
  const TOKEN = "ghp_" + "t".repeat(36);
  process.env.GITHUB_TOKEN = TOKEN;
  let seenUrl = "";
  let seenAuth = "";
  const fakeFetch = (async (url: string, init: any) => {
    seenUrl = String(url);
    seenAuth = init.headers.authorization;
    return {
      ok: true, status: 201,
      text: async () => JSON.stringify({
        number: 42, title: "t", html_url: "https://github.com/acme/x/pull/42", state: "open",
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  try {
    // Inject a fetch-mocked RestBackend: the env token still flows through resolveCredential.
    const gw = buildGateway({ githubBackend: new RestBackend({ fetchImpl: fakeFetch }) });
    const r = await gw.call({
      tool: "github.create_pr",
      args: { repo: "acme/x", head: "fix/login", base: "main", title: "t" },
      taskJwt: taskJwt(),
    });
    assert.equal(r.status, "ok");
    assert.match(seenUrl, /\/repos\/acme\/x\/pulls$/);          // the real REST endpoint
    assert.equal(seenAuth, `Bearer ${TOKEN}`);                   // Vault-injected token reached egress
    assert.match(JSON.stringify(r.result), /pull\/42/);          // real API response surfaced
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
  }
});
