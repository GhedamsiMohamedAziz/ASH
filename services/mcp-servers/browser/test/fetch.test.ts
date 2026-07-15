// Real fetch backend tests — drive HttpFetch with a mock fetch (no network). Proves the tool
// surface is unchanged behind the real backend, that the SSRF gate still guards it, that a 30x is
// refused (not chased past the gate), that the body is capped, and that failures map to §21 codes.
// Run: node --test test/fetch.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserMcp, MAX_BYTES } from "../src/browser.ts";
import { HttpFetch, BrowserFetchError } from "../src/fetch.ts";
import { SsrfError } from "../src/ssrf.ts";

const ctx = { userId: "u", orgId: "org_1", credential: "vault:browser" };
const ALLOW = () => ["example.com"];

function mockFetch(status: number, body: string, headers: Record<string, string> = {}, sink?: any): typeof fetch {
  return (async (url: string, init: any) => {
    if (sink) { sink.url = url; sink.init = init; }
    const h = new Headers({ "content-type": "text/html", ...headers });
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: h,
      body: null,
      text: async () => body,
    } as any;
  }) as unknown as typeof fetch;
}

test("HttpFetch hits the real URL and read_page maps the response", async () => {
  const sink: any = {};
  const backend = new HttpFetch({ fetchImpl: mockFetch(200, "<title>Real</title><p>hello</p>", {}, sink) });
  const r = (await new BrowserMcp({ backend, allowList: ALLOW }).tools()["browser.read_page"](
    { url: "https://example.com/p" }, ctx)) as any;
  assert.equal(r.title, "Real");
  assert.match(r.text, /hello/);
  assert.equal(sink.url, "https://example.com/p");
  assert.equal(sink.init.redirect, "manual"); // never auto-follow past the gate
});

test("SSRF gate still guards the real backend (blocked host never fetched)", async () => {
  let called = false;
  const backend = new HttpFetch({ fetchImpl: (async () => { called = true; return { ok: true, status: 200, headers: new Headers(), text: async () => "" } as any; }) as any });
  await assert.rejects(
    () => new BrowserMcp({ backend, allowList: ALLOW }).tools()["browser.fetch"]({ url: "http://10.0.0.1/" }, ctx),
    (e: any) => e instanceof SsrfError,
  );
  assert.equal(called, false);
});

test("a 30x redirect is refused, not chased", async () => {
  const backend = new HttpFetch({ fetchImpl: mockFetch(302, "", { location: "http://169.254.169.254/" }) });
  await assert.rejects(
    () => new BrowserMcp({ backend, allowList: ALLOW }).tools()["browser.fetch"]({ url: "https://example.com/" }, ctx),
    (e: any) => e instanceof BrowserFetchError && e.code === "E_GUARD_INPUT_BLOCKED",
  );
});

test("the real read is capped at 256 KB", async () => {
  const backend = new HttpFetch({ fetchImpl: mockFetch(200, "B".repeat(300 * 1024)) });
  const r = (await new BrowserMcp({ backend, allowList: ALLOW }).tools()["browser.fetch"](
    { url: "https://example.com/" }, ctx)) as any;
  assert.equal(r.truncated, true);
  assert.equal(Buffer.byteLength(r.body, "utf8"), MAX_BYTES);
});

// failure map: HTTP status -> named §21 taxonomy error
const cases: Array<[number, string]> = [
  [401, "E_PERM_TOOL_DENIED"],
  [403, "E_PERM_TOOL_DENIED"],
  [429, "E_RATE_LIMITED"],
  [500, "E_TOOL_UPSTREAM_ERROR"],
];
for (const [status, code] of cases) {
  test(`upstream ${status} -> ${code}`, async () => {
    const backend = new HttpFetch({ fetchImpl: mockFetch(status, "boom") });
    await assert.rejects(
      () => new BrowserMcp({ backend, allowList: ALLOW }).tools()["browser.fetch"]({ url: "https://example.com/" }, ctx),
      (e: any) => e instanceof BrowserFetchError && e.code === code && e.status === status,
    );
  });
}
