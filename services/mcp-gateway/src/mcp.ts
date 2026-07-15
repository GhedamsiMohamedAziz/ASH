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
