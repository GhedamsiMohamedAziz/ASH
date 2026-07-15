// Connector store tests (§13.2, AX-038). Proves the REAL credential store is wired end-to-end:
// POST /v1/connect seals a per-user token in the Vault, GET /v1/connections reports it, and the
// very next github.* tool call for that user resolves the STORED token (not env) onto the egress
// Authorization header — exercised KEYLESSLY via an injected mock fetch. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { buildGateway, createGatewayServer } from "../src/server.ts";
import { RestBackend } from "../../mcp-servers/github/src/rest.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";

const SECRET = "dev-task-jwt-secret";
const USER = "usr_connect";
const STORED = "ghp_" + "s".repeat(36); // the per-user token stored via /v1/connect

function taskJwt(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return sign({
    sub, org_id: "org_1",
    iss: "olma-prompt-layer", aud: "olma-mcp-gateway",
    iat: now - 5, exp: now + 3600,
    allowed_tools: ["github.create_pr"], approval_tools: [],
  }, SECRET);
}

// Minimal HTTP client against a listening server; returns { status, json }.
async function req(server: ReturnType<typeof createGatewayServer>, method: string, path: string, body?: unknown) {
  const { port } = server.address() as AddressInfo;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as any };
}

async function listen(server: ReturnType<typeof createGatewayServer>): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
}

test("POST /v1/connect stores the token; GET /v1/connections lists the provider for that user", async () => {
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const server = createGatewayServer();
  await listen(server);
  try {
    const c = await req(server, "POST", "/v1/connect", { userId: USER, provider: "github", token: STORED });
    assert.equal(c.status, 200);
    assert.deepEqual(c.json, { connected: true, provider: "github" });

    const list = await req(server, "GET", `/v1/connections?userId=${USER}`);
    assert.equal(list.status, 200);
    assert.ok(
      list.json.connections.some((x: any) => x.provider === "github" && x.connected === true),
      "github should show up as connected for the user that just connected",
    );
  } finally {
    server.close();
    if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
  }
});

test("a github tool call for the connected user injects the STORED token (not env) into Authorization", async () => {
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN; // prove it is the STORED per-user token, never an ambient env token
  let seenAuth = "";
  const fakeFetch = (async (_url: string, init: any) => {
    seenAuth = init.headers.authorization;
    return {
      ok: true, status: 201,
      text: async () => JSON.stringify({
        number: 7, title: "t", html_url: "https://github.com/acme/x/pull/7", state: "open",
      }),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  // Same module-level resolver backs both the HTTP connect route and the gateway's injection.
  const gw = buildGateway({ githubBackend: new RestBackend({ fetchImpl: fakeFetch }) });
  const server = createGatewayServer(gw);
  await listen(server);
  try {
    const c = await req(server, "POST", "/v1/connect", { userId: USER, provider: "github", token: STORED });
    assert.equal(c.status, 200);

    const r = await gw.call({
      tool: "github.create_pr",
      args: { repo: "acme/x", head: "fix/login", base: "main", title: "t" },
      taskJwt: taskJwt(USER),
    });
    assert.equal(r.status, "ok");
    assert.equal(seenAuth, `Bearer ${STORED}`);         // the Vault-stored per-user token reached egress
    assert.match(JSON.stringify(r.result), /pull\/7/);  // real API response surfaced
  } finally {
    server.close();
    if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
  }
});

test("a user with no connection fails closed (E_CONN_NEEDS_CONNECTION) on a real backend", async () => {
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  const fakeFetch = (async () => { throw new Error("must not reach network"); }) as unknown as typeof fetch;
  const gw = buildGateway({ githubBackend: new RestBackend({ fetchImpl: fakeFetch }) });
  try {
    const r = await gw.call({
      tool: "github.create_pr",
      args: { repo: "acme/x", head: "fix", base: "main", title: "t" },
      taskJwt: taskJwt("usr_never_connected"),
    });
    assert.equal(r.status, "denied");
    assert.equal(r.code, "E_CONN_NEEDS_CONNECTION");
  } finally {
    if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev;
  }
});
