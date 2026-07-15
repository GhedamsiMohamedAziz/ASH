// M365 MCP server (instructions.md §14 "Bureautique & communication: Outlook: lire, chercher,
// résumer, envoyer (sous approbation); Calendrier: créer des événements...; SharePoint/OneDrive:
// chercher, lire, livrer" and §997's Graph tool table). Delegated (OBO): the Gateway injects the
// user's Microsoft Graph token (§13.2) as ctx.credential, so this layer never sees a raw token.
//
// This connector exposes the outlook/calendar/SharePoint slice behind the FIVE pre-existing tool
// names the gateway already registered (services/mcp-gateway/src/server.ts's M365_META +
// src/mcp.ts's m365_* schemas) — list_mail, read_mail, send_mail, search_files, create_event —
// kept unchanged by name and by (args, ctx) handler shape so that registration keeps working
// untouched by this pass. Reads (list_mail/read_mail/search_files) ingest untrusted mail/file
// content authored by arbitrary senders and taint the turn; send_mail is public egress and is
// approval-gated on a tainted turn (§17.6.2 — enforced by the gateway via M365_META, not here).
//
// Mirrors services/mcp-servers/slack/src/slack.ts and notion/src/notion.ts: a StubM365 backend
// (offline, deterministic) so the whole chain runs with no token/network, and a real backend
// (graph.ts) that drops in behind the SAME M365Backend interface with zero change to the tool
// surface. list_mail/search_files are paginated and every response truncated to 256 KB
// (instructions.md §14 "règles communes") via the shared
// services/mcp-servers/_template/src/pagination.ts helper (same one database.ts/slack.ts/
// notion.ts use); read_mail's body is capped the same way notion.ts caps read_page's content.
// Every tool's args are validated against a strict JSON Schema before the backend is ever called
// — a malformed call never reaches Graph.

import { paginate, truncateJson, MAX_RESPONSE_BYTES } from "../../_template/src/pagination.ts";

export interface ToolContext {
  userId: string;
  orgId: string;
  credential: string; // delegated Graph OBO token injected by the gateway from Vault (§13.2)
}
// Back-compat alias for the connector's original context type name — the gateway only imports
// `M365Backend` by name (services/mcp-gateway/src/server.ts), never `Ctx` itself, but the alias is
// kept so any structural reference to the old name still resolves. ToolContext is a strict
// superset of the old {credential, userId} shape (adds orgId, which the gateway's real ctx object
// always carries — see services/mcp-gateway/src/gateway.ts's `{ userId: subject, orgId: ..., credential }`).
export type Ctx = ToolContext;

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;
const MAX_BODY_BYTES = 256 * 1024;

export interface MailSummary {
  id: string;
  subject: string;
  from: string;
}

export interface MailContent {
  id: string;
  subject: string;
  from: string;
  body: string;
}

export interface FileHit {
  name: string;
  path: string;
  webUrl: string;
}

export interface M365Page<T> {
  items: T[];
  nextCursor?: string;
}

// Backend the façade calls. Injected so tests need no real Graph tenant (mirrors SlackBackend/
// NotionBackend). listMail/searchFiles paginate natively (own {cursor, pageSize}) — a mailbox or
// a SharePoint/OneDrive result set can be arbitrarily large, so pagination has to be native to the
// backend call, not layered on top of an already-fetched full array.
export interface M365Backend {
  listMail(folder: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<M365Page<MailSummary>>;
  readMail(id: string, ctx: ToolContext): Promise<MailContent | null>;
  sendMail(to: string, subject: string, body: string, ctx: ToolContext): Promise<{ id: string }>;
  searchFiles(query: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<M365Page<FileHit>>;
  createEvent(title: string, startIso: string, ctx: ToolContext): Promise<{ id: string }>;
}

// Deterministic offline backend — same input yields the same output, no token, no network. Stands
// in for the real Graph API on the dev/test path (default backend for M365Mcp). "m1" keeps
// returning a message whose subject contains "Q3 review" — services/mcp-gateway/test/
// connectors.test.ts asserts on that exact stub content through the gateway, so this seed must stay.
export class StubM365 implements M365Backend {
  private mail = new Map<string, MailContent>([
    ["m1", { id: "m1", subject: "Q3 review", from: "ceo@acme.com", body: "Please prepare the numbers for the Q3 review." }],
    ["m2", { id: "m2", subject: "Welcome to the team", from: "hr@acme.com", body: "Welcome aboard — here is your onboarding checklist." }],
  ]);
  private seq = 1000;

  async listMail(folder: string, opts: { cursor?: string; pageSize: number }): Promise<M365Page<MailSummary>> {
    const seeded: MailSummary[] = [...this.mail.values()].map(({ id, subject, from }) => ({ id, subject, from }));
    // Padded with deterministic extra hits so pagination has something to page through even for
    // the default two-message inbox — mirrors StubSlack.readChannel / StubNotion.search.
    const extra: MailSummary[] = Array.from({ length: 30 }, (_, i) => ({
      id: `m365_stub_${i}`, subject: `stub subject ${i} in ${folder}`, from: `user${(i % 5) + 1}@acme.com`,
    }));
    return paginate([...seeded, ...extra], opts.cursor, opts.pageSize);
  }

  async readMail(id: string): Promise<MailContent | null> {
    const m = this.mail.get(id);
    return m ? { ...m } : null;
  }

  async sendMail(_to: string, _subject: string, _body: string): Promise<{ id: string }> {
    this.seq += 1;
    return { id: `sent_${this.seq}` };
  }

  async searchFiles(query: string, opts: { cursor?: string; pageSize: number }): Promise<M365Page<FileHit>> {
    const seeded: FileHit[] = [
      { name: `${query}.xlsx`, path: `sites/finance/${query}.xlsx`, webUrl: `https://acme.sharepoint.com/sites/finance/${query}.xlsx` },
    ];
    const extra: FileHit[] = Array.from({ length: 30 }, (_, i) => ({
      name: `stub_${i}_${query}.docx`,
      path: `sites/stub/stub_${i}_${query}.docx`,
      webUrl: `https://acme.sharepoint.com/sites/stub/stub_${i}_${query}.docx`,
    }));
    return paginate([...seeded, ...extra], opts.cursor, opts.pageSize);
  }

  async createEvent(_title: string, _startIso: string): Promise<{ id: string }> {
    this.seq += 1;
    return { id: `evt_${this.seq}` };
  }
}

// Minimal dependency-free JSON Schema validator — checks required fields, rejects unknown fields
// when additionalProperties is false, and checks declared type/maxLength/enum. Mirrors
// services/mcp-servers/_template/src/server.ts's validateArgs (and slack.ts's/notion.ts's copy —
// kept duplicated per-connector rather than factored into a shared file outside this connector's
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

// Caps a single text field at maxBytes (UTF-8) — read_mail's body isn't an `items` array, so
// truncateJson's array-slicing strategy doesn't apply. Mirrors notion.ts's capContent for the same
// "one big field, not a list" response shape.
export function capBody(content: string, maxBytes: number): { content: string; truncated: boolean } {
  const raw = Buffer.from(content, "utf8");
  if (raw.length <= maxBytes) return { content, truncated: false };
  return { content: raw.subarray(0, maxBytes).toString("utf8"), truncated: true };
}

export interface M365McpOpts {
  defaultPageSize?: number;
  maxPageSize?: number;
}

export class M365Mcp {
  private backend: M365Backend;
  private defaultPageSize: number;
  private maxPageSize: number;

  constructor(backend: M365Backend = new StubM365(), opts: M365McpOpts = {}) {
    this.backend = backend;
    this.defaultPageSize = opts.defaultPageSize ?? DEFAULT_PAGE_SIZE;
    this.maxPageSize = opts.maxPageSize ?? MAX_PAGE_SIZE;
  }

  private pageSize(args: any): number {
    const n = Number(args?.pageSize ?? this.defaultPageSize);
    if (!Number.isFinite(n)) return this.defaultPageSize;
    return Math.min(Math.max(Math.trunc(n), 1), this.maxPageSize);
  }

  // The MCP tool surface — EXACTLY the 5 tool names the gateway already registered (§14), unchanged
  // by name and by (args, ctx) handler shape. Reads: list_mail, read_mail, search_files. Writes:
  // send_mail, create_event.
  tools(): Record<string, (args: any, ctx: ToolContext) => Promise<unknown>> {
    return {
      "m365.list_mail": (a, ctx) => this.guarded("m365.list_mail", a, () => this.listMail(a, ctx)),
      "m365.read_mail": (a, ctx) => this.guarded("m365.read_mail", a, () => this.readMail(a, ctx)),
      "m365.send_mail": (a, ctx) => this.guarded("m365.send_mail", a, () => this.sendMail(a, ctx)),
      "m365.search_files": (a, ctx) => this.guarded("m365.search_files", a, () => this.searchFiles(a, ctx)),
      "m365.create_event": (a, ctx) => this.guarded("m365.create_event", a, () => this.createEvent(a, ctx)),
    };
  }

  private async guarded(tool: string, args: any, run: () => Promise<unknown>): Promise<unknown> {
    const problem = validate(TOOL_SCHEMAS[tool].inputSchema, args ?? {});
    if (problem) return { error: { code: "E_VALIDATION", message: problem } };
    return run();
  }

  private async listMail(args: any, ctx: ToolContext) {
    const page = await this.backend.listMail(
      String(args.folder ?? "inbox"),
      { cursor: args.cursor ? String(args.cursor) : undefined, pageSize: this.pageSize(args) },
      ctx,
    );
    const { json, truncated } = truncateJson(page, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as M365Page<MailSummary>), truncated };
  }

  private async readMail(args: any, ctx: ToolContext) {
    const id = String(args.id);
    const result = await this.backend.readMail(id, ctx);
    if (!result) return { error: { code: "E_NOT_FOUND", message: `message not found: ${id}` } };
    const capped = capBody(result.body, MAX_BODY_BYTES);
    return { id: result.id, subject: result.subject, from: result.from, body: capped.content, truncated: capped.truncated };
  }

  private async sendMail(args: any, ctx: ToolContext) {
    return this.backend.sendMail(String(args.to), String(args.subject), String(args.body), ctx);
  }

  private async searchFiles(args: any, ctx: ToolContext) {
    const page = await this.backend.searchFiles(
      String(args.query),
      { cursor: args.cursor ? String(args.cursor) : undefined, pageSize: this.pageSize(args) },
      ctx,
    );
    const { json, truncated } = truncateJson(page, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as M365Page<FileHit>), truncated };
  }

  private async createEvent(args: any, ctx: ToolContext) {
    return this.backend.createEvent(String(args.title), String(args.start), ctx);
  }
}

// JSON Schema for each tool's input (instructions.md §14 "schémas d'arguments stricts"). Enforced
// at runtime by validate() above via M365Mcp.guarded(), not just documentation — a call with a
// missing required field, a wrong-typed field, an over-long string or an unknown field is rejected
// with E_VALIDATION before the backend (real or stub) is ever reached. Field names match the ones
// the gateway's own MCP-facing schemas already use (services/mcp-gateway/src/mcp.ts's m365_* tools:
// folder, id, to/subject/body, query, title/start) — pageSize/cursor are additive, optional
// pagination controls not yet surfaced by the gateway's outer schema, harmless either way.
export const TOOL_SCHEMAS: Record<string, { description: string; inputSchema: Record<string, unknown> }> = {
  "m365.list_mail": {
    description: "List messages in an Outlook mail folder (default inbox), paginated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        folder: { type: "string", maxLength: 255, description: "Mail folder name or id (default inbox)." },
        pageSize: { type: "number", description: `Messages per page (1-${MAX_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
    },
  },
  "m365.read_mail": {
    description: "Read one Outlook message's subject, sender, and body (body capped at 256 KB).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { id: { type: "string", maxLength: 500, description: "Message id." } },
      required: ["id"],
    },
  },
  "m365.send_mail": {
    description: "Send an Outlook email. Public egress — approval-gated on a tainted turn (§17.6.2).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        to: { type: "string", maxLength: 320, description: "Recipient address." },
        subject: { type: "string", maxLength: 998 },
        body: { type: "string", maxLength: 262144 },
      },
      required: ["to", "subject", "body"],
    },
  },
  "m365.search_files": {
    description: "Search SharePoint / OneDrive files visible to the connected user, paginated.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        query: { type: "string", maxLength: 500 },
        pageSize: { type: "number", description: `Files per page (1-${MAX_PAGE_SIZE}).` },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
      required: ["query"],
    },
  },
  "m365.create_event": {
    description: "Create an event on the user's own calendar (internal write — no external attendee parameter).",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 255 },
        start: { type: "string", maxLength: 40, description: "Event start (ISO 8601)." },
      },
      required: ["title", "start"],
    },
  },
};
