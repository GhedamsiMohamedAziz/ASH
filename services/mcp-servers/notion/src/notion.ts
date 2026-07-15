// Notion MCP server (instructions.md §14 "Notion | Notion API | search, read_page, create_page,
// update_page | Token OAuth utilisateur").
//
// Exposes Notion tools behind one interface; the MCP Gateway (§13) injects the user's Notion
// integration token and enforces AuthZ, so this layer never sees a raw token except via the ctx
// passed in. Used for minutes, specs, wikis.
//
// Mirrors services/mcp-servers/github/src/github.ts: a StubNotion backend (offline, deterministic)
// so the whole chain runs with no token/network, and a real backend (api.ts) that drops in behind
// the SAME NotionBackend interface with zero change to the tool surface. `notion.search` is
// paginated and truncated to 256 KB (instructions.md §14 "règles communes") via the shared
// services/mcp-servers/_template/src/pagination.ts helper (same one database.ts and browser.ts
// use); `notion.read_page`'s content is capped the same way a single big field is elsewhere
// (mirrors browser.ts's cap()). Every tool's args are validated against a strict JSON Schema
// before the backend is ever called — a malformed call never reaches Notion.

import { paginate, truncateJson, MAX_RESPONSE_BYTES } from "../../_template/src/pagination.ts";

export interface ToolContext {
  userId: string;
  orgId: string;
  credential: string; // Notion integration token injected by the gateway from Vault (§13.2)
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_CONTENT_BYTES = 256 * 1024;

export interface NotionPageSummary {
  id: string;
  title: string;
  url: string;
}

export interface NotionPageContent {
  id: string;
  title: string;
  content: string;
  url: string;
}

export interface NotionPage<T> {
  items: T[];
  nextCursor?: string;
}

// Backend the façade calls. Injected so tests need no real Notion workspace (mirrors
// GithubBackend). search() paginates natively (own {cursor, pageSize}), matching Slack's
// SlackBackend — a workspace's page set can be arbitrarily large, so pagination can't be a
// client-side slice over an already-fetched full array the way database.ts's DbBackend is.
export interface NotionBackend {
  search(query: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<NotionPage<NotionPageSummary>>;
  readPage(id: string, ctx: ToolContext): Promise<NotionPageContent | null>;
  createPage(parentId: string, title: string, content: string, ctx: ToolContext): Promise<{ id: string; url: string }>;
  updatePage(id: string, opts: { title?: string; appendContent?: string }, ctx: ToolContext): Promise<{ id: string; url: string } | null>;
}

// Deterministic offline backend — same input yields the same output, no token, no network.
// Stands in for the real Notion API on the dev/test path (default backend for NotionMcp).
export class StubNotion implements NotionBackend {
  private pages = new Map<string, NotionPageContent>([
    ["pg_1", { id: "pg_1", title: "Q3 Spec", content: "The Q3 roadmap covers onboarding v2 and the connector rollout.", url: "https://notion.so/pg_1" }],
    ["pg_2", { id: "pg_2", title: "Onboarding wiki", content: "Welcome to the team — start here.", url: "https://notion.so/pg_2" }],
  ]);
  private seq = 2;

  async search(query: string, opts: { cursor?: string; pageSize: number }): Promise<NotionPage<NotionPageSummary>> {
    const q = query.toLowerCase().trim();
    const seeded = [...this.pages.values()]
      .filter((p) => !q || p.title.toLowerCase().includes(q) || p.content.toLowerCase().includes(q))
      .map(({ id, title, url }) => ({ id, title, url }));
    // Padded with deterministic extra hits so pagination has something to page through even for a
    // query that only matches the two seeded pages above — mirrors StubSlack.searchMessages.
    const extra: NotionPageSummary[] = Array.from({ length: 28 }, (_, i) => ({
      id: `pg_stub_${i}`, title: `stub result ${i} for ${query}`, url: `https://notion.so/pg_stub_${i}`,
    }));
    const all = [...seeded, ...extra];
    return paginate(all, opts.cursor, opts.pageSize);
  }

  async readPage(id: string): Promise<NotionPageContent | null> {
    const page = this.pages.get(id);
    return page ? { ...page } : null;
  }

  async createPage(parentId: string, title: string, content: string): Promise<{ id: string; url: string }> {
    this.seq += 1;
    const id = `pg_${this.seq}`;
    const page: NotionPageContent = { id, title, content, url: `https://notion.so/${id}` };
    this.pages.set(id, page);
    return { id, url: page.url };
  }

  async updatePage(id: string, opts: { title?: string; appendContent?: string }): Promise<{ id: string; url: string } | null> {
    const page = this.pages.get(id);
    if (!page) return null;
    if (opts.title !== undefined) page.title = opts.title;
    if (opts.appendContent) page.content = `${page.content}\n${opts.appendContent}`;
    return { id: page.id, url: page.url };
  }
}

// Minimal dependency-free JSON Schema validator — checks required fields, rejects unknown fields
// when additionalProperties is false, and checks declared type/maxLength/enum. Mirrors
// services/mcp-servers/_template/src/server.ts's validateArgs, extended with the constraints this
// connector's schemas actually use (and services/mcp-servers/slack/src/slack.ts's copy — kept
// duplicated per-connector rather than factored into a shared file outside this connector's
// scope). Not a full JSON Schema validator (no $ref, no nested object schemas) — every tool arg
// here is a flat scalar, which this fully covers.
function validate(schema: any, args: Record<string, unknown>): string | null {
  const props = (schema?.properties ?? {}) as Record<string, any>;
  for (const key of schema?.required ?? []) {
    const v = args[key];
    if (v === undefined || v === null || v === "") return `missing required field "${key}"`;
  }
  if (schema?.additionalProperties === false) {
    for (const key of Object.keys(args)) {
      if (!(key in props)) return `unknown field "${key}"`;
    }
  }
  for (const [key, spec] of Object.entries(props)) {
    const value = args[key];
    if (value === undefined || value === null) continue;
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (spec.type && actual !== spec.type) return `field "${key}" must be a ${spec.type}`;
    if (spec.type === "string" && typeof spec.maxLength === "number" && (value as string).length > spec.maxLength) {
      return `field "${key}" exceeds max length ${spec.maxLength}`;
    }
    if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      return `field "${key}" must be one of: ${spec.enum.join(", ")}`;
    }
  }
  return null;
}

// Caps a single text field at maxBytes (UTF-8) — read_page's content isn't an `items` array, so
// truncateJson's array-slicing strategy doesn't apply. Mirrors browser.ts's cap() for the same
// "one big field, not a list" response shape.
export function capContent(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const raw = Buffer.from(content, "utf8");
  if (raw.length <= maxBytes) return { content, truncated: false };
  return { content: raw.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export interface NotionMcpOpts {
  defaultPageSize?: number;
  maxPageSize?: number;
}

export class NotionMcp {
  private backend: NotionBackend;
  private defaultPageSize: number;
  private maxPageSize: number;

  constructor(backend: NotionBackend = new StubNotion(), opts: NotionMcpOpts = {}) {
    this.backend = backend;
    this.defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPageSize = opts.maxPageSize ?? MAX_PAGE_SIZE;
  }

  private pageSize(args: any): number {
    const n = Number(args?.pageSize ?? this.defaultPageSize);
    if (!Number.isFinite(n)) return this.defaultPageSize;
    return Math.min(Math.max(Math.trunc(n), 1), this.maxPageSize);
  }

  // The MCP tool surface: exactly the §14 tool names, preserving the pre-existing tool names/shape
  // (search/read_page/create_page already matched §14; update_page is the one addition). Reads:
  // search, read_page. Writes: create_page, update_page — kept distinct from reads so a later
  // gateway registration pass can egress-classify them independently (§17.6.2).
  tools(): Record<string, (args: any, ctx: ToolContext) => Promise<unknown>> {
    return {
      "notion.search": (a, ctx) => this.guarded("notion.search", a, () => this.search(a, ctx)),
      "notion.read_page": (a, ctx) => this.guarded("notion.read_page", a, () => this.readPage(a, ctx)),
      "notion.create_page": (a, ctx) => this.guarded("notion.create_page", a, () => this.createPage(a, ctx)),
      "notion.update_page": (a, ctx) => this.guarded("notion.update_page", a, () => this.updatePage(a, ctx)),
    };
  }

  private async guarded(tool: string, args: any, run: () => Promise<unknown>): Promise<unknown> {
    const problem = validate(TOOL_SCHEMAS[tool].inputSchema, args ?? {});
    if (problem) return { error: { code: "E_VALIDATION", message: problem } };
    return run();
  }

  private async search(args: any, ctx: ToolContext) {
    const page = await this.backend.search(
      String(args.query),
      { cursor: args.cursor ? String(args.cursor) : undefined, pageSize: this.pageSize(args) },
      ctx,
    );
    const { json, truncated } = truncateJson(page, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as NotionPage<NotionPageSummary>), truncated };
  }

  private async readPage(args: any, ctx: ToolContext) {
    const id = String(args.id);
    const result = await this.backend.readPage(id, ctx);
    if (!result) return { error: { code: "E_NOT_FOUND", message: `page not found: ${id}` } };
    const capped = capContent(result.content, MAX_CONTENT_BYTES);
    return { id: result.id, title: result.title, url: result.url, content: capped.content, truncated: capped.truncated };
  }

  private async createPage(args: any, ctx: ToolContext) {
    return this.backend.createPage(String(args.parentId), String(args.title), String(args.content ?? ""), ctx);
  }

  private async updatePage(args: any, ctx: ToolContext) {
    if (args.title === undefined && args.appendContent === undefined) {
      return { error: { code: "E_VALIDATION", message: "update_page requires at least one of title or appendContent" } };
    }
    const id = String(args.id);
    const result = await this.backend.updatePage(id, {
      title: args.title !== undefined ? String(args.title) : undefined,
      appendContent: args.appendContent !== undefined ? String(args.appendContent) : undefined,
    }, ctx);
    if (!result) return { error: { code: "E_NOT_FOUND", message: `page not found: ${id}` } };
    return { ...result, updated: true };
  }
}

// JSON Schema for each tool's input (instructions.md §14 "schémas d'arguments stricts"). Enforced
// at runtime by validate() above via NotionMcp.guarded(), not just documentation.
export const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  "notion.search": {
    description: "Search pages visible to the connected Notion integration by title/content, paginated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 500 },
        pageSize: { type: "number", description: `Pages per page (1-${MAX_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
      required: ["query"],
    },
  },
  "notion.read_page": {
    description: "Read a page's title and content (content capped at 256 KB).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", maxLength: 100, description: "Notion page ID." } },
      required: ["id"],
    },
  },
  "notion.create_page": {
    description: "Create a new page under a parent page.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        parentId: { type: "string", maxLength: 100, description: "Parent page ID the new page is created under." },
        title: { type: "string", maxLength: 2000 },
        content: { type: "string", description: "Initial page body (plain text, one paragraph block)." },
      },
      required: ["parentId", "title"],
    },
  },
  "notion.update_page": {
    description: "Rename a page and/or append content to it. At least one of title/appendContent is required.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        id: { type: "string", maxLength: 100 },
        title: { type: "string", maxLength: 2000, description: "New page title, if renaming." },
        appendContent: { type: "string", description: "Plain text appended as a new paragraph block." },
      },
      required: ["id"],
    },
  },
};
