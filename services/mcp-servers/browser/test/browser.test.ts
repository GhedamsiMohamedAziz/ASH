import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserMcp, urlAllowed } from "../src/browser.ts";
const ctx = { credential: "vault:browser" };
test("public https allowed", () => assert.ok(urlAllowed("https://example.com/x").ok));
test("localhost blocked (SSRF)", () => {
  const r = urlAllowed("http://localhost:5432/x");
  assert.equal(r.ok, false); assert.match(r.reason!, /SSRF/);
});
test("internal 169.254 link-local blocked", () => assert.equal(urlAllowed("http://169.254.169.254/latest").ok, false));
test("non-http scheme blocked", () => assert.equal(urlAllowed("file:///etc/passwd").ok, false));

// Alternate-encoding SSRF bypasses that a literal-string blocklist would miss.
test("decimal-encoded 127.0.0.1 blocked", () =>
  assert.equal(urlAllowed("http://2130706433/").ok, false)); // = 127.0.0.1
test("hex-encoded 127.0.0.1 blocked", () =>
  assert.equal(urlAllowed("http://0x7f000001/").ok, false));
test("decimal-encoded metadata IP blocked", () =>
  assert.equal(urlAllowed("http://2852039166/latest").ok, false)); // = 169.254.169.254
test("172.16/12 private range blocked", () =>
  assert.equal(urlAllowed("http://172.20.10.5/").ok, false));
test("IPv6 loopback blocked", () => assert.equal(urlAllowed("http://[::1]/").ok, false));
test("IPv6 ULA blocked", () => assert.equal(urlAllowed("http://[fd00::1]/").ok, false));
test("IPv4-mapped IPv6 loopback blocked", () =>
  assert.equal(urlAllowed("http://[::ffff:127.0.0.1]/").ok, false));
test("metadata.google.internal blocked", () =>
  assert.equal(urlAllowed("http://metadata.google.internal/").ok, false));
test("a real public IP is still allowed", () =>
  assert.ok(urlAllowed("http://93.184.216.34/").ok)); // example.com's IP
test("allow-list enforced when set", () => {
  assert.ok(urlAllowed("https://ok.com", new Set(["ok.com"])).ok);
  assert.equal(urlAllowed("https://evil.com", new Set(["ok.com"])).ok, false);
});
test("browser.read blocks internal host", async () => {
  const t = new BrowserMcp().tools();
  const r: any = await t["browser.read"]({ url: "http://127.0.0.1/x" }, ctx);
  assert.equal(r.error.code, "E_PERM_TOOL_DENIED");
});
test("browser.capture goes to S3", async () => {
  const t = new BrowserMcp().tools();
  const r: any = await t["browser.capture"]({ url: "https://example.com" }, ctx);
  assert.match(r.s3_key, /captures\//);
});
