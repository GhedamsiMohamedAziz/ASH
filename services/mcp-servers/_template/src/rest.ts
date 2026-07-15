// Real backend template (instructions.md §14.3) — the money/blast-radius edge for a real
// connector. TODO(connector): replace the base URL, auth header shape and endpoint paths with the
// real upstream API. Implements the SAME ExampleBackend interface as StubBackend, so
// `new TemplateMcp(new RestBackend())` makes every tool call real with zero change to the tool
// surface — mirrors services/mcp-servers/github/src/rest.ts, but built on the reusable
// ResilientHttpClient (http-client.ts) instead of raw fetch, so retries/breaker/timeout are
// shared instead of hand-rolled per connector.

import type { ExampleBackend, ExampleItem, ToolContext } from "./connector.ts";
import { ResilientHttpClient } from "./http-client.ts";

// A typed error carrying a §21 taxonomy code so the gateway/prompt-layer can map it.
export class UpstreamApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "UpstreamApiError";
    this.code = code;
    this.status = status;
  }
}

// TODO(connector): tune this map to the real upstream's status codes; every branch must resolve
// to a §21 taxonomy code so failures are named, never a silent 200-that-wasn't (packages/errors).
function mapStatus(status: number, body: string): UpstreamApiError {
  if (status === 401) return new UpstreamApiError("E_CONN_TOKEN_EXPIRED", status, "upstream token invalid or expired");
  if (status === 403 || status === 429) return new UpstreamApiError("E_RATE_LIMITED", status, "upstream rate limit hit");
  if (status === 404) return new UpstreamApiError("E_CONN_NEEDS_CONNECTION", status, "upstream resource not found or no access");
  return new UpstreamApiError("E_TOOL_UPSTREAM_ERROR", status, `upstream error ${status}: ${body.slice(0, 200)}`);
}

export class RestBackend implements ExampleBackend {
  private base: string;
  private client: ResilientHttpClient;

  constructor(opts: { base?: string; fetchImpl?: typeof fetch } = {}) {
    // TODO(connector): real base URL, typically from an env var (e.g. CONNECTOR_BASE_URL).
    this.base = opts.base ?? "https://api.example.invalid";
    this.client = new ResilientHttpClient({ fetchImpl: opts.fetchImpl });
  }

  private token(ctx: ToolContext): string {
    // Prod: the per-user/org token comes ONLY from ctx.credential (gateway-injected from Vault,
    // §13.2). No ambient-env fallback — an empty credential must fail closed (confused-deputy
    // guard: never silently escalate every requester to one shared token).
    if (ctx.credential) return ctx.credential;
    throw new UpstreamApiError("E_CONN_NEEDS_CONNECTION", 401, "no credential for this user");
  }

  async read(resource: string, ctx: ToolContext): Promise<ExampleItem[]> {
    const token = this.token(ctx); // resolve first — a missing credential is its own named error
    let res: Response;
    try {
      // TODO(connector): real path/query params for the resource being read.
      res = await this.client.request(`${this.base}/items?resource=${encodeURIComponent(resource)}`, {
        headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      });
    } catch (err) {
      throw new UpstreamApiError("E_TOOL_UPSTREAM_ERROR", 0, `upstream request failed: ${(err as Error).message}`);
    }
    const text = await res.text();
    if (!res.ok) throw mapStatus(res.status, text);
    const data = text ? JSON.parse(text) : { items: [] };
    // TODO(connector): map the real response shape onto ExampleItem[].
    return (data.items ?? []) as ExampleItem[];
  }
}
