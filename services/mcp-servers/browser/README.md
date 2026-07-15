# Browser MCP

> **Status:** Phase P6 (runnable + tested) · **Spec:** instructions.md §14 ("Anti-SSRF Browser, durci")

Read-only web browse connector. Tools: `browser.read_page` (extracted text + title),
`browser.fetch` (raw source). The MCP Gateway (§13) enforces AuthZ and the per-turn
taint/egress rules (§17.6); this layer's job is the **anti-SSRF gate** and the size cap.

## The deliverable: anti-SSRF host validator (`src/ssrf.ts`)

Before any socket opens, the target URL clears `validateUrl()`. It does **not** string-match
hostnames — it **parses and normalizes** the host into raw IP bytes and classifies those bytes
against blocked CIDR ranges. Default deny: a public IP is refused unless its host is on the org's
allow-list.

**Blocked (each asserted in `test/ssrf.test.ts`):**

- **Schemes** other than http/https — `file:`, `gopher:`, `ftp:`, `data:`
- **Credentials in URL** — `http://user:pass@host/`
- **Loopback** — `127.0.0.0/8`, `::1`, `localhost`, `*.localhost`
- **RFC1918 private** — `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`
- **Link-local** — `169.254.0.0/16` (IPv4), `fe80::/10` (IPv6)
- **This-network / CGNAT / multicast+broadcast** — `0.0.0.0/8`, `100.64.0.0/10`, `224.0.0.0/3`
- **IPv6 loopback/unspecified/ULA** — `::1`, `::`, `fc00::/7` (covers `fd00:ec2::254`)
- **IPv4-mapped / -compatible / NAT64 IPv6** — `::ffff:127.0.0.1`, `::ffff:7f00:1`, `::7f00:1`, `64:ff9b::7f00:1`
- **Integer IP encodings** (parsed, not string-matched) — decimal `http://2130706433/`,
  hex `http://0x7f000001/`, octal `http://017700000001/`, short form `http://127.1/`,
  per-part mixed radix `http://0x7f.0.0.1/`, decimal metadata `http://2852039166/`
- **Cloud metadata** — `169.254.169.254`, `fd00:ec2::254`, `metadata.google.internal`, `metadata`, `metadata.goog`
- **Non-allow-listed public hosts** — even a routable public IP/host is denied unless allow-listed

**Allow-list model:** `AllowListResolver = (orgId) => string[]`. A host matches an entry if it
equals it or is a subdomain (`docs.example.com` matches `example.com`). Empty list ⇒ deny all.

**DNS-rebinding:** `validateUrl` takes an optional `resolve(host) => Promise<string[]>` seam. When
wired (**prod**), the hostname is resolved and **every resolved IP is re-validated** through the
same byte classifier, so an allow-listed name that resolves to `169.254.169.254` is still blocked
(asserted). When absent (**offline/test default**), literal-IP hosts are validated fully and DNS
hosts are gated by the allow-list only — **live resolution + re-check is the documented prod step**.

## Fetch seam

The page fetch is behind `BrowserBackend`:

- `StubFetch` (default) — offline, deterministic, no browser binary, no network.
- `HttpFetch` (`src/fetch.ts`) — native `fetch`, injectable and **off by default**, still gated by
  the validator, `redirect: "manual"` (a 30x cannot bounce past the gate), timeout, capped read.

No Playwright/Chromium hard dependency (that needs browser binaries) — the SSRF gate + fetch seam
is the testable core. All responses are capped at **256 KB** (`MAX_BYTES`, §14).

```bash
npm test    # node --test: ssrf validator table + tool-surface/cap/happy-path
```

## Next

- Register `browser.read_page` / `browser.fetch` with the running gateway (documented follow-up).
- Wire the prod `resolve` seam to the sandbox resolver for live DNS-rebinding re-check.
