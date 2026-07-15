// Real Notion API backend (instructions.md §14 "Notion | Notion API | ... | Token OAuth
// utilisateur") — the network edge.
//
// Implements the identical NotionBackend interface as StubNotion, so `new NotionMcp(new
// NotionRestBackend())` makes every tool call real with zero change to the tool surface. Uses the
// native fetch directly against Notion's plain HTTPS/JSON REST API — no @notionhq/client
// dependency, matching services/mcp-servers/github/src/rest.ts's precedent (GitHub's REST API
// needed no Octokit SDK either). Not a hard dependency, and no lazy import even needed: there is
// no package to resolve at all on the offline/keyless default path.
//
// The token is NEVER read from source: it comes per-call from ctx.credential, which the gateway
// injects from Vault (§13.2) — the real user integration token, scoped by policy. A
// OLMA_STANDALONE_DEMO env fallback exists only for the standalone demo, mirroring rest.ts.
//
// Notion models page content as a block tree; a page's body isn't a single field the way GitHub's
// file contents are. readPage() fetches the page (for its title/url) plus its top-level block
// children (for a flattened text body); createPage()/updatePage() write through the same two
// endpoints (POST /pages, PATCH /pages/{id}, PATCH /blocks/{id}/children).
//
// Every Notion failure is mapped to the §21 error taxonomy so the layers above surface a named
// error, never a silent 200-that-wasn't: 401 -> E_CONN_TOKEN_EXPIRED, 403 -> E_PERM_TOOL_DENIED,
// 404 -> E_CONN_NEEDS_CONNECTION (Notion returns the SAME object_not_found whether a page doesn't
// exist or exists but isn't shared with this integration — indistinguishable by design, the same
// ambiguity as GitHub's 404, see rest.ts), 400 -> E_VALIDATION, 429 -> E_RATE_LIMITED.

import type { NotionBackend, NotionPage, NotionPageContent, NotionPageSummary, ToolContext } from "./notion.ts";

const NOTION_VERSION = "2022-06-28";

export class NotionApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "NotionApiError";
    this.code = code;
    this.status = status;
  }
}

function mapStatus(status: number, body: string): NotionApiError {
  if (status === 401) return new NotionApiError("E_CONN_TOKEN_EXPIRED", status, "Notion token invalid or expired");
  if (status === 403) return new NotionApiError("E_PERM_TOOL_DENIED", status, "Notion denied access to this resource");
  if (status === 404) return new NotionApiError("E_CONN_NEEDS_CONNECTION", status, "Notion resource not found or not shared with this integration");
  if (status === 400) return new NotionApiError("E_VALIDATION", status, `Notion validation error: ${body.slice(0, 200)}`);
  if (status === 429) return new NotionApiError("E_RATE_LIMITED", status, "Notion rate limit hit");
  return new NotionApiError("E_TOOL_UPSTREAM_ERROR", status, `Notion error ${status}: ${body.slice(0, 200)}`);
}

export interface NotionRestBackendOpts {
  base?: string;
  fetchImpl?: typeof fetch;
}

export class NotionRestBackend implements NotionBackend {
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(opts: NotionRestBackendOpts = {}) {
    this.base = opts.base ?? "https://api.notion.com/v1";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private token(ctx: ToolContext): string {
    // Prod: the per-user token comes ONLY from ctx.credential (gateway-injected from Vault). No
    // ambient-env fallback — an empty credential must fail closed, never silently escalate every
    // requester to one shared integration token (confused deputy). The env fallback below is
    // allowed solely for the standalone demo, gated behind an explicit flag (mirrors rest.ts).
    if (ctx.credential) return ctx.credential;
    if (process.env.OLMA_STANDALONE_DEMO === "1" && process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
    throw new NotionApiError("E_CONN_NEEDS_CONNECTION", 401, "no Notion credential for this user");
  }

  private async call(method: string, path: string, ctx: ToolContext, body?: unknown): Promise<any> {
    const token = this.token(ctx); // resolve first — a missing credential is its own named error
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "notion-version": NOTION_VERSION,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network/DNS/timeout before any HTTP status — a real failure, named not swallowed.
      throw new NotionApiError("E_TOOL_UPSTREAM_ERROR", 0, `Notion request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw mapStatus(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  async search(query: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<NotionPage<NotionPageSummary>> {
    const data = await this.call("POST", "/search", ctx, {
      query,
      page_size: opts.pageSize,
      start_cursor: opts.cursor,
      filter: { property: "object", value: "page" },
    });
    const items: NotionPageSummary[] = (data.results ?? []).map((r: any) => ({
      id: r.id, title: extractTitle(r), url: r.url ?? "",
    }));
    return { items, nextCursor: data.has_more ? (data.next_cursor ?? undefined) : undefined };
  }

  async readPage(id: string, ctx: ToolContext): Promise<NotionPageContent | null> {
    let page: any;
    try {
      page = await this.call("GET", `/pages/${encodeURIComponent(id)}`, ctx);
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 404) return null;
      throw err;
    }
    const blocks = await this.call("GET", `/blocks/${encodeURIComponent(id)}/children?page_size=100`, ctx);
    const content = (blocks.results ?? []).map(blockText).filter(Boolean).join("\n");
    return { id: page.id, title: extractTitle(page), content, url: page.url ?? "" };
  }

  async createPage(parentId: string, title: string, content: string, ctx: ToolContext): Promise<{ id: string; url: string }> {
    const data = await this.call("POST", "/pages", ctx, {
      parent: { page_id: parentId },
      properties: { title: { title: [{ text: { content: title } }] } },
      children: content ? [paragraphBlock(content)] : [],
    });
    return { id: data.id, url: data.url ?? "" };
  }

  async updatePage(id: string, opts: { title?: string; appendContent?: string }, ctx: ToolContext): Promise<{ id: string; url: string } | null> {
    try {
      if (opts.title !== undefined) {
        await this.call("PATCH", `/pages/${encodeURIComponent(id)}`, ctx, {
          properties: { title: { title: [{ text: { content: opts.title } }] } },
        });
      }
      if (opts.appendContent) {
        await this.call("PATCH", `/blocks/${encodeURIComponent(id)}/children`, ctx, {
          children: [paragraphBlock(opts.appendContent)],
        });
      }
      // Neither write above returns the canonical {id, url} shape on its own (a page PATCH omits
      // `url` in some API versions; a blocks-children PATCH returns the appended blocks, not the
      // page at all) — fetch the page once more so the return shape is always the same regardless
      // of which branch ran.
      const page = await this.call("GET", `/pages/${encodeURIComponent(id)}`, ctx);
      return { id: page.id, url: page.url ?? "" };
    } catch (err) {
      if (err instanceof NotionApiError && err.status === 404) return null;
      throw err;
    }
  }
}

function paragraphBlock(text: string) {
  return { object: "block", type: "paragraph", paragraph: { rich_text: [{ text: { content: text } }] } };
}

function extractTitle(page: any): string {
  const props = page?.properties ?? {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop?.type === "title" && Array.isArray(prop.title)) {
      return prop.title.map((t: any) => t.plain_text ?? "").join("");
    }
  }
  return "";
}

function blockText(block: any): string {
  const type = block?.type;
  const rich = block?.[type]?.rich_text;
  if (!Array.isArray(rich)) return "";
  return rich.map((t: any) => t.plain_text ?? "").join("");
}
