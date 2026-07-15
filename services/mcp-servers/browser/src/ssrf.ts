// Anti-SSRF host validator — the security core of the Browser MCP (instructions.md §14,
// "Anti-SSRF Browser (durci)"; threat table §17 / §... "garde SSRF navigateur parse les hôtes
// (IP décimales/hex, CIDR privés, IPv6, metadata bloqués)").
//
// Every browse request MUST clear `validateUrl()` BEFORE any socket is opened. The gate does
// NOT string-match hostnames — it PARSES and NORMALIZES the target host into raw IP bytes
// (decimal / octal / hex integer forms, IPv4 short forms, every IPv6 form incl. IPv4-mapped)
// and classifies those bytes against the blocked CIDR ranges. A public IP is still refused
// unless its host is on the org's allow-list: default deny.
//
// DNS-rebinding: `validateUrl` takes an optional `resolve()` seam. When present (prod), the
// hostname is resolved and EVERY resolved IP is re-validated through the same byte classifier,
// so a name that passes the allow-list but resolves to 169.254.169.254 is still blocked. When
// absent (offline/test), literal-IP hosts are validated fully and DNS hosts are gated by the
// allow-list only — live resolution + re-check is the documented prod step (see README).

// A typed error carrying a §21 taxonomy code plus a machine-readable `reason` naming the exact
// rule that fired (so tests and audit can assert *why* a host was refused).
export class SsrfError extends Error {
  code: string;
  reason: string;
  constructor(code: string, reason: string) {
    super(`${code}: ${reason}`);
    this.name = "SsrfError";
    this.code = code;
    this.reason = reason;
  }
}

// Per-org domain allow-list resolver. Returns the domains reachable for this org; an empty list
// (the default) means DEFAULT DENY — nothing is reachable until the org opts a domain in.
export type AllowListResolver = (orgId: string) => string[];

export interface ValidatorOptions {
  allowList: AllowListResolver;
  // Prod DNS-rebinding defense: resolve the hostname to its A/AAAA records so each is re-checked.
  // Offline default: undefined (literal IPs validated fully; DNS hosts gated by allow-list only).
  resolve?: (host: string) => Promise<string[]>;
}

export interface ValidatedTarget {
  url: URL;
  host: string; // normalized, lower-cased, de-bracketed
  ip?: string; // set when the host was a literal IP
  resolved?: string[]; // set when a live resolver re-checked the DNS records
}

// Cloud metadata / infra endpoints refused by name (their IPs are also range-blocked, but the
// name form must never even be looked up). 169.254.169.254 (AWS/Azure/OpenStack) and
// fd00:ec2::254 (AWS IMDSv6) fall under the link-local / ULA byte ranges below.
const METADATA_HOSTS = new Set([
  "metadata.google.internal",
  "metadata.goog",
  "metadata",
]);

// ---------------------------------------------------------------- IPv4 integer parsing
// Parse a host as an IPv4 address in ANY inet_aton form and return its 4 octets, or null if the
// host is not an IPv4 literal. Handles: dotted-quad (127.0.0.1), decimal (2130706433), hex
// (0x7f000001), octal (017700000001), and short forms (127.1, 127.0.1). Each part may itself be
// decimal, octal (leading 0), or hex (0x…) — exactly like the C resolver an attacker relies on.
export function parseIpv4Number(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const p of parts) {
    const n = partToNumber(p);
    if (n === null) return null; // any non-numeric part => not an IPv4 literal
    nums.push(n);
  }

  // Per-part maxima depend on how many parts there are (inet_aton semantics).
  // 4 parts: a.b.c.d          each <= 255
  // 3 parts: a.b.c            c <= 65535   (low 16 bits)
  // 2 parts: a.b              b <= 16777215 (low 24 bits)
  // 1 part:  a                a <= 4294967295 (full 32 bits)
  const n = nums.length;
  let value: number;
  if (n === 4) {
    if (nums.some((x) => x > 255)) return null;
    value = nums[0] * 2 ** 24 + nums[1] * 2 ** 16 + nums[2] * 2 ** 8 + nums[3];
  } else if (n === 3) {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 65535) return null;
    value = nums[0] * 2 ** 24 + nums[1] * 2 ** 16 + nums[2];
  } else if (n === 2) {
    if (nums[0] > 255 || nums[1] > 16777215) return null;
    value = nums[0] * 2 ** 24 + nums[1];
  } else {
    if (nums[0] > 4294967295) return null;
    value = nums[0];
  }
  if (value < 0 || value > 4294967295) return null;
  return [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
}

function partToNumber(p: string): number | null {
  if (p === "") return null;
  if (/^0x[0-9a-f]+$/i.test(p)) return parseInt(p.slice(2), 16); // hex 0x..
  if (/^0[0-7]+$/.test(p)) return parseInt(p, 8); // octal 0..
  if (/^0$/.test(p)) return 0;
  if (/^[1-9][0-9]*$/.test(p)) return parseInt(p, 10); // decimal
  return null; // anything else (letters, 0x with no digits, 08, ...) => not numeric
}

// Strict dotted-quad decimal (0-255)x4 — used only for the IPv4 tail embedded in an IPv6 address.
function dottedQuad(s: string): number[] | null {
  const parts = s.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^[0-9]{1,3}$/.test(p)) return null;
    const n = parseInt(p, 10);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- IPv6 parsing
// Parse an IPv6 literal (with or without a "::" run, with or without an embedded IPv4 tail and
// with an optional %zone id) into its 16 bytes, or null if not a valid IPv6 literal.
export function parseIpv6(input: string): number[] | null {
  let s = input;
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // strip zone id (fe80::1%eth0)
  if (!s.includes(":")) return null;

  const halves = s.split("::");
  if (halves.length > 2) return null; // at most one "::"

  const toGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const segs = part.split(":");
    const out: number[] = [];
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      if (seg.includes(".")) {
        if (i !== segs.length - 1) return null; // embedded IPv4 only in the last group
        const v4 = dottedQuad(seg);
        if (!v4) return null;
        out.push((v4[0] << 8) | v4[1]);
        out.push((v4[2] << 8) | v4[3]);
      } else {
        if (!/^[0-9a-f]{1,4}$/i.test(seg)) return null;
        out.push(parseInt(seg, 16));
      }
    }
    return out;
  };

  const head = toGroups(halves[0]);
  if (head === null) return null;

  let groups: number[];
  if (halves.length === 2) {
    const tail = toGroups(halves[1]);
    if (tail === null) return null;
    const missing = 8 - head.length - tail.length;
    if (missing < 1) return null; // "::" must stand for at least one zero group
    groups = [...head, ...new Array(missing).fill(0), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const g of groups) bytes.push((g >>> 8) & 255, g & 255);
  return bytes;
}

// ---------------------------------------------------------------- range classifiers
// Return the name of the blocked range an IPv4 address falls in, or null if it is a routable
// public unicast address. Covers loopback, all RFC1918 private CIDRs, link-local (which contains
// the 169.254.169.254 metadata endpoint), CGNAT, this-network, and multicast/reserved.
export function classifyIpv4(b: number[]): string | null {
  const [a, x, c] = b;
  if (a === 0) return "this-network 0.0.0.0/8";
  if (a === 127) return "loopback 127.0.0.0/8";
  if (a === 10) return "private 10.0.0.0/8";
  if (a === 172 && x >= 16 && x <= 31) return "private 172.16.0.0/12";
  if (a === 192 && x === 168) return "private 192.168.0.0/16";
  if (a === 169 && x === 254) return "link-local 169.254.0.0/16 (incl. cloud metadata 169.254.169.254)";
  if (a === 100 && x >= 64 && x <= 127) return "cgnat 100.64.0.0/10";
  if (a === 192 && x === 0 && c === 0) return "ietf-protocol 192.0.0.0/24";
  if (a >= 224) return "multicast/reserved 224.0.0.0/3 (incl. 255.255.255.255 broadcast)";
  return null;
}

// Return the name of the blocked range an IPv6 address falls in, or null if it is public unicast.
// Delegates IPv4-mapped / IPv4-compatible / NAT64 embedded addresses back to the IPv4 classifier
// so ::ffff:127.0.0.1 is caught exactly like 127.0.0.1.
export function classifyIpv6(b: number[]): string | null {
  const allZero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);

  if (b.every((x) => x === 0)) return "unspecified ::/128";
  if (allZero(0, 15) && b[15] === 1) return "loopback ::1/128";

  // ::ffff:0:0/96 IPv4-mapped
  if (allZero(0, 10) && b[10] === 0xff && b[11] === 0xff) {
    return mappedReason(b.slice(12, 16), "ipv4-mapped ::ffff:*");
  }
  // ::/96 IPv4-compatible (deprecated) and 64:ff9b::/96 NAT64 — both embed an IPv4 tail
  if (allZero(0, 12) && !allZero(12, 16)) return mappedReason(b.slice(12, 16), "ipv4-compatible ::*");
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && allZero(4, 12)) {
    return mappedReason(b.slice(12, 16), "nat64 64:ff9b::*");
  }

  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "link-local fe80::/10";
  if ((b[0] & 0xfe) === 0xfc) return "unique-local fc00::/7 (incl. fd00:ec2::254 metadata)";
  if (b[0] === 0xff) return "multicast ff00::/8";
  return null;
}

function mappedReason(v4: number[], label: string): string | null {
  const inner = classifyIpv4(v4);
  return inner === null ? null : `${label} -> ${inner}`;
}

// ---------------------------------------------------------------- the gate
export async function validateUrl(
  rawUrl: string,
  orgId: string,
  opts: ValidatorOptions,
): Promise<ValidatedTarget> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError("E_VALIDATION", `malformed-url: ${rawUrl.slice(0, 80)}`);
  }

  // 1) scheme: only http/https. file:, gopher:, ftp:, data:, ... are refused.
  const proto = u.protocol.toLowerCase();
  if (proto !== "http:" && proto !== "https:") {
    throw block(`scheme-not-allowed: ${proto}`);
  }

  // 2) credentials-in-URL (user:pass@host) are refused — a classic gate-bypass / token leak vector.
  if (u.username !== "" || u.password !== "") {
    throw block("credentials-in-url");
  }

  // 3) normalize the host (strip IPv6 brackets, lower-case).
  let host = u.hostname.toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "") throw block("empty-host");

  // 4) literal IPv4 (any integer/short encoding) -> classify bytes.
  const v4 = parseIpv4Number(host);
  if (v4) {
    const reason = classifyIpv4(v4);
    const dotted = v4.join(".");
    if (reason) throw block(`blocked-ipv4 ${dotted} (${reason})`);
    ensureAllowed(host, orgId, opts); // public IP literal still needs allow-list
    return { url: u, host, ip: dotted };
  }

  // 5) literal IPv6 (incl. IPv4-mapped / ULA / link-local) -> classify bytes.
  const v6 = parseIpv6(host);
  if (v6) {
    const reason = classifyIpv6(v6);
    if (reason) throw block(`blocked-ipv6 ${host} (${reason})`);
    ensureAllowed(host, orgId, opts);
    return { url: u, host, ip: host };
  }

  // 6) DNS hostname.
  if (host === "localhost" || host.endsWith(".localhost")) throw block("hostname-localhost");
  if (METADATA_HOSTS.has(host)) throw block(`metadata-hostname: ${host}`);

  // Allow-list gate FIRST (default deny) — a non-allow-listed public host never gets resolved.
  ensureAllowed(host, orgId, opts);

  // 7) DNS-rebinding: if a resolver is wired, re-check every resolved IP through the byte gate.
  if (opts.resolve) {
    const ips = await opts.resolve(host);
    if (!ips || ips.length === 0) throw block(`dns-no-records: ${host}`);
    for (const ip of ips) {
      const b4 = parseIpv4Number(ip);
      if (b4) {
        const r = classifyIpv4(b4);
        if (r) throw block(`dns-rebind ${host} -> ${ip} (${r})`);
        continue;
      }
      const b6 = parseIpv6(ip);
      if (b6) {
        const r = classifyIpv6(b6);
        if (r) throw block(`dns-rebind ${host} -> ${ip} (${r})`);
        continue;
      }
      throw block(`dns-unparseable ${host} -> ${ip}`);
    }
    return { url: u, host, resolved: ips };
  }

  // Offline path: no live resolution. Literal IPs were fully validated above; DNS hosts are
  // gated by the allow-list. Prod re-checks resolved IPs via the `resolve` seam (documented).
  return { url: u, host };
}

function block(reason: string): SsrfError {
  return new SsrfError("E_GUARD_INPUT_BLOCKED", reason);
}

function ensureAllowed(host: string, orgId: string, opts: ValidatorOptions): void {
  const list = opts.allowList(orgId) ?? [];
  const ok = list.some((entry) => {
    const e = entry.toLowerCase().replace(/^\.+/, "");
    return host === e || host.endsWith(`.${e}`);
  });
  if (!ok) throw block(`not-on-allow-list: ${host}`);
}
