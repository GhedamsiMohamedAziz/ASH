// Browser MCP server (instructions.md §14, platform connector "Browser + Database MCP").
//
// Exposes read-only browse tools behind one interface; the MCP Gateway (§13) enforces AuthZ and
// the per-turn taint/egress rules (§17.6). Every request first clears the anti-SSRF gate
// (`validateUrl`, src/ssrf.ts) — THE security control — before any socket opens, and every
// response is capped at 256 KB (§14). The actual page fetch is behind a seam: a `StubFetch`
// default keeps the whole chain offline + deterministic (no browser binary, no network); a real
// fetch backend drops in behind `BrowserBackend` with no change to the tool surface — and it is
// still gated by the same validator, so the seam can never become the SSRF bypass.

import {
  validateUrl,
  type AllowListResolver,
  type ValidatedTarget,
} from "./ssrf.ts";

export interface ToolContext {
  userId: string;
  orgId: string;
  credential: string; // injected by the gateway from Vault (§13.2)
}

// Raw response from the fetch seam — the backend does the socket work, nothing more.
export interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

export interface BrowserBackend {
  // `target` has already cleared the SSRF gate; the backend fetches exactly `target.url` and must
  // not re-derive a URL from untrusted input (that would route around the validator).
  fetch(target: ValidatedTarget, ctx: ToolContext): Promise<RawResponse>;
}

// §14: responses are truncated to 256 KB.
export const MAX_BYTES = 256 * 1024;

// Deterministic offline backend — same input yields the same output, no network, no browser
// binary. Stands in for the real headless-browser fetch on the dev/test path.
export class StubFetch implements BrowserBackend {
  async fetch(target: ValidatedTarget): Promise<RawResponse> {
    const u = target.url;
    // A deterministic oversized page for exercising the 256 KB cap.
    if (u.pathname.includes("big")) {
      return { status: 200, contentType: "text/plain; charset=utf-8", body: "A".repeat(300 * 1024) };
    }
    return {
      status: 200,
      contentType: "text/html; charset=utf-8",
      body:
        `<html><head><title>Stub page for ${u.host}</title></head>` +
        `<body><h1>Hello from ${u.host}</h1><p>path: ${u.pathname}</p></body></html>`,
    };
  }
}

export interface BrowserMcpOptions {
  backend?: BrowserBackend;
  allowList?: AllowListResolver; // per-org domain allow-list; default deny (empty)
  resolve?: (host: string) => Promise<string[]>; // prod DNS-rebinding re-check seam
}

export class BrowserMcp {
  private backend: BrowserBackend;
  private allowList: AllowListResolver;
  private resolve?: (host: string) => Promise<string[]>;

  constructor(opts: BrowserMcpOptions = {}) {
    this.backend = opts.backend ?? new StubFetch();
    this.allowList = opts.allowList ?? (() => []); // default deny
    this.resolve = opts.resolve;
  }

  // The MCP tool surface: read-only browse tools, each gated by the SSRF validator and capped.
  // Names match the §13 tool_policies / TASK JWT allow pattern "browser.read_*" (read_page) and
  // the raw-source companion "browser.fetch".
  tools(): Record<string, (args: any, ctx: ToolContext) => Promise<unknown>> {
    return {
      // Extracted, readable text + title — the primary agent-facing tool.
      "browser.read_page": (a, ctx) => this.readPage(String(a.url ?? ""), ctx),
      // Raw (capped) body — for when the agent needs the source, not the extraction.
      "browser.fetch": (a, ctx) => this.fetchRaw(String(a.url ?? ""), ctx),
    };
  }

  // JSON Schema for the two tools (strict input; the gateway validates against these).
  schemas(): Record<string, unknown> {
    const urlProp = {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: { type: "string", format: "uri", maxLength: 2048, description: "http(s) URL to browse" },
      },
    };
    return { "browser.read_page": urlProp, "browser.fetch": urlProp };
  }

  private async gatedFetch(url: string, ctx: ToolContext): Promise<{ target: ValidatedTarget; resp: RawResponse }> {
    const target = await validateUrl(url, ctx.orgId, { allowList: this.allowList, resolve: this.resolve });
    const resp = await this.backend.fetch(target, ctx);
    return { target, resp };
  }

  private async readPage(url: string, ctx: ToolContext) {
    const { target, resp } = await this.gatedFetch(url, ctx);
    const { content, truncated, bytes } = cap(resp.body);
    return {
      url: target.url.href,
      status: resp.status,
      contentType: resp.contentType,
      title: extractTitle(content),
      text: htmlToText(content),
      truncated,
      bytes,
    };
  }

  private async fetchRaw(url: string, ctx: ToolContext) {
    const { target, resp } = await this.gatedFetch(url, ctx);
    const { content, truncated, bytes } = cap(resp.body);
    return {
      url: target.url.href,
      status: resp.status,
      contentType: resp.contentType,
      body: content,
      truncated,
      bytes,
    };
  }
}

// Truncate a body to MAX_BYTES bytes (UTF-8), reporting whether truncation happened and the
// original byte length. Enforces the §14 256 KB cap regardless of what the backend returned.
export function cap(body: string): { content: string; truncated: boolean; bytes: number } {
  const raw = Buffer.from(body, "utf8");
  if (raw.length <= MAX_BYTES) return { content: body, truncated: false, bytes: raw.length };
  return { content: raw.subarray(0, MAX_BYTES).toString("utf8"), truncated: true, bytes: raw.length };
}

export function extractTitle(html: string): string {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? decodeEntities(m[1]).trim() : "";
}

// Minimal, deterministic HTML -> text (no external dependency): drop script/style, strip tags,
// decode a few entities, collapse whitespace. Enough for read_page extraction on the offline path.
export function htmlToText(html: string): string {
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}
