// Demo "Text Utilities" MCP server — a REAL, no-auth MCP server used to exercise mcpmarket autolearn
// end-to-end (search → register → use). Speaks the same Streamable-HTTP JSON-RPC the gateway's
// RemoteMcpClient drives (initialize → notifications/initialized → tools/list → tools/call). Stateless,
// deterministic, dependency-free. Run: node services/mcp-servers/demo-utils/server.ts  (PORT=4100).
//
// This is an EXAMPLE catalog skill for local demos. It is NOT wired into any auth path and holds no
// secrets. In prod the mcpmarket catalog points at real public/partner MCP servers instead.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";

const PORT = Number(process.env.PORT ?? 4100);

// The tool surface. Each returns a plain string; the handler wraps it as MCP content.
const TOOLS: Record<string, { def: unknown; run: (a: Record<string, any>) => string }> = {
  word_count: {
    def: {
      name: "word_count",
      description: "Count the words in a piece of text.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    run: (a) => String(String(a.text ?? "").trim().split(/\s+/).filter(Boolean).length),
  },
  reverse_text: {
    def: {
      name: "reverse_text",
      description: "Reverse a string character by character.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    run: (a) => [...String(a.text ?? "")].reverse().join(""),
  },
  to_uppercase: {
    def: {
      name: "to_uppercase",
      description: "Upper-case a string.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    run: (a) => String(a.text ?? "").toUpperCase(),
  },
  sha256: {
    def: {
      name: "sha256",
      description: "Compute the SHA-256 hex digest of a string (an LLM cannot do this itself).",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    },
    run: (a) => createHash("sha256").update(String(a.text ?? ""), "utf8").digest("hex"),
  },
};

function rpcResult(id: unknown, result: unknown) {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function rpcError(id: unknown, code: number, message: string) {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

function handleRpc(msg: any): string | null {
  const { id, method, params } = msg ?? {};
  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "demo-text-utils", version: "0.1.0" },
    });
  }
  if (typeof method === "string" && method.startsWith("notifications/")) return null; // notification
  if (method === "tools/list") {
    return rpcResult(id, { tools: Object.values(TOOLS).map((t) => t.def) });
  }
  if (method === "tools/call") {
    const name = params?.name;
    const tool = TOOLS[name as string];
    if (!tool) return rpcResult(id, { content: [{ type: "text", text: "unknown tool" }], isError: true });
    try {
      const text = tool.run((params?.arguments ?? {}) as Record<string, any>);
      return rpcResult(id, { content: [{ type: "text", text }] });
    } catch (e) {
      return rpcResult(id, { content: [{ type: "text", text: String((e as Error).message) }], isError: true });
    }
  }
  return rpcError(id, -32601, "method not found");
}

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method !== "POST") { res.writeHead(405).end(); return; }
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1 << 20) req.destroy(); });
  req.on("end", () => {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { res.writeHead(400).end(); return; }
    const out = handleRpc(msg);
    if (out === null) { res.writeHead(202).end(); return; } // notification: no body
    res.writeHead(200, { "content-type": "application/json" }).end(out);
  });
});

server.listen(PORT, "127.0.0.1", () => console.log(`demo-text-utils MCP on http://127.0.0.1:${PORT}`));
