// Real fetch backend (instructions.md §14) — the network edge, kept behind the seam and OFF by
// default. Implements the identical BrowserBackend interface as StubFetch, so
// `new BrowserMcp({ backend: new HttpFetch() })` makes every browse real with zero change to the
// tool surface. It never derives its own URL: it fetches exactly `target.url`, which has ALREADY
// cleared the SSRF validator — the validator, not this backend, is the security boundary.
//
// Uses the native fetch (no dependency, matches the no-build type-stripping runtime), does not
// follow redirects (`redirect: "manual"`) so a 30x cannot bounce past the gate to an internal
// host, times out, and caps the read at MAX_BYTES so an unbounded body cannot exhaust memory.
// Every failure maps to the §21 taxonomy so the layers above surface a named error.

import { MAX_BYTES, type BrowserBackend, type RawResponse, type ToolContext } from "./browser.ts";
import type { ValidatedTarget } from "./ssrf.ts";

export class BrowserFetchError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "BrowserFetchError";
    this.code = code;
    this.status = status;
  }
}

export interface HttpFetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export class HttpFetch implements BrowserBackend {
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: HttpFetchOptions = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15000;
  }

  async fetch(target: ValidatedTarget, _ctx: ToolContext): Promise<RawResponse> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(target.url.href, {
        method: "GET",
        redirect: "manual", // never auto-follow a 30x past the SSRF gate
        signal: ctl.signal,
        headers: { accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8", "user-agent": "olma-mcp-browser" },
      });
    } catch (err) {
      if ((err as Error).name === "AbortError") {
        throw new BrowserFetchError("E_TOOL_TIMEOUT", 0, `browse timed out after ${this.timeoutMs}ms`);
      }
      throw new BrowserFetchError("E_TOOL_UPSTREAM_ERROR", 0, `browse request failed: ${(err as Error).message}`);
    } finally {
      clearTimeout(timer);
    }

    // A manual redirect surfaces as an opaque/redirect response — refuse it rather than chase it.
    if (res.status >= 300 && res.status < 400) {
      throw new BrowserFetchError("E_GUARD_INPUT_BLOCKED", res.status, `redirect not followed: ${res.headers.get("location") ?? ""}`);
    }
    if (!res.ok) throw mapStatus(res.status);

    const body = await readCapped(res, MAX_BYTES);
    return { status: res.status, contentType: res.headers.get("content-type") ?? "application/octet-stream", body };
  }
}

function mapStatus(status: number): BrowserFetchError {
  if (status === 401 || status === 403) return new BrowserFetchError("E_PERM_TOOL_DENIED", status, `browse forbidden (${status})`);
  if (status === 404) return new BrowserFetchError("E_TOOL_UPSTREAM_ERROR", status, "page not found");
  if (status === 429) return new BrowserFetchError("E_RATE_LIMITED", status, "browse rate limited");
  return new BrowserFetchError("E_TOOL_UPSTREAM_ERROR", status, `browse upstream error ${status}`);
}

// Read at most `limit` bytes from the response stream, then stop — an unbounded body must never
// be fully buffered. Returns UTF-8 text (best-effort; the cap is enforced again in the tool layer).
async function readCapped(res: Response, limit: number): Promise<string> {
  if (!res.body) return await res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  try {
    await reader.cancel();
  } catch {
    // stream already closed
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, limit).toString("utf8");
}
