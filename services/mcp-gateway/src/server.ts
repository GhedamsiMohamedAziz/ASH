// MCP Gateway HTTP surface (instructions.md §13). Node stdlib http — no framework
// dep. POST /v1/tool/call runs a tool through the gateway; GET /healthz, GET /audit.
// In prod this listens on :8443 with mTLS from the sandboxes only (§17.4).
import { createServer } from "node:http";
import { McpGateway, type ToolCall } from "./gateway.ts";

// Fail closed in prod: verifying TASK tokens against a well-known dev secret would let
// anyone mint a valid token. Require the env var when OLMA_ENV=prod.
const SECRET = process.env.TASK_JWT_SECRET
  ?? (process.env.OLMA_ENV === "prod"
        ? (() => { throw new Error("TASK_JWT_SECRET must be set when OLMA_ENV=prod"); })()
        : "dev-task-jwt-secret");

export function buildGateway(): McpGateway {
  const gw = new McpGateway(SECRET, {
    iss: "olma-prompt-layer",
    aud: "olma-mcp-gateway",
    requireExp: true, // a TASK token with no expiry never expires — reject it
  });
  // Stub MCP servers for the dev surface; real servers register in P1/P6.
  gw.register("github.search", async () => "stub: 3 matching files");
  gw.register("github.create_pr", async (_a, ctx) => `stub: PR opened for ${ctx.userId}`);
  gw.register("github.merge_pr", async () => "stub: merged");
  return gw;
}

export function createGatewayServer(gw = buildGateway()) {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/healthz") return send(200, { status: "ok" });
    if (req.method === "GET" && req.url === "/audit") return send(200, { audit: gw.audit });
    if (req.method === "POST" && req.url === "/v1/tool/call") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let payload: ToolCall;
      try {
        payload = JSON.parse(raw);
      } catch {
        return send(400, { error: { code: "E_VALIDATION", message: "bad json" } });
      }
      const result = await gw.call(payload);
      const httpCode =
        result.status === "ok" ? 200 :
        result.status === "needs_approval" ? 202 :
        result.status === "denied" ? 403 : 502;
      return send(httpCode, result);
    }
    send(404, { error: { code: "E_NOT_FOUND", message: "not found" } });
  });
}

// Boot when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8443);
  createGatewayServer().listen(port, () => console.log(`mcp-gateway on :${port}`));
}
