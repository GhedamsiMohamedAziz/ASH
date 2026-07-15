// Real Microsoft Graph backend (instructions.md §14 / §997 "Teams/M365 MCP | Microsoft Graph | ...
// | Permissions déléguées Graph (token OBO de l'utilisateur)") — the network edge.
//
// Implements the identical M365Backend interface as StubM365, so `new M365Mcp(new GraphBackend())`
// makes every tool call real with zero change to the tool surface. Talks to the Graph v1.0 REST
// API (https://graph.microsoft.com/v1.0) directly with the native fetch — no
// @microsoft/microsoft-graph-client dependency, matching services/mcp-servers/github/src/rest.ts's
// precedent (GitHub's REST API needed no Octokit SDK; Graph's REST surface needs no Graph SDK
// either). This keeps the real backend injectable and not a hard dependency: there is no package
// to resolve at all on the offline/keyless default path.
//
// The token is NEVER read from source: it comes per-call from ctx.credential, the delegated OBO
// token the gateway injects from Vault (§13.2) — the real user's Graph token, scoped by policy. A
// missing credential fails closed with E_CONN_NEEDS_CONNECTION, never a silent fallback to a
// shared/ambient token (confused-deputy guard, mirrors rest.ts/webapi.ts/api.ts). An
// OLMA_STANDALONE_DEMO env fallback exists only for the standalone demo.
//
// Every Graph failure is mapped to the §21 error taxonomy so the layers above surface a named
// error, never a silent 200-that-wasn't: 401 -> E_CONN_TOKEN_EXPIRED (reconnect), 403 ->
// E_PERM_TOOL_DENIED, 404 -> E_CONN_NEEDS_CONNECTION (Graph returns the same generic
// ErrorItemNotFound/404 whether a resource doesn't exist or exists but isn't shared with this
// delegation — indistinguishable by design, the same ambiguity as GitHub's/Notion's 404), 400 ->
// E_VALIDATION, 429 -> E_RATE_LIMITED (Graph sends a Retry-After header, honored by the taxonomy's
// after_retry_after retry semantics upstream — not re-implemented here), 5xx -> E_TOOL_UPSTREAM_ERROR.
//
// Pagination follows Graph's two native shapes so both patterns are represented, per
// instructions.md §14 "Graph uses @odata.nextLink / $top / $skip": listMail follows the opaque
// `@odata.nextLink` (a full URL with an embedded $skiptoken) exactly the way Graph itself expects a
// client to page — the cursor IS that URL, never re-derived locally. searchFiles instead uses
// OneDrive/SharePoint search's $top/$skip, so its cursor is the next numeric offset (mirrors
// services/mcp-servers/slack/src/webapi.ts's search.messages page-number cursor).

import type { FileHit, M365Backend, M365Page, MailContent, MailSummary, ToolContext } from "./m365.ts";

export class GraphApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "GraphApiError";
    this.code = code;
    this.status = status;
  }
}

function mapStatus(status: number, body: string): GraphApiError {
  if (status === 401) return new GraphApiError("E_CONN_TOKEN_EXPIRED", status, "Graph token invalid or expired");
  if (status === 403) return new GraphApiError("E_PERM_TOOL_DENIED", status, "Graph denied access to this resource");
  if (status === 404) return new GraphApiError("E_CONN_NEEDS_CONNECTION", status, "Graph resource not found or not shared with this delegation");
  if (status === 400) return new GraphApiError("E_VALIDATION", status, `Graph validation error: ${body.slice(0, 200)}`);
  if (status === 429) return new GraphApiError("E_RATE_LIMITED", status, "Graph rate limit hit");
  if (status >= 500) return new GraphApiError("E_TOOL_UPSTREAM_ERROR", status, `Graph upstream error ${status}`);
  return new GraphApiError("E_TOOL_UPSTREAM_ERROR", status, `Graph error ${status}: ${body.slice(0, 200)}`);
}

export interface GraphBackendOpts {
  base?: string;
  fetchImpl?: typeof fetch;
}

export class GraphBackend implements M365Backend {
  private base: string;
  private fetchImpl: typeof fetch;

  constructor(opts: GraphBackendOpts = {}) {
    this.base = opts.base ?? "https://graph.microsoft.com/v1.0";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private token(ctx: ToolContext): string {
    // Prod: the per-user OBO token comes ONLY from ctx.credential (gateway-injected from Vault).
    // No ambient-env fallback — an empty credential must fail closed, never silently escalate
    // every requester to one shared token (confused deputy). The env fallback below is allowed
    // solely for the standalone demo, gated behind an explicit flag (mirrors rest.ts/webapi.ts/api.ts).
    if (ctx.credential) return ctx.credential;
    if (process.env.OLMA_STANDALONE_DEMO === "1" && process.env.MS_GRAPH_TOKEN) return process.env.MS_GRAPH_TOKEN;
    throw new GraphApiError("E_CONN_NEEDS_CONNECTION", 401, "no Microsoft Graph credential for this user");
  }

  // pathOrUrl may be a relative Graph path OR an absolute @odata.nextLink URL — Graph's nextLink is
  // opaque and already includes the host + $skiptoken, so it must be called AS IS, never
  // reprefixed with `this.base` (that would double the host and 404).
  private async call(method: string, pathOrUrl: string, ctx: ToolContext, body?: unknown): Promise<any> {
    const token = this.token(ctx); // resolve first — a missing credential is its own named error
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${this.base}${pathOrUrl}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      // Network/DNS/timeout before any HTTP status — a real failure, named not swallowed.
      throw new GraphApiError("E_TOOL_UPSTREAM_ERROR", 0, `Graph request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw mapStatus(res.status, text);
    return text ? JSON.parse(text) : {};
  }

  async listMail(folder: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<M365Page<MailSummary>> {
    const path = opts.cursor
      ? opts.cursor // a prior call's @odata.nextLink — opaque, called verbatim (see call() above)
      : `/me/mailFolders/${encodeURIComponent(folder)}/messages?$top=${opts.pageSize}&$select=id,subject,from`;
    const data = await this.call("GET", path, ctx);
    const items: MailSummary[] = (data.value ?? []).map((m: any) => ({
      id: m.id, subject: m.subject ?? "", from: m.from?.emailAddress?.address ?? "",
    }));
    return { items, nextCursor: data["@odata.nextLink"] || undefined };
  }

  async readMail(id: string, ctx: ToolContext): Promise<MailContent | null> {
    let data: any;
    try {
      data = await this.call("GET", `/me/messages/${encodeURIComponent(id)}?$select=id,subject,from,body`, ctx);
    } catch (err) {
      if (err instanceof GraphApiError && err.status === 404) return null;
      throw err;
    }
    return {
      id: data.id, subject: data.subject ?? "", from: data.from?.emailAddress?.address ?? "",
      body: data.body?.content ?? "",
    };
  }

  async sendMail(to: string, subject: string, body: string, ctx: ToolContext): Promise<{ id: string }> {
    // Graph's /me/sendMail is fire-and-forget (202 Accepted, no body) — no message id comes back.
    // So compose it as a draft first (POST /me/messages DOES return an id), then send that same
    // draft (POST /me/messages/{id}/send) — gives callers a real, referenceable message id.
    const draft = await this.call("POST", "/me/messages", ctx, {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: [{ emailAddress: { address: to } }],
    });
    await this.call("POST", `/me/messages/${encodeURIComponent(draft.id)}/send`, ctx);
    return { id: draft.id };
  }

  async searchFiles(query: string, opts: { cursor?: string; pageSize: number }, ctx: ToolContext): Promise<M365Page<FileHit>> {
    const skip = opts.cursor ? Number(opts.cursor) : 0;
    const safeSkip = Number.isFinite(skip) && skip >= 0 ? Math.trunc(skip) : 0;
    const data = await this.call(
      "GET",
      `/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${opts.pageSize}&$skip=${safeSkip}`,
      ctx,
    );
    const results = data.value ?? [];
    const items: FileHit[] = results.map((f: any) => ({
      name: f.name ?? "",
      path: f.parentReference?.path ? `${f.parentReference.path}/${f.name ?? ""}` : (f.name ?? ""),
      webUrl: f.webUrl ?? "",
    }));
    // Graph's drive search doesn't return a total count or nextLink here, so "more pages exist" is
    // inferred the same way slack/webapi.ts's search.messages page cursor does: a full page implies
    // there may be more; a short page is the last one.
    const nextSkip = safeSkip + results.length;
    return { items, nextCursor: results.length >= opts.pageSize ? String(nextSkip) : undefined };
  }

  async createEvent(title: string, startIso: string, ctx: ToolContext): Promise<{ id: string }> {
    const start = new Date(startIso);
    if (Number.isNaN(start.getTime())) {
      throw new GraphApiError("E_VALIDATION", 400, `invalid start date: ${startIso}`);
    }
    const end = new Date(start.getTime() + 30 * 60 * 1000); // default 30-minute event
    const data = await this.call("POST", "/me/events", ctx, {
      subject: title,
      start: { dateTime: start.toISOString(), timeZone: "UTC" },
      end: { dateTime: end.toISOString(), timeZone: "UTC" },
    });
    return { id: data.id };
  }
}
