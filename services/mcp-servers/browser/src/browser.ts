// Browser MCP (instructions.md §14): headless Playwright pool — read/click/fill/
// download/capture. Sandboxed + resource-capped. The notable safety: an egress
// allow-list (a browse tool must not become an exfiltration/SSRF vector), and
// downloads land in S3, never back to the agent's sandbox filesystem directly.

export interface Ctx { credential: string }

// SSRF guard (§17.4 zero-trust). A literal-string blocklist is bypassable via alternate IP
// encodings (decimal 2130706433, hex 0x7f000001, octal, short forms) and IPv6, so we PARSE the
// host: any IPv4 encoding is canonicalized to an integer and checked against the private/loopback
// CIDRs; IPv6 loopback/ULA/link-local/mapped are matched by prefix; metadata hostnames are named.
// (DNS-rebinding — a public name resolving to a private IP — is closed at fetch time in the real
// backend by re-checking the RESOLVED address; this function guards the literal host.)

// Private / loopback / link-local IPv4 ranges as [lo, hi] integer bounds.
const V4_BLOCKED: Array<[number, number]> = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8    "this host"
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 CGNAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8  loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local (cloud metadata)
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
];

// Parse an IPv4 in any inet_aton encoding (dotted/decimal/hex/octal, 1-4 parts) → uint32, or null.
export function parseIpv4(host: string): number | null {
  const parts = host.split(".");
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (p === "") return null;
    let n: number;
    if (/^0x[0-9a-f]+$/i.test(p)) n = parseInt(p, 16);
    else if (/^0[0-7]+$/.test(p)) n = parseInt(p, 8);
    else if (/^[0-9]+$/.test(p)) n = parseInt(p, 10);
    else return null;
    if (!Number.isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  // Leading parts are one byte each; the final part fills the remaining bytes (inet_aton).
  let ip = 0;
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 255) return null;
    ip = ip * 256 + nums[i];
  }
  const restBytes = 4 - (nums.length - 1);
  const rest = nums[nums.length - 1];
  if (rest >= 256 ** restBytes) return null;
  ip = ip * 256 ** restBytes + rest;
  return ip >= 0 && ip <= 0xffffffff ? ip : null;
}

function isBlockedHost(rawHost: string): boolean {
  const host = rawHost.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();

  // Named internal targets.
  if (host === "localhost" || host === "metadata" || host.endsWith(".internal") ||
      host.endsWith(".local")) return true;

  // IPv6 loopback / unspecified / ULA (fc00::/7) / link-local (fe80::/10).
  if (host === "::1" || host === "::" || host.startsWith("fc") || host.startsWith("fd") ||
      /^fe[89ab]/.test(host)) return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 or ::ffff:7f00:1) — extract and check the v4 tail.
  const mapped = host.match(/^::ffff:(.+)$/);
  if (mapped) {
    const v4 = parseIpv4(mapped[1]);
    if (v4 !== null) return V4_BLOCKED.some(([lo, hi]) => v4 >= lo && v4 <= hi);
    return true; // hex-form mapped address we can't cheaply parse — deny
  }

  // Any IPv4 encoding.
  const v4 = parseIpv4(host);
  if (v4 !== null) return V4_BLOCKED.some(([lo, hi]) => v4 >= lo && v4 <= hi);
  return false;
}

export function urlAllowed(u: string, allow: Set<string> | null = null): { ok: boolean; reason?: string } {
  let host: string;
  try {
    const parsed = new URL(u);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { ok: false, reason: "only http(s) allowed" };
    }
    host = parsed.hostname;
  } catch {
    return { ok: false, reason: "invalid url" };
  }
  if (isBlockedHost(host)) return { ok: false, reason: "internal host blocked (SSRF)" };
  if (allow && !allow.has(host)) return { ok: false, reason: `host ${host} not on allow-list` };
  return { ok: true };
}

export interface BrowserBackend {
  read(url: string, ctx: Ctx): Promise<{ title: string; text: string }>;
  extract(url: string, selector: string, ctx: Ctx): Promise<string[]>;
  capture(url: string, ctx: Ctx): Promise<{ s3_key: string }>;
}

export class StubBrowser implements BrowserBackend {
  async read(url: string) {
    return { title: "Example", text: `content of ${url}` };
  }
  async extract(url: string, selector: string) {
    return [`match-1 for ${selector}`, "match-2"];
  }
  async capture(url: string) {
    return { s3_key: "captures/shot.png" }; // downloads/captures go to S3 (§14)
  }
}

export class BrowserMcp {
  private b: BrowserBackend;
  private allow: Set<string> | null;
  constructor(backend: BrowserBackend = new StubBrowser(), allow: Set<string> | null = null) {
    this.b = backend;
    this.allow = allow;
  }
  private guard(url: string) {
    const g = urlAllowed(url, this.allow);
    return g.ok ? null : { error: { code: "E_PERM_TOOL_DENIED", message: g.reason } };
  }
  tools(): Record<string, (a: any, ctx: Ctx) => Promise<unknown>> {
    return {
      "browser.read": async (a, ctx) => this.guard(a.url) ?? this.b.read(String(a.url), ctx),
      "browser.extract": async (a, ctx) =>
        this.guard(a.url) ?? this.b.extract(String(a.url), String(a.selector), ctx),
      "browser.capture": async (a, ctx) => this.guard(a.url) ?? this.b.capture(String(a.url), ctx),
    };
  }
}
