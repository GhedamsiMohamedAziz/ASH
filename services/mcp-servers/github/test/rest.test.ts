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

// ─────────────────────────────────────────────────── createOrUpdateFile (real commit, write) ──
// A method-aware mock: the GET resolves the current sha (or 404 = new file), the PUT does the write.
function writeMock(getStatus: number, getBody: unknown, putBody: unknown, sink: any): typeof fetch {
  return (async (url: string, init: any) => {
    (sink.calls ??= []).push({ url, method: init?.method, body: init?.body });
    if (init?.method === "PUT") {
      const t = JSON.stringify(putBody);
      return { ok: true, status: 200, text: async () => t } as any;
    }
    const t = typeof getBody === "string" ? getBody : JSON.stringify(getBody);
    return { ok: getStatus >= 200 && getStatus < 300, status: getStatus, text: async () => t } as any;
  }) as unknown as typeof fetch;
}

test("createOrUpdateFile CREATES a new file (404 lookup → no sha) and commits base64 content", async () => {
  const sink: any = {};
  const backend = new RestBackend({ fetchImpl: writeMock(404, { message: "Not Found" },
    { commit: { sha: "c0ffee" }, content: { html_url: "https://github.com/acme/x/blob/main/docs/n.md" } }, sink) });
  const r = (await new GithubMcp(backend).tools()["github.create_or_update_file"](
    { repo: "acme/x", path: "docs/n.md", content: "hello", message: "add notes" }, ctx)) as any;
  assert.equal(r.action, "created");
  assert.equal(r.commit, "c0ffee");
  const put = sink.calls.find((c: any) => c.method === "PUT");
  const body = JSON.parse(put.body);
  assert.equal(body.message, "add notes");
  assert.equal(Buffer.from(body.content, "base64").toString("utf8"), "hello"); // content is base64-encoded
  assert.equal(body.sha, undefined); // create path sends NO sha
  assert.match(put.url, /\/repos\/acme\/x\/contents\/docs\/n\.md$/);
});

test("createOrUpdateFile UPDATES an existing file (lookup sha → PUT carries it)", async () => {
  const sink: any = {};
  const backend = new RestBackend({ fetchImpl: writeMock(200, { sha: "oldsha" },
    { commit: { sha: "newsha" }, content: { html_url: "u" } }, sink) });
  const r = (await new GithubMcp(backend).tools()["github.create_or_update_file"](
    { repo: "acme/x", path: "a.md", content: "v2", message: "update" }, ctx)) as any;
  assert.equal(r.action, "updated");
  assert.equal(r.commit, "newsha");
  const put = sink.calls.find((c: any) => c.method === "PUT");
  assert.equal(JSON.parse(put.body).sha, "oldsha"); // update MUST include the current blob sha
});

test("createOrUpdateFile propagates a non-404 lookup failure (fail-closed, no blind write)", async () => {
  const sink: any = {};
  // 401 on the sha lookup must NOT be swallowed as 'create' — it surfaces as a named error.
  const backend = new RestBackend({ fetchImpl: writeMock(401, { message: "bad creds" }, {}, sink) });
  await assert.rejects(
    () => new GithubMcp(backend).tools()["github.create_or_update_file"](
      { repo: "acme/x", path: "a.md", content: "x", message: "m" }, ctx),
    (e: any) => e instanceof GithubApiError && e.code === "E_CONN_TOKEN_EXPIRED");
  assert.equal(sink.calls.some((c: any) => c.method === "PUT"), false); // never attempted the write
});
