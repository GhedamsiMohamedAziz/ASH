// Slack MCP server (instructions.md §14 "Slack | Slack Web API | send_message, search_messages,
// read_channel, upload_file | User token OAuth Slack").
//
// Exposes Slack tools behind one interface; the MCP Gateway (§13) injects the user's Slack OAuth
// token and enforces AuthZ, so this layer never sees a raw token except via the ctx passed in.
// Distinct from the inbound slack-adapter (apps/slack-adapter), which handles Slack's webhook
// events INTO the platform — this is the outbound tool surface an agent calls.
//
// Mirrors services/mcp-servers/github/src/github.ts: a StubSlack backend (offline, deterministic)
// so the whole chain runs with no token/network, and a real backend (webapi.ts) that drops in
// behind the SAME SlackBackend interface with zero change to the tool surface. Every list/read
// tool is paginated and its response truncated to 256 KB (instructions.md §14 "règles communes"),
// via the shared services/mcp-servers/_template/src/pagination.ts helper (same one database.ts
// and browser.ts use). Every tool's args are validated against a strict JSON Schema before the
// backend is ever called — a malformed call never reaches Slack.

import { paginate, truncateJson, MAX_RESPONSE_BYTES } from "../../_template/src/pagination.ts";

export interface ToolContext {
  userId: string;
  orgId: string;
  credential: string; // Slack user token injected by the gateway from Vault (§13.2)
}

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

export interface SlackMessage {
  ts: string;
  user: string;
  text: string;
  threadTs?: string;
  replyCount?: number;
}

export interface SlackSearchHit {
  channel: string;
  ts: string;
  user: string;
  text: string;
  permalink: string;
}

export interface SlackFile {
  id: string;
  name: string;
  url: string;
  permalink: string;
}

export interface SlackPage<T> {
  items: T[];
  nextCursor?: string;
}

// Backend the façade calls. Injected so tests need no real Slack workspace (mirrors GithubBackend
// in services/mcp-servers/github/src/github.ts). Read methods take their own {cursor, pageSize} —
// unlike database.ts's DbBackend (which returns a full row set the MCP layer slices), a Slack
// channel/search result set can be arbitrarily large, so pagination has to be native to the
// backend call itself, not layered on top of an already-fetched full array.
export interface SlackBackend {
  readChannel(channel: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<SlackPage<SlackMessage>>;
  readThread(channel: string, threadTs: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<SlackPage<SlackMessage>>;
  searchMessages(query: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<SlackPage<SlackSearchHit>>;
  postMessage(channel: string, text: string, threadTs: string | undefined, ctx: ToolContext): Promise<{ ts: string; channel: string }>;
  uploadFile(channel: string, filename: string, content: string, title: string | undefined, ctx: ToolContext): Promise<SlackFile>;
}

// Deterministic offline backend — same input yields the same output, no token, no network.
// Stands in for the real Slack Web API on the dev/test path (default backend for SlackMcp).
export class StubSlack implements SlackBackend {
  private seq = 1000;

  async readChannel(channel: string, opts: { cursor?: string; pageSize: number }): Promise<SlackPage<SlackMessage>> {
    const all: SlackMessage[] = Array.from({ length: 47 }, (_, i) => ({
      ts: `170000${String(i).padStart(4, "0")}.000100`,
      user: `U${(i % 4) + 1}`,
      text: `stub message ${i} in #${channel}`,
      ...(i % 5 === 0 ? { threadTs: `170000${String(i).padStart(4, "0")}.000100`, replyCount: 2 } : {}),
    }));
    return paginate(all, opts.cursor, opts.pageSize);
  }

  async readThread(channel: string, threadTs: string, opts: { cursor?: string; pageSize: number }): Promise<SlackPage<SlackMessage>> {
    const all: SlackMessage[] = Array.from({ length: 8 }, (_, i) => ({
      ts: `${threadTs}.reply${i}`,
      user: `U${(i % 3) + 1}`,
      text: `stub reply ${i} to ${threadTs} in #${channel}`,
      threadTs,
    }));
    return paginate(all, opts.cursor, opts.pageSize);
  }

  async searchMessages(query: string, opts: { cursor?: string; pageSize: number }): Promise<SlackPage<SlackSearchHit>> {
    const all: SlackSearchHit[] = Array.from({ length: 33 }, (_, i) => ({
      channel: `C${(i % 5) + 1}`,
      ts: `169900${String(i).padStart(4, "0")}.000100`,
      user: `U${(i % 4) + 1}`,
      text: `stub result ${i} mentioning ${query}`,
      permalink: `https://olma-stub.slack.com/archives/C${(i % 5) + 1}/p${i}`,
    }));
    return paginate(all, opts.cursor, opts.pageSize);
  }

  async postMessage(channel: string, _text: string, _threadTs: string | undefined): Promise<{ ts: string; channel: string }> {
    this.seq += 1;
    return { ts: `${1700000000 + this.seq}.000000`, channel };
  }

  async uploadFile(channel: string, filename: string, _content: string, _title: string | undefined): Promise<SlackFile> {
    this.seq += 1;
    const id = `F${this.seq.toString(16).toUpperCase()}`;
    return {
      id,
      name: filename,
      url: `https://files.olma-stub.slack.com/${channel}/${id}/${filename}`,
      permalink: `https://olma-stub.slack.com/files/${channel}/${id}/${filename}`,
    };
  }
}

// Minimal dependency-free JSON Schema validator — checks required fields, rejects unknown fields
// when additionalProperties is false, and checks declared type/maxLength/enum. Mirrors
// services/mcp-servers/_template/src/server.ts's validateArgs, extended with the constraints this
// connector's schemas actually use. Not a full JSON Schema validator (no $ref, no nested object
// schemas) — every tool arg here is a flat scalar, which this fully covers.
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

export interface SlackMcpOpts {
  defaultPageSize?: number;
  maxPageSize?: number;
}

export class SlackMcp {
  private backend: SlackBackend;
  private defaultPageSize: number;
  private maxPageSize: number;

  constructor(backend: SlackBackend = new StubSlack(), opts: SlackMcpOpts = {}) {
    this.backend = backend;
    this.defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPageSize = opts.maxPageSize ?? MAX_PAGE_SIZE;
  }

  private pageSize(args: any): number {
    const n = Number(args?.pageSize ?? this.defaultPageSize);
    if (!Number.isFinite(n)) return this.defaultPageSize;
    return Math.min(Math.max(Math.trunc(n), 1), this.maxPageSize);
  }

  // The MCP tool surface (§14 tool names) + `slack.post_recap`, the pre-existing tool from before
  // this hardening pass, kept for back-compat (see postRecap below). Reads: read_channel,
  // read_thread, search_messages. Writes: send_message, post_recap, upload_file — kept as
  // distinct, separately named tools so a later gateway registration pass can egress-classify
  // reads vs writes independently (§17.6.2), without touching this file again.
  tools(): Record<string, (args: any, ctx: ToolContext) => Promise<unknown>> {
    return {
      "slack.read_channel": (a, ctx) => this.guarded("slack.read_channel", a, () => this.readChannel(a, ctx)),
      "slack.read_thread": (a, ctx) => this.guarded("slack.read_thread", a, () => this.readThread(a, ctx)),
      "slack.search_messages": (a, ctx) => this.guarded("slack.search_messages", a, () => this.searchMessages(a, ctx)),
      "slack.send_message": (a, ctx) => this.guarded("slack.send_message", a, () => this.sendMessage(a, ctx)),
      "slack.post_recap": (a, ctx) => this.guarded("slack.post_recap", a, () => this.postRecap(a, ctx)),
      "slack.upload_file": (a, ctx) => this.guarded("slack.upload_file", a, () => this.uploadFile(a, ctx)),
    };
  }

  private async guarded(tool: string, args: any, run: () => Promise<unknown>): Promise<unknown> {
    const problem = validate(TOOL_SCHEMAS[tool].inputSchema, args ?? {});
    if (problem) return { error: { code: "E_VALIDATION", message: problem } };
    return run();
  }

  private async readChannel(args: any, ctx: ToolContext) {
    const page = await this.backend.readChannel(
      String(args.channel),
      { cursor: args.cursor ? String(args.cursor) : undefined, pageSize: this.pageSize(args) },
      ctx,
    );
    const { json, truncated } = truncateJson(page, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as SlackPage<SlackMessage>), truncated };
  }

  private async readThread(args: any, ctx: ToolContext) {
    const page = await this.backend.readThread(
      String(args.channel),
      String(args.threadTs),
      { cursor: args.cursor ? String(args.cursor) : undefined, pageSize: this.pageSize(args) },
      ctx,
    );
    const { json, truncated } = truncateJson(page, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as SlackPage<SlackMessage>), truncated };
  }

  private async searchMessages(args: any, ctx: ToolContext) {
    const page = await this.backend.searchMessages(
      String(args.query),
      { cursor: args.cursor ? String(args.cursor) : undefined, pageSize: this.pageSize(args) },
      ctx,
    );
    const { json, truncated } = truncateJson(page, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as SlackPage<SlackSearchHit>), truncated };
  }

  private async sendMessage(args: any, ctx: ToolContext) {
    return this.backend.postMessage(String(args.channel), String(args.text), args.threadTs ? String(args.threadTs) : undefined, ctx);
  }

  // Pre-existing tool (see git history), preserved verbatim by name/shape: a lightweight
  // top-level-only recap post. Delegates to the same backend.postMessage as send_message rather
  // than duplicating the write path.
  private async postRecap(args: any, ctx: ToolContext) {
    const { ts } = await this.backend.postMessage(String(args.channel), String(args.text), undefined, ctx);
    return { ts };
  }

  private async uploadFile(args: any, ctx: ToolContext) {
    return this.backend.uploadFile(
      String(args.channel),
      String(args.filename),
      String(args.content),
      args.title ? String(args.title) : undefined,
      ctx,
    );
  }
}

// JSON Schema for each tool's input (instructions.md §14 "schémas d'arguments stricts"). Enforced
// at runtime by validate() above via SlackMcp.guarded(), not just documentation — a call with a
// missing required field, a wrong-typed field, an over-long string or an unknown field is rejected
// with E_VALIDATION before the backend (real or stub) is ever reached.
export const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  "slack.read_channel": {
    description: "Read recent messages from a Slack channel, paginated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", maxLength: 32, description: "Channel ID, e.g. C0123456789." },
        pageSize: { type: "number", description: `Messages per page (1-${MAX_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
      required: ["channel"],
    },
  },
  "slack.read_thread": {
    description: "Read the replies in a Slack thread, paginated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", maxLength: 32 },
        threadTs: { type: "string", maxLength: 32, description: "The parent message's ts." },
        pageSize: { type: "number" },
        cursor: { type: "string" },
      },
      required: ["channel", "threadTs"],
    },
  },
  "slack.search_messages": {
    description: "Search messages across the workspace (search.messages requires a user token — see README).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 500 },
        pageSize: { type: "number" },
        cursor: { type: "string" },
      },
      required: ["query"],
    },
  },
  "slack.send_message": {
    description: "Post a message to a Slack channel, optionally as a threaded reply.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", maxLength: 32 },
        text: { type: "string", maxLength: 40000 },
        threadTs: { type: "string", maxLength: 32, description: "Reply in this thread instead of posting top-level." },
      },
      required: ["channel", "text"],
    },
  },
  "slack.post_recap": {
    description: "Post a lightweight top-level recap message to a Slack channel (pre-existing tool; no threading).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", maxLength: 32 },
        text: { type: "string", maxLength: 40000 },
      },
      required: ["channel", "text"],
    },
  },
  "slack.upload_file": {
    description: "Upload a text file to a Slack channel.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        channel: { type: "string", maxLength: 32 },
        filename: { type: "string", maxLength: 256 },
        content: { type: "string", description: "File content (UTF-8 text)." },
        title: { type: "string", maxLength: 256 },
      },
      required: ["channel", "filename", "content"],
    },
  },
};
