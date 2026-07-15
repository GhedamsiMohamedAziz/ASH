// DEV/TEST-ONLY MCP Streamable-HTTP front door for the REAL MCP Gateway (instructions.md §13).
//
// WHY THIS EXISTS: the shipped gateway (services/mcp-gateway/src/server.ts) exposes a bespoke
// REST surface (POST /v1/tool/call) — NOT the MCP JSON-RPC protocol. But sandbox/opencode.json
// points opencode's MCP client at `type: remote .../mcp`, which speaks MCP over Streamable HTTP.
// The two don't share a protocol, so opencode cannot drive the gateway directly. This adapter is
// the missing MCP-protocol surface: a thin, dependency-free (node stdlib only) MCP server that
// hands every tools/call straight to the REAL gateway core via `buildGateway().call(...)`.
//
// It changes NO auth/security behavior — the full chain (TASK_JWT verify + allowed_tools + taint
// + approval + DLP + audit) runs inside gw.call() exactly as in production. The only thing added
// is MCP JSON-RPC framing + threading the `Authorization: Bearer <TASK_JWT>` header into taskJwt.
// GET /audit exposes the real gateway audit log so the E2E test can prove the call traversed it.
import { createServer } from "node:http";
import { buildGateway } from "../../services/mcp-gateway/src/server.ts";

// StubBackend when no GITHUB_TOKEN is set → fully keyless/offline (§ADR-012).
const gw = buildGateway();

// MCP tools offered to opencode. Names are opencode-safe (no dot) and each maps to the canonical
// gateway tool name, so the gateway audit records the real `github.*` tool the call went through.
const TOOLS: Array<{
  name: string;
  gwTool: string;
  description: string;
  inputSchema: Record<string, unknown>;
}> = [
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
];

function bearer(auth: string | string[] | undefined): string {
  const h = Array.isArray(auth) ? auth[0] : auth ?? "";
  return h.startsWith("Bearer ") ? h.slice("Bearer ".length) : "";
}

// Handle one JSON-RPC message. Returns a response object, or null for a notification.
async function handleRpc(msg: any, taskJwt: string): Promise<any | null> {
  const { id, method, params } = msg ?? {};

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "olma-mcp-gateway-adapter", version: "0.1.0" },
      },
    };
  }
  // Notifications carry no id and expect no response body.
  if (typeof method === "string" && method.startsWith("notifications/")) return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };
  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      },
    };
  }
  if (method === "tools/call") {
    const name = params?.name;
    const args = (params?.arguments ?? {}) as Record<string, unknown>;
    const def = TOOLS.find((t) => t.name === name);
    if (!def) {
      return {
        jsonrpc: "2.0",
        id,
        result: { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true },
      };
    }
    // THE crux: the call goes THROUGH the real gateway — JWT verify, allowed_tools, taint,
    // approval, DLP and audit all run here. taskJwt is the token opencode presented via the
    // Authorization header configured in opencode.json.
    const r = await gw.call({ tool: def.gwTool, args, taskJwt });
    const text =
      r.status === "ok"
        ? String(r.result ?? "")
        : `[${r.status}] ${r.code ?? ""} ${r.reason ?? ""}`.trim();
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text }], isError: r.status !== "ok" },
    };
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

const server = createServer(async (req, res) => {
  const send = (code: number, obj: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(code, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(obj));
  };

  if (req.method === "GET" && req.url === "/healthz") return send(200, { status: "ok" });
  // The real gateway audit log — the E2E test reads this to prove the tool call traversed the gateway.
  if (req.method === "GET" && req.url === "/audit") return send(200, { audit: gw.audit });

  if (req.url === "/mcp") {
    // Streamable HTTP server->client SSE channel is optional; we don't push notifications, so a
    // GET is declined. The MCP StreamableHTTP client tolerates 405 here and proceeds over POST.
    if (req.method === "GET") {
      return send(405, { jsonrpc: "2.0", error: { code: -32000, message: "no SSE stream" } });
    }
    if (req.method === "POST") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: any;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } });
      }
      const taskJwt = bearer(req.headers["authorization"]);
      const batched = Array.isArray(body);
      const msgs = batched ? body : [body];
      const responses: any[] = [];
      for (const m of msgs) {
        const r = await handleRpc(m, taskJwt);
        if (r) responses.push(r);
      }
      if (responses.length === 0) {
        res.writeHead(202);
        return res.end();
      }
      return send(200, batched ? responses : responses[0]);
    }
    res.writeHead(405);
    return res.end();
  }

  send(404, { error: "not found" });
});

const port = Number(process.env.PORT ?? 0);
server.listen(port, "127.0.0.1", () => {
  const addr = server.address();
  const p = typeof addr === "object" && addr ? addr.port : port;
  // Emitted so a launcher can discover the bound port when PORT=0.
  console.log(`adapter-listening ${p}`);
});
