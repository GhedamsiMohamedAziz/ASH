// Real Slack Web API backend (instructions.md §14 "Slack | Slack Web API | ... | User token OAuth
// Slack") — the network edge.
//
// Implements the identical SlackBackend interface as StubSlack, so `new SlackMcp(new
// WebApiBackend())` makes every tool call real with zero change to the tool surface. Talks to
// Slack's plain HTTPS/JSON REST endpoints directly with the native fetch — no @slack/web-api
// dependency, matching services/mcp-servers/github/src/rest.ts's precedent: GitHub's REST API
// needed no Octokit SDK, and Slack's Web API is exactly as plain a JSON-over-HTTPS surface. This
// keeps the real backend "injectable, not a hard dependency" (no package to lazy-import at all,
// which is a stronger guarantee than an optional lazy import — the offline/keyless default path
// never even has an unresolved import to skip).
//
// The token is NEVER read from source: it comes per-call from ctx.credential, which the gateway
// injects from Vault (§13.2) — the real user token, scoped by policy. `search.messages` in
// particular requires a USER token, not a bot token — matches the "User token OAuth Slack"
// identity in §14. A GITHUB_TOKEN-style env fallback exists only for the standalone demo.
//
// Slack's Web API is unusual: almost every failure still returns HTTP 200 with a JSON body of
// `{ ok: false, error: "<code>" }` — a real rate limit is the one case that surfaces as an actual
// HTTP 429 (with a Retry-After header Slack expects the caller to honor). Both shapes are mapped
// to the same §21 taxonomy below so the layers above see one named error, never a silent 200.

import type { SlackBackend, SlackFile, SlackMessage, SlackPage, SlackSearchHit, ToolContext } from "./slack.ts";

export class SlackApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "SlackApiError";
    this.code = code;
    this.status = status;
  }
}

// Slack `error` strings that mean "you're not who you claim to be" -> reconnect.
const TOKEN_ERRORS = new Set(["invalid_auth", "token_expired", "token_revoked", "account_inactive"]);
// Slack `error` strings that mean "there is no valid connection at all" -> connect first.
const NEEDS_CONNECTION_ERRORS = new Set(["not_authed", "no_permission", "org_login_required"]);
// Slack `error` strings that mean the token lacks a required OAuth scope -> denied by policy.
const PERM_DENIED_ERRORS = new Set(["missing_scope", "restricted_action", "ekm_access_denied"]);
// Slack `error` strings that mean the target doesn't exist or isn't visible to this token —
// indistinguishable by design (same ambiguity as GitHub's 404, see rest.ts).
const NOT_FOUND_ERRORS = new Set(["channel_not_found", "thread_not_found", "user_not_found", "page_not_found", "file_not_found"]);

function mapSlackError(error: string, status: number): SlackApiError {
  if (error === "ratelimited") return new SlackApiError("E_RATE_LIMITED", status, "Slack rate limit hit");
  if (TOKEN_ERRORS.has(error)) return new SlackApiError("E_CONN_TOKEN_EXPIRED", status, `Slack token invalid or expired: ${error}`);
  if (NEEDS_CONNECTION_ERRORS.has(error)) return new SlackApiError("E_CONN_NEEDS_CONNECTION", status, `no valid Slack connection: ${error}`);
  if (PERM_DENIED_ERRORS.has(error)) return new SlackApiError("E_PERM_TOOL_DENIED", status, `Slack denied the action: ${error}`);
  if (NOT_FOUND_ERRORS.has(error)) return new SlackApiError("E_CONN_NEEDS_CONNECTION", status, `Slack resource not found or no access: ${error}`);
  return new SlackApiError("E_TOOL_UPSTREAM_ERROR", status, `Slack error: ${error}`);
}

function mapHttpStatus(status: number, body: string): SlackApiError {
  if (status === 429) return new SlackApiError("E_RATE_LIMITED", status, "Slack rate limit hit");
  if (status >= 500) return new SlackApiError("E_TOOL_UPSTREAM_ERROR", status, `Slack upstream error ${status}`);
  return new SlackApiError("E_TOOL_UPSTREAM_ERROR", status, `Slack HTTP error ${status}: ${body.slice(0, 200)}`);
}

export interface WebApiBackendOpts {
  base?: string;
  fetchImpl?: typeof fetch;
}

export class WebApiBackend implements SlackBackend {
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(opts: WebApiBackendOpts = {}) {
    this.base = opts.base ?? "https://slack.com/api";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private token(ctx: ToolContext): string {
    if (ctx.credential) return ctx.credential;
    if (process.env.OLMA_STANDALONE_DEMO === "1" && process.env.SLACK_TOKEN) return process.env.SLACK_TOKEN;
    throw new SlackApiError("E_CONN_NEEDS_CONNECTION", 401, "no Slack credential for this user");
  }

  private async call(method: "GET" | "POST", path: string, ctx: ToolContext, params?: Record<string, string | number | undefined>): Promise<any> {
    const token = this.token(ctx); // resolve first — a missing credential is its own named error
    let res: Response;
    try {
      if (method === "GET") {
        const query = new URLSearchParams();
        for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) query.set(k, String(v));
        res = await this.fetchImpl(`${this.base}${path}?${query.toString()}`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        });
      } else {
        res = await this.fetchImpl(`${this.base}${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify(params ?? {}), // JSON.stringify drops undefined-valued keys itself
        });
      }
    } catch (err) {
      // Network/DNS/timeout before any HTTP status — a real failure, named not swallowed.
      throw new SlackApiError("E_TOOL_UPSTREAM_ERROR", 0, `Slack request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw mapHttpStatus(res.status, text);
    const data = text ? JSON.parse(text) : {};
    if (data.ok === false) throw mapSlackError(String(data.error ?? "unknown_error"), res.status);
    return data;
  }

  async readChannel(channel: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<SlackPage<SlackMessage>> {
    const data = await this.call("GET", "/conversations.history", ctx, {
      channel, cursor: opts.cursor, limit: opts.pageSize,
    });
    const items: SlackMessage[] = (data.messages ?? []).map((m: any) => ({
      ts: m.ts,
      user: m.user ?? m.bot_id ?? "",
      text: m.text ?? "",
      ...(m.thread_ts ? { threadTs: m.thread_ts, replyCount: m.reply_count } : {}),
    }));
    return { items, nextCursor: data.response_metadata?.next_cursor || undefined };
  }

  async readThread(channel: string, threadTs: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<SlackPage<SlackMessage>> {
    const data = await this.call("GET", "/conversations.replies", ctx, {
      channel, ts: threadTs, cursor: opts.cursor, limit: opts.pageSize,
    });
    const items: SlackMessage[] = (data.messages ?? []).map((m: any) => ({
      ts: m.ts, user: m.user ?? m.bot_id ?? "", text: m.text ?? "", threadTs,
    }));
    return { items, nextCursor: data.response_metadata?.next_cursor || undefined };
  }

  async searchMessages(query: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<SlackPage<SlackSearchHit>> {
    // search.messages paginates by page NUMBER, not a native cursor. The cursor we hand back/take
    // in is that page number as a string, kept opaque to callers exactly like every other tool.
    const requestedPage = opts.cursor ? Number(opts.cursor) : 1;
    const page = Number.isFinite(requestedPage) && requestedPage > 0 ? Math.trunc(requestedPage) : 1;
    const data = await this.call("GET", "/search.messages", ctx, { query, page, count: opts.pageSize });
    const matches = data.messages?.matches ?? [];
    const items: SlackSearchHit[] = matches.map((m: any) => ({
      channel: m.channel?.id ?? "", ts: m.ts, user: m.user ?? "", text: m.text ?? "", permalink: m.permalink ?? "",
    }));
    const paging = data.messages?.paging;
    const nextPage = paging && paging.page < paging.pages ? paging.page + 1 : undefined;
    return { items, nextCursor: nextPage ? String(nextPage) : undefined };
  }

  async postMessage(channel: string, text: string, threadTs: string | undefined, ctx: ToolContext): Promise<{ ts: string; channel: string }> {
    const data = await this.call("POST", "/chat.postMessage", ctx, { channel, text, thread_ts: threadTs });
    return { ts: data.ts, channel: data.channel ?? channel };
  }

  async uploadFile(channel: string, filename: string, content: string, title: string | undefined, ctx: ToolContext): Promise<SlackFile> {
    // Classic files.upload (JSON body, text content) — Slack's newer 3-step external-upload flow
    // (files.getUploadURLExternal -> PUT the bytes -> files.completeUploadExternal) is the
    // production path for large/binary files; out of scope for this UTF-8 text-content tool (see
    // README "Known limitations").
    const data = await this.call("POST", "/files.upload", ctx, { channels: channel, filename, content, title });
    const f = data.file ?? {};
    return { id: f.id ?? "", name: f.name ?? filename, url: f.url_private ?? "", permalink: f.permalink ?? "" };
  }
}
