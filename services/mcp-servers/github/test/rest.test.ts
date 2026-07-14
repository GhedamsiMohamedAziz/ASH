// Real GitHub backend tests — drive RestBackend with a mock fetch (no network, no token).
// Proves the tool surface is unchanged AND that every GitHub failure maps to a named §21
// error instead of a silent success. Run: node --test test/rest.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { GithubMcp } from "../src/github.ts";
import { RestBackend, GithubApiError } from "../src/rest.ts";

const ctx = { userId: "usr_1", orgId: "org_1", credential: "ghp_fake_token" };

// A mock fetch that returns a canned (status, body) and records the request it received.
function mockFetch(status: number, body: unknown, sink?: any): typeof fetch {
  return (async (url: string, init: any) => {
    if (sink) { sink.url = url; sink.init = init; }
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { ok: status >= 200 && status < 300, status, text: async () => text } as any;
  }) as unknown as typeof fetch;
}

test("create_pr hits the real endpoint and maps the response", async () => {
  const sink: any = {};
  const backend = new RestBackend({ fetchImpl: mockFetch(201, {
    number: 42, title: "fix login", html_url: "https://github.com/acme/x/pull/42", state: "open",
  }, sink) });
  const pr = (await new GithubMcp(backend).tools()["github.create_pr"](
    { repo: "acme/x", head: "fix/login", base: "main", title: "fix login" }, ctx)) as any;
  assert.equal(pr.number, 42);
  assert.equal(pr.url, "https://github.com/acme/x/pull/42");
  assert.match(sink.url, /\/repos\/acme\/x\/pulls$/);
  assert.equal(sink.init.method, "POST");
  assert.equal(sink.init.headers.authorization, "Bearer ghp_fake_token"); // token from ctx, not source
});

test("readFile base64-decodes real GitHub contents", async () => {
  const content = Buffer.from("export const real = true;\n", "utf8").toString("base64");
  const backend = new RestBackend({ fetchImpl: mockFetch(200, { encoding: "base64", content }) });
  const r = await backend.readFile("acme/x", "src/a.ts", ctx);
  assert.equal(r, "export const real = true;\n");
});

test("listIssues drops PRs (they carry pull_request)", async () => {
  const backend = new RestBackend({ fetchImpl: mockFetch(200, [
    { number: 12, title: "flaky login test" },
    { number: 13, title: "a PR not an issue", pull_request: { url: "x" } },
  ]) });
  const r = await backend.listIssues("acme/x", ctx);
  assert.deepEqual(r, [{ number: 12, title: "flaky login test" }]);
});

// ---- the failure map: every status becomes a named taxonomy error, never a silent 200 ----
const cases: Array<[number, string]> = [
  [401, "E_CONN_TOKEN_EXPIRED"],
  [403, "E_RATE_LIMITED"],
  [429, "E_RATE_LIMITED"],
  [404, "E_CONN_NEEDS_CONNECTION"],
  [409, "E_TOOL_CONFLICT"],
  [500, "E_TOOL_UPSTREAM_ERROR"],
];
for (const [status, code] of cases) {
  test(`GitHub ${status} -> ${code}`, async () => {
    const backend = new RestBackend({ fetchImpl: mockFetch(status, { message: "boom" }) });
    await assert.rejects(
      () => backend.searchCode("q", ctx),
      (e: any) => e instanceof GithubApiError && e.code === code && e.status === status,
    );
  });
}

test("missing credential is a named error, not a crash", async () => {
  const backend = new RestBackend({ fetchImpl: mockFetch(200, {}) });
  const savedEnv = process.env.GITHUB_TOKEN;
  const savedFlag = process.env.OLMA_STANDALONE_DEMO;
  delete process.env.GITHUB_TOKEN;
  delete process.env.OLMA_STANDALONE_DEMO;
  try {
    await assert.rejects(
      () => backend.searchCode("q", { userId: "u", orgId: "o", credential: "" }),
      (e: any) => e.code === "E_CONN_NEEDS_CONNECTION",
    );
  } finally {
    if (savedEnv !== undefined) process.env.GITHUB_TOKEN = savedEnv;
    if (savedFlag !== undefined) process.env.OLMA_STANDALONE_DEMO = savedFlag;
  }
});

test("env token used ONLY behind OLMA_STANDALONE_DEMO=1 (no silent ambient escalation)", async () => {
  const savedEnv = process.env.GITHUB_TOKEN;
  const savedFlag = process.env.OLMA_STANDALONE_DEMO;
  process.env.GITHUB_TOKEN = "ghp_ambient";
  try {
    // Flag OFF: an empty credential must fail closed even with GITHUB_TOKEN present.
    delete process.env.OLMA_STANDALONE_DEMO;
    let backend = new RestBackend({ fetchImpl: mockFetch(200, { items: [] }) });
    await assert.rejects(
      () => backend.searchCode("q", { userId: "u", orgId: "o", credential: "" }),
      (e: any) => e.code === "E_CONN_NEEDS_CONNECTION",
    );
    // Flag ON: the demo may use the ambient token.
    process.env.OLMA_STANDALONE_DEMO = "1";
    const sink: any = {};
    backend = new RestBackend({ fetchImpl: mockFetch(200, { items: [] }, sink) });
    await backend.searchCode("q", { userId: "u", orgId: "o", credential: "" });
    assert.equal(sink.init.headers.authorization, "Bearer ghp_ambient");
  } finally {
    if (savedEnv !== undefined) process.env.GITHUB_TOKEN = savedEnv; else delete process.env.GITHUB_TOKEN;
    if (savedFlag !== undefined) process.env.OLMA_STANDALONE_DEMO = savedFlag; else delete process.env.OLMA_STANDALONE_DEMO;
  }
});

test("invalid repo is rejected before any request (path-injection guard)", async () => {
  const backend = new RestBackend({ fetchImpl: mockFetch(200, {}) });
  await assert.rejects(
    () => backend.readFile("victim/private/contents/secret?x=", "a", { userId: "u", orgId: "o", credential: "t" }),
    (e: any) => e.code === "E_VALIDATION",
  );
});
