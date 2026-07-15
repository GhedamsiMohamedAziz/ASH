// Template MCP connector (instructions.md §14.3, N3 "à créer une fois"). Copy this whole
// directory to services/mcp-servers/<connector>/ and:
//   1. rename the package (package.json "name") and this file to the connector's domain,
//   2. replace ExampleItem / ExampleBackend / StubBackend with the real domain shape and calls
//      (every TODO(connector) below marks a spot),
//   3. fill in rest.ts with the real upstream base URL / auth / endpoints,
//   4. update server.ts's TOOL_DEFS (name/description/inputSchema) to the real tool surface,
//   5. work the 9-point checklist in docs/connector-onboarding.md.
//
// Mirrors services/mcp-servers/github/src/github.ts: a StubBackend (offline, deterministic) so
// the whole chain runs with no token/network, and a real backend (rest.ts) that drops in behind
// the SAME interface with zero change to the tool surface. The MCP Gateway (§13) injects the
// credential and enforces AuthZ, so this layer never sees a raw user token except via ctx.

import { getTracer } from "./otel.ts";
import { paginate, truncateJson, MAX_RESPONSE_BYTES } from "./pagination.ts";

export interface ToolContext {
  userId: string;
  orgId: string;
  credential: string; // injected by the gateway from Vault (§13.2)
}

// TODO(connector): replace with the real domain shape returned by the connector's read tool(s).
export interface ExampleItem {
  id: string;
  title: string;
}

export interface PageResult {
  items: ExampleItem[];
  nextCursor?: string;
  truncated: boolean;
}

// TODO(connector): replace with the real tool surface — one method per tool this connector
// exposes (mirrors GithubBackend's searchCode/readFile/createPr/mergePr/listIssues shape).
export interface ExampleBackend {
  read(resource: string, ctx: ToolContext): Promise<ExampleItem[]>;
}

// Deterministic offline backend — same input yields the same output. Stands in for the real
// upstream API on the dev/test path (no token, no network). TODO(connector): swap these
// placeholder fixtures for representative sample data from the real domain.
export class StubBackend implements ExampleBackend {
  async read(resource: string): Promise<ExampleItem[]> {
    return Array.from({ length: 25 }, (_, i) => ({
      id: `${resource}-${i + 1}`,
      title: `stub item ${i + 1} for ${resource}`,
    }));
  }
}

// The MCP tool surface: maps tool names (as they appear in tool_policies and the TASK JWT
// allowed_tools, §13.4/§14) to backend calls. Every tool call runs inside an OTel span (§19) —
// a no-op by default (see otel.ts); a real exporter plugs in there without touching call sites.
export class TemplateMcp {
  private backend: ExampleBackend;
  constructor(backend: ExampleBackend = new StubBackend()) {
    this.backend = backend;
  }

  tools(): Record<string, (args: any, ctx: ToolContext) => Promise<unknown>> {
    return {
      // TODO(connector): rename "example.read" to "<connector>.<verb>" and add one entry per
      // additional tool, following this same read()-style pattern (span + paginate + truncate).
      "example.read": (a, ctx) => getTracer().startSpan("example.read", () => this.read(a, ctx)),
    };
  }

  // Pagination (cursor = offset into the backend's result set) + 256 KB truncation
  // (instructions.md §14 "règles communes") are non-negotiable per connector — every list/read
  // tool a real connector adds must apply both, not just this template's example.
  private async read(args: any, ctx: ToolContext): Promise<PageResult> {
    const resource = String(args?.resource ?? "");
    const pageSize = Math.min(Math.max(Number(args?.pageSize ?? 20), 1), 100);
    const all = await this.backend.read(resource, ctx);
    const page = paginate(all, args?.cursor ? String(args.cursor) : undefined, pageSize);
    const { json, truncated } = truncateJson(page, MAX_RESPONSE_BYTES);
    return { ...(JSON.parse(json) as { items: ExampleItem[]; nextCursor?: string }), truncated };
  }
}
