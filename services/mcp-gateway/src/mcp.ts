// MCP Streamable-HTTP surface for the REAL gateway (instructions.md §13). This is the MCP JSON-RPC
// protocol front door that opencode speaks (sandbox/opencode.json → { type: remote, url: .../mcp }).
// The bespoke REST route (POST /v1/tool/call) does NOT speak MCP, so opencode cannot drive it — this
// module is the missing protocol layer. Every tools/call is handed straight to gw.call(), so the FULL
// chain (TASK_JWT verify → allowed_tools AuthZ → approval → taint → DLP → append-only audit) runs
// unchanged; this module only adds JSON-RPC framing + threads `Authorization: Bearer <TASK_JWT>` into
// taskJwt. Dependency-free — node stdlib plus the framing — and wired into the real server's auth path,
// never a parallel one. Proven end-to-end by tests/integration/test_gateway_e2e.py (opencode → /mcp).
import type { McpGateway } from "./gateway.ts";

const PROTOCOL_VERSION = "2025-06-18";

// The MCP tool catalog. opencode-safe names (no dot) each map to a canonical gateway tool, so the
// gateway audit records the real github.* tool the call traversed. tools/list reflects ONLY the entries
// whose gwTool is in the TASK JWT's allowed_tools (see handleMcpRpc) — the full catalog never leaks to
// an unauthorized token. Names/schemas mirror the registered GithubMcp surface (github.ts tools()).
export interface McpToolDef {
  name: string; // opencode-safe MCP tool name (no dot)
  gwTool: string; // canonical gateway tool the call routes to
  description: string;
  inputSchema: Record<string, unknown>;
}

export const MCP_TOOLS: McpToolDef[] = [
  {
    name: "github_search",
    gwTool: "github.search",
    description: "Search code in a GitHub repository through the Axone MCP Gateway.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
  },
  {
    name: "github_read",
    gwTool: "github.read",
    description: "Read a file from a GitHub repository through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, path: { type: "string" } },
      required: ["repo", "path"],
    },
  },
  {
    name: "github_list_issues",
    gwTool: "github.list_issues",
    description: "List issues in a GitHub repository through the Axone MCP Gateway.",
    inputSchema: { type: "object", properties: { repo: { type: "string" } }, required: ["repo"] },
  },
  {
    name: "github_create_pr",
    gwTool: "github.create_pr",
    description: "Open a pull request in a GitHub repository through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        head: { type: "string" },
        base: { type: "string" },
        title: { type: "string" },
      },
      required: ["repo", "head", "base", "title"],
    },
  },
  {
    name: "github_merge_pr",
    gwTool: "github.merge_pr",
    description: "Merge a pull request in a GitHub repository through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { repo: { type: "string" }, number: { type: "number" } },
      required: ["repo", "number"],
    },
  },
  // Browser connector (schemas mirror BrowserMcp.schemas() — a single { url } string input).
  {
    name: "browser_read_page",
    gwTool: "browser.read_page",
    description: "Fetch a web page and return its extracted title + readable text through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string", format: "uri", maxLength: 2048, description: "http(s) URL to browse" } },
      required: ["url"],
    },
  },
  {
    name: "browser_fetch",
    gwTool: "browser.fetch",
    description: "Fetch a web page and return its raw (capped) body through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: { url: { type: "string", format: "uri", maxLength: 2048, description: "http(s) URL to browse" } },
      required: ["url"],
    },
  },
  // Database connector (schemas mirror database.ts TOOL_SCHEMAS — read-only SELECT/WITH surface).
  {
    name: "database_query",
    gwTool: "database.query",
    description: "Run a read-only SQL query (a single SELECT or read-only WITH/CTE) through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "A single SELECT or read-only WITH statement." },
        pageSize: { type: "number", description: "Rows per page (1-500)." },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
      required: ["sql"],
    },
  },
  {
    name: "database_list_tables",
    gwTool: "database.list_tables",
    description: "List tables visible to the read-only service account through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "number", description: "Tables per page (1-500)." },
        cursor: { type: "string", description: "Opaque pagination cursor from a previous call." },
      },
    },
  },
  {
    name: "database_describe",
    gwTool: "database.describe",
    description: "Describe a table's columns (name, type, nullability) through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Table name (bare identifier, no schema-qualification)." },
      },
      required: ["table"],
    },
  },
  // Scheduler connector (schemas mirror scheduler.ts CronSpec + the jobId-keyed management tools).
  {
    name: "scheduler_create_cron",
    gwTool: "scheduler.create_cron",
    description: "Create a scheduled automation (5-field cron, min 15-min interval) through the Axone MCP Gateway. Approval-gated by policy.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Human label for the automation." },
        prompt: { type: "string", description: "The instruction run on each firing." },
        cron: { type: "string", description: "5-field cron expression (min hour dom mon dow), no seconds." },
        timezone: { type: "string", description: "IANA timezone (default UTC)." },
        delivery: {
          type: "object",
          properties: { channel: { type: "string" }, target: { type: "string" } },
          required: ["channel", "target"],
        },
        perRunBudget: {
          type: "object",
          properties: { maxCostUsd: { type: "number" }, maxSeconds: { type: "number" } },
          required: ["maxCostUsd", "maxSeconds"],
        },
      },
      required: ["name", "prompt", "cron", "delivery", "perRunBudget"],
    },
  },
  {
    name: "scheduler_list_crons",
    gwTool: "scheduler.list_crons",
    description: "List the caller's scheduled automations through the Axone MCP Gateway.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "scheduler_pause_cron",
    gwTool: "scheduler.pause_cron",
    description: "Pause a scheduled automation by job id through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "scheduler_resume_cron",
    gwTool: "scheduler.resume_cron",
    description: "Resume a paused scheduled automation by job id through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  {
    name: "scheduler_run_now",
    gwTool: "scheduler.run_now",
    description: "Trigger a scheduled automation immediately by job id through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { jobId: { type: "string" } },
      required: ["jobId"],
    },
  },
  // M365 / MS Graph connector (schemas mirror m365.ts tools()). Reads ingest untrusted mail/file
  // content; send_mail is public egress (approval-gated on a tainted turn).
  {
    name: "m365_list_mail",
    gwTool: "m365.list_mail",
    description: "List messages in an Outlook mail folder (default inbox) through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { folder: { type: "string", description: "Mail folder name (default inbox)." } },
    },
  },
  {
    name: "m365_read_mail",
    gwTool: "m365.read_mail",
    description: "Read one Outlook message's subject and body by id through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Message id." } },
      required: ["id"],
    },
  },
  {
    name: "m365_send_mail",
    gwTool: "m365.send_mail",
    description: "Send an Outlook email through the Axone MCP Gateway. Public egress — approval-gated on a tainted turn.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address." },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "m365_search_files",
    gwTool: "m365.search_files",
    description: "Search SharePoint / OneDrive files through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query." } },
      required: ["query"],
    },
  },
  {
    name: "m365_create_event",
    gwTool: "m365.create_event",
    description: "Create a calendar event through the Axone MCP Gateway.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        start: { type: "string", description: "Event start (ISO 8601)." },
      },
      required: ["title", "start"],
    },
  },
];

// Extract the raw TASK JWT from an Authorization header. Empty string when absent/malformed → the
// gateway then fails closed (E_AUTH_INVALID_TOKEN), never a bypass.
export function bearer(auth: string | string[] | undefined): string {
  const h = Array.isArray(auth) ? auth[0] : auth ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : "";
}

// Handle one MCP JSON-RPC message. Returns a response object, or null for a notification (no body).
export async function handleMcpRpc(gw: McpGateway, msg: any, taskJwt: string): Promise<any | null> {
  const { id, method, params } = msg ?? {};

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "olma-mcp-gateway", version: "0.1.0" },
      },
    };
  }
  // Notifications (e.g. notifications/initialized) carry no id and expect no response body.
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    // JWT-gated: verify via the SAME path as gw.call() and reflect ONLY the tools the token allows.
    // No/invalid token → fail-closed JSON-RPC error, never a catalog leak.
    let allowed: string[];
    try {
      allowed = gw.verifyAllowedTools(taskJwt);
    } catch {
      // Constant client-facing text regardless of failure cause (expired vs forged vs wrong-aud):
      // do not give a token-forgery oracle. Detail stays server-side (verify throws are logged).
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "E_AUTH_INVALID_TOKEN", data: { code: "E_AUTH_INVALID_TOKEN" } },
      };
    }
    const tools = MCP_TOOLS.filter((t) => allowed.includes(t.gwTool)).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    return { jsonrpc: "2.0", id, result: { tools } };
  }

  if (method === "tools/call") {
    const name = params?.name;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const def = MCP_TOOLS.find((t) => t.name === name);
    if (!def) {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: "unknown tool" }], isError: true },
      };
    }
    // THE crux: the call goes THROUGH the real gateway — JWT verify, allowed_tools, approval, taint,
    // DLP and audit all run in gw.call(). No/invalid JWT or a not-allowed tool fails closed here
    // exactly as on the REST path (E_AUTH_INVALID_TOKEN / E_PERM_TOOL_DENIED) — the code is surfaced
    // in the MCP result text so the client sees why. taskJwt is the token opencode presented.
    const r = await gw.call({ tool: def.gwTool, args, taskJwt });
    const text =
      r.status === "ok" ? String(r.result ?? "") : `[${r.status}] ${r.code ?? ""} ${r.reason ?? ""}`.trim();
    return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: r.status !== "ok" } };
  }

  return { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } };
}
