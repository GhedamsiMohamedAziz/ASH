// Anti-SSRF validator tests — the security control (instructions.md §14). Run: node --test test/ssrf.test.ts
//
// The BLOCKED table is exhaustive by design: every alternate IP encoding, private/loopback/
// link-local/metadata range, IPv6 form, non-http scheme, credential form, and non-allow-listed
// public host is asserted rejected. The ALLOWED table proves a public host ON the org allow-list
// passes. DNS-rebinding is asserted via the injectable resolver seam.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateUrl,
  SsrfError,
  parseIpv4Number,
  parseIpv6,
  classifyIpv4,
  classifyIpv6,
} from "../src/ssrf.ts";

const ORG = "org_1";
// Allow-list used for the BLOCKED table: private/loopback/metadata hosts throw BEFORE the
// allow-list is consulted; public hosts not listed here throw ON the allow-list (default deny).
const ALLOW = () => ["example.com", "httpbin.org", "93.184.216.34"];

// ---------------------------------------------------------------- BLOCKED table
const BLOCKED: Array<[string, string]> = [
  // non-http(s) schemes
  ["file:///etc/passwd", "scheme file:"],
  ["gopher://127.0.0.1/_", "scheme gopher:"],
  ["ftp://example.com/x", "scheme ftp:"],
  ["data:text/html,<b>hi</b>", "scheme data:"],
  // credentials-in-URL
  ["http://user:pass@example.com/", "credentials-in-url"],
  ["http://admin@example.com/", "credentials-in-url (user only)"],
  // loopback (v4) incl. short form + name
  ["http://127.0.0.1/", "loopback 127.0.0.1"],
  ["http://127.1/", "loopback short form 127.1"],
  ["http://localhost:5432/", "localhost name"],
  ["http://app.localhost/", "*.localhost"],
  // decimal / octal / hex integer IP encodings (parsed, not string-matched)
  ["http://2130706433/", "decimal 127.0.0.1"],
  ["http://0x7f000001/", "hex 127.0.0.1"],
  ["http://017700000001/", "octal 127.0.0.1"],
  ["http://0x7f.0.0.1/", "mixed-radix per-part 127.0.0.1"],
  ["http://2852039166/latest/meta-data/", "decimal 169.254.169.254 metadata"],
  // RFC1918 private
  ["http://10.1.2.3/", "private 10/8"],
  ["http://172.20.10.5/", "private 172.16/12"],
  ["http://192.168.1.1/", "private 192.168/16"],
  // link-local, cgnat, this-network, broadcast
  ["http://169.254.169.254/latest/meta-data/", "link-local metadata 169.254.169.254"],
  ["http://100.64.0.1/", "cgnat 100.64/10"],
  ["http://0.0.0.0/", "this-network 0/8"],
  ["http://255.255.255.255/", "broadcast"],
  // IPv6 forms
  ["http://[::1]/", "ipv6 loopback ::1"],
  ["http://[::]/", "ipv6 unspecified ::"],
  ["http://[fe80::1]/", "ipv6 link-local fe80::/10"],
  ["http://[fc00::1]/", "ipv6 ula fc00::/7"],
  ["http://[fd00:ec2::254]/", "ipv6 AWS IMDSv6 fd00:ec2::254 (ULA)"],
  ["http://[ff02::1]/", "ipv6 multicast ff00::/8"],
  ["http://[::ffff:127.0.0.1]/", "ipv4-mapped dotted ::ffff:127.0.0.1"],
  ["http://[::ffff:7f00:1]/", "ipv4-mapped hex ::ffff:7f00:1"],
  ["http://[::ffff:a9fe:a9fe]/", "ipv4-mapped metadata ::ffff:169.254.169.254"],
  ["http://[::7f00:1]/", "ipv4-compatible ::7f00:1 -> 127.0.0.1"],
  ["http://[64:ff9b::7f00:1]/", "nat64 64:ff9b::/96 -> 127.0.0.1"],
  // metadata hostnames
  ["http://metadata.google.internal/computeMetadata/v1/", "metadata.google.internal"],
  ["http://metadata/", "metadata"],
  ["http://metadata.goog/", "metadata.goog"],
  // non-allow-listed public host (default deny); a public IP not on the list is covered below
  ["https://evil.example.org/", "public host not on allow-list"],
  ["http://198.51.100.7/", "public IP not on allow-list"],
];

for (const [url, label] of BLOCKED) {
  test(`BLOCK: ${label} (${url})`, async () => {
    await assert.rejects(
      () => validateUrl(url, ORG, { allowList: ALLOW }),
      (e: any) => e instanceof SsrfError,
      `expected ${url} to be rejected`,
    );
  });
}

// ---------------------------------------------------------------- ALLOWED table
const ALLOWED: string[] = [
  "https://example.com/",
  "https://sub.example.com/a/b?q=1", // subdomain of an allow-listed domain
  "https://httpbin.org/get",
  "http://93.184.216.34/", // public IP literal explicitly on the allow-list
];

for (const url of ALLOWED) {
  test(`ALLOW: ${url}`, async () => {
    const t = await validateUrl(url, ORG, { allowList: ALLOW });
    assert.ok(t.host.length > 0);
    assert.equal(t.url.protocol.startsWith("http"), true);
  });
}

test("default-deny: empty allow-list rejects an otherwise-public host", async () => {
  await assert.rejects(
    () => validateUrl("https://example.com/", ORG, { allowList: () => [] }),
    (e: any) => e instanceof SsrfError && /not-on-allow-list/.test(e.reason),
  );
});

test("malformed URL is E_VALIDATION, not a crash", async () => {
  await assert.rejects(
    () => validateUrl("not a url", ORG, { allowList: ALLOW }),
    (e: any) => e instanceof SsrfError && e.code === "E_VALIDATION",
  );
});

test("blocked hosts carry E_GUARD_INPUT_BLOCKED with a reason", async () => {
  await assert.rejects(
    () => validateUrl("http://169.254.169.254/", ORG, { allowList: ALLOW }),
    (e: any) => e.code === "E_GUARD_INPUT_BLOCKED" && /169\.254/.test(e.reason),
  );
});

// ---------------------------------------------------------------- DNS-rebinding (resolver seam)
test("DNS-rebind: allow-listed name resolving to a private IP is blocked", async () => {
  await assert.rejects(
    () => validateUrl("https://example.com/", ORG, { allowList: ALLOW, resolve: async () => ["10.0.0.5"] }),
    (e: any) => e instanceof SsrfError && /dns-rebind/.test(e.reason),
  );
});

test("DNS-rebind: name resolving to loopback (even decimal-encoded) is blocked", async () => {
  await assert.rejects(
    () => validateUrl("https://example.com/", ORG, { allowList: ALLOW, resolve: async () => ["2130706433"] }),
    (e: any) => e instanceof SsrfError && /dns-rebind/.test(e.reason),
  );
});

test("DNS-rebind: name resolving to a public IP is allowed and reports the records", async () => {
  const t = await validateUrl("https://example.com/", ORG, { allowList: ALLOW, resolve: async () => ["93.184.216.34"] });
  assert.deepEqual(t.resolved, ["93.184.216.34"]);
});

test("DNS-rebind: no records is blocked", async () => {
  await assert.rejects(
    () => validateUrl("https://example.com/", ORG, { allowList: ALLOW, resolve: async () => [] }),
    (e: any) => e instanceof SsrfError && /dns-no-records/.test(e.reason),
  );
});

// ---------------------------------------------------------------- parser/classifier units
test("parseIpv4Number normalizes every integer encoding to 127.0.0.1", () => {
  assert.deepEqual(parseIpv4Number("2130706433"), [127, 0, 0, 1]); // decimal
  assert.deepEqual(parseIpv4Number("0x7f000001"), [127, 0, 0, 1]); // hex
  assert.deepEqual(parseIpv4Number("017700000001"), [127, 0, 0, 1]); // octal
  assert.deepEqual(parseIpv4Number("127.1"), [127, 0, 0, 1]); // short form
  assert.deepEqual(parseIpv4Number("0x7f.0.0.1"), [127, 0, 0, 1]); // mixed radix
  assert.deepEqual(parseIpv4Number("1.2.3.4"), [1, 2, 3, 4]);
});

test("parseIpv4Number returns null for non-IPv4 hosts and out-of-range parts", () => {
  assert.equal(parseIpv4Number("example.com"), null);
  assert.equal(parseIpv4Number("256.1.2.3"), null);
  assert.equal(parseIpv4Number("999999999999"), null);
});

test("classifyIpv4 blocks private/loopback, passes public", () => {
  assert.ok(classifyIpv4([127, 0, 0, 1]));
  assert.ok(classifyIpv4([169, 254, 169, 254]));
  assert.ok(classifyIpv4([10, 0, 0, 1]));
  assert.equal(classifyIpv4([93, 184, 216, 34]), null);
});

test("parseIpv6 + classifyIpv6 catch loopback, ULA, and IPv4-mapped loopback", () => {
  assert.ok(classifyIpv6(parseIpv6("::1")!));
  assert.ok(classifyIpv6(parseIpv6("fd00:ec2::254")!));
  assert.ok(classifyIpv6(parseIpv6("::ffff:127.0.0.1")!));
  assert.equal(parseIpv6("example.com"), null);
});
