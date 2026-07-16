// mcpmarket auto-register bridge — core (docs/mcpmarket-bridge.md, ADR-012 seam, invariant #8).
//
// "Autolearn": discover a marketplace MCP server → register its tools (GATED) → a human promotes
// once → first-class tool. This module is the discovery + remote-forwarding half. It NEVER runs
// marketplace code locally: it speaks MCP JSON-RPC (Streamable-HTTP) to a REMOTE server and forwards
// tools/call over HTTP (guardrail #4). Every forwarded call still traverses gw.call() unchanged — so
// TASK-JWT auth, allowed_tools AuthZ, approval, taint, DLP and append-only audit all apply (guardrail
// #3). Auto-registered tools land with the MOST-RESTRICTIVE taint (guardrail #1, SAFE_META below) and
// are expected to be require_approval by policy until a human promotes them (guardrail #2). Provenance
// (source = "mcpmarket:<server-id>") is returned so a compromised server is traceable/revocable (#5).
//
// STRICT SCOPE: this is a NEW, self-contained module. It does not modify server.ts / mcp.ts / gateway.ts
// / vault.ts. The exact wiring the parent must apply is documented at the bottom of this file.
import { readFileSync } from "node:fs";
import { ResilientHttpClient, type RetryOpts, type CircuitBreakerOpts } from "../../mcp-servers/_template/src/http-client.ts";
import { validateUrl } from "../../mcp-servers/browser/src/ssrf.ts";
import type { ToolHandler } from "./gateway.ts";
import type { ToolMeta } from "./taint.ts";
import type { McpToolDef } from "./mcp.ts";

// A registered server may advertise at most this many tools — an unbounded tools/list from a
// compromised marketplace server would otherwise flood the gateway registry + every tenant's
// tools/list (registration DoS). Reject rather than partially register.
const MAX_REMOTE_TOOLS = 128;

// ────────────────────────────────────────────────────────────── the invariant-#8 guardrail ──
// Auto-registered marketplace tools ALWAYS register with the most-restrictive taint: they taint the
// turn on any non-empty result (ingestsUntrusted) AND are treated as public egress (so a tainted turn
// forces approval / fails a scheduled run, §17.6). A marketplace server MAY *declare* looser metadata
// (server.declaredMeta) but a declaration is a CLAIM, not proof — it is NOT used for the live default.
// Only a human `platctl mcpmarket promote` step (Phase 3) relaxes a specific tool from this safe
// default to a human-reviewed taint. Detection is not a boundary (§17.6.1) — this constant IS.
export const SAFE_META: ToolMeta = { ingestsUntrusted: true, egressClass: "public" };

const PROTOCOL_VERSION = "2025-06-18";
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB response cap (guardrail: unbounded remote body = DoS)

// ───────────────────────────────────────────────────────────────────────────── error types ──
export class RemoteMcpError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteMcpError";
  }
}

// A remote HTTP body larger than the 256 KB cap is REJECTED (fail-closed), never truncated into
// unparseable JSON — an oversized response from an untrusted marketplace server is an availability
// attack on the gateway (the single egress point for every sandbox), so we refuse it.
export class RemoteResponseTooLargeError extends RemoteMcpError {
  constructor(maxBytes: number) {
    super(`remote MCP response exceeded ${maxBytes} byte cap`);
    this.name = "RemoteResponseTooLargeError";
  }
}

// The remote server answered with a JSON-RPC error object (well-formed protocol-level failure).
export class RemoteRpcError extends RemoteMcpError {
  code: number;
  constructor(code: number, message: string) {
    super(`remote MCP error ${code}: ${message}`);
    this.name = "RemoteRpcError";
    this.code = code;
  }
}

export interface RemoteToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface RemoteMcpClientOpts {
  // Bearer token the remote server needs (per-server default; toolsCall() can override per-call with
  // the requester's Vault-resolved credential, so a per-user token is threaded in at call time).
  authToken?: string;
  timeoutMs?: number;        // per-attempt timeout (default 10s, via AbortController in the retry layer)
  retries?: number;          // retries on 429/5xx / network error (default 3)
  baseDelayMs?: number;
  maxResponseBytes?: number; // 256 KB default response cap
  breaker?: CircuitBreakerOpts;
  fetchImpl?: typeof fetch;  // overridable in tests
  sleepImpl?: (ms: number) => Promise<void>; // overridable in tests to skip real backoff waits
}

// ──────────────────────────────────────────────────────────────────────── RemoteMcpClient ──
// A dependency-free (node stdlib + the reused ResilientHttpClient) MCP Streamable-HTTP CLIENT. It
// SPEAKS the protocol that mcp.ts/server.ts SERVE — the mirror image. Handles the initialize
// handshake, tools/list and tools/call, with retry/breaker/timeout (reused from _template) and a
// hard 256 KB response cap. Session id + protocol version negotiated on initialize are threaded into
// every subsequent request.
export class RemoteMcpClient {
  private readonly http: ResilientHttpClient;
  private readonly retryOpts: RetryOpts;
  private readonly maxResponseBytes: number;
  private readonly defaultAuthToken?: string;
  private readonly mcpUrl: string;
  private nextId = 1;
  private sessionId: string | null = null;
  private negotiatedProtocol = PROTOCOL_VERSION;

  constructor(mcpUrl: string, opts: RemoteMcpClientOpts = {}) {
    this.mcpUrl = mcpUrl;
    this.retryOpts = {
      retries: opts.retries,
      baseDelayMs: opts.baseDelayMs,
      timeoutMs: opts.timeoutMs,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
    };
    this.http = new ResilientHttpClient({ ...this.retryOpts, breaker: opts.breaker });
    this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    this.defaultAuthToken = opts.authToken;
  }

  get breakerState(): string {
    return this.http.breakerState;
  }

  // MCP initialize handshake. Captures the server's Mcp-Session-Id (if any) and negotiated protocol,
  // then fires the notifications/initialized notification (no id, no response) as the spec requires.
  async initialize(): Promise<{ protocolVersion: string; serverInfo?: unknown }> {
    const { result, sessionId } = await this.rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "olma-mcpmarket-bridge", version: "0.1.0" },
    });
    if (sessionId) this.sessionId = sessionId;
    const r = (result ?? {}) as { protocolVersion?: string; serverInfo?: unknown };
    if (r.protocolVersion) this.negotiatedProtocol = r.protocolVersion;
    await this.notify("notifications/initialized", {});
    return { protocolVersion: this.negotiatedProtocol, serverInfo: r.serverInfo };
  }

  // tools/list → the remote server's advertised tools.
  async toolsList(): Promise<RemoteToolDef[]> {
    const { result } = await this.rpc("tools/list", {});
    const tools = (result as { tools?: RemoteToolDef[] })?.tools ?? [];
    return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  }

  // tools/call → the (stringified, capped) result. authToken overrides the per-server default so the
  // gateway can inject THIS requester's Vault credential per call (never an ambient/shared token).
  async toolsCall(name: string, args: Record<string, unknown>, authToken?: string): Promise<string> {
    const { result } = await this.rpc("tools/call", { name, arguments: args ?? {} }, authToken);
    return capString(stringifyResult(result), this.maxResponseBytes);
  }

  // ── internals ──
  private async rpc(
    method: string,
    params: Record<string, unknown>,
    authToken?: string,
  ): Promise<{ result: unknown; sessionId: string | null }> {
    const id = this.nextId++;
    const res = await this.http.request(this.mcpUrl, {
      method: "POST",
      headers: this.headers(authToken),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });
    const sessionId = res.headers.get("mcp-session-id");
    const contentType = res.headers.get("content-type") ?? "";
    const body = await readCapped(res, this.maxResponseBytes);
    const msg = parseRpcBody(body, contentType);
    if (msg?.error) throw new RemoteRpcError(msg.error.code ?? -1, msg.error.message ?? "unknown");
    return { result: msg?.result, sessionId };
  }

  // A JSON-RPC notification: no id, no response expected. Best-effort — a notification failure must
  // not abort the handshake (some servers 202/204 or ignore it).
  private async notify(method: string, params: Record<string, unknown>): Promise<void> {
    try {
      await this.http.request(this.mcpUrl, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      });
    } catch {
      /* notifications are fire-and-forget */
    }
  }

  private headers(authToken?: string): Record<string, string> {
    const h: Record<string, string> = {
      "content-type": "application/json",
      // Streamable-HTTP servers may answer with either JSON or an SSE stream; accept both.
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": this.negotiatedProtocol,
    };
    const token = authToken ?? this.defaultAuthToken;
    if (token) h["authorization"] = `Bearer ${token}`;
    if (this.sessionId) h["mcp-session-id"] = this.sessionId;
    return h;
  }
}

// Read a Response body, aborting (fail-closed) once it exceeds maxBytes so an untrusted marketplace
// server cannot exhaust gateway memory with an unbounded body. Streams when possible; falls back to
// arrayBuffer() for a bodyless/already-buffered Response (e.g. a test mock).
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const reader = res.body?.getReader?.();
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > maxBytes) throw new RemoteResponseTooLargeError(maxBytes);
    return buf.toString("utf8");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new RemoteResponseTooLargeError(maxBytes);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

interface RpcEnvelope {
  result?: unknown;
  error?: { code?: number; message?: string };
}

// Parse a JSON-RPC response body that may arrive as raw JSON or as an SSE (text/event-stream) frame.
function parseRpcBody(body: string, contentType: string): RpcEnvelope | null {
  const trimmed = body.trim();
  if (!trimmed) return null;
  if (contentType.includes("text/event-stream") || trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    // Concatenate the `data:` lines of the (last) SSE event and JSON.parse them.
    const data = trimmed
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice("data:".length).trim())
      .join("");
    if (!data) return null;
    return JSON.parse(data) as RpcEnvelope;
  }
  return JSON.parse(trimmed) as RpcEnvelope;
}

// The MCP tools/call result shape is { content: [{type:"text", text}], ...}. Prefer the joined text
// parts; otherwise JSON-stringify the whole result so the gateway's DLP/taint accounting runs on it.
function stringifyResult(result: unknown): string {
  if (result == null) return "";
  const r = result as { content?: Array<{ type?: string; text?: string }> };
  if (Array.isArray(r.content)) {
    const text = r.content
      .filter((p) => p && p.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
    if (text) return text;
  }
  return typeof result === "string" ? result : JSON.stringify(result);
}

function capString(s: string, maxBytes: number): string {
  if (Buffer.byteLength(s, "utf8") <= maxBytes) return s;
  // Byte-safe slice (never split a multibyte char): take a prefix and re-decode.
  return Buffer.from(s, "utf8").subarray(0, maxBytes).toString("utf8");
}

// ─────────────────────────────────────────────────────────── registerRemoteServer ──
export interface MarketplaceServer {
  id: string;
  name: string;
  mcpUrl: string;
  // A CLAIM only — recorded for provenance/audit but NEVER used for the live taint default (SAFE_META
  // wins until a human promote step, guardrail #1/#8).
  declaredMeta?: ToolMeta;
}

export interface RegisteredRemoteTool {
  gwTool: string;          // dotted gateway tool name (what gw.register/gw.call use) — mcpmarket_<id>.<tool>
  alias: string;           // opencode-safe underscore alias — mcpmarket_<id>_<tool>
  remoteName: string;      // the tool's name on the remote server
  meta: ToolMeta;          // ALWAYS SAFE_META
  description?: string;
  inputSchema?: Record<string, unknown>;
  source: string;          // provenance: "mcpmarket:<server-id>" (guardrail #5)
}

export interface RegisterRemoteResult {
  serverId: string;
  source: string;
  tools: RegisteredRemoteTool[];
}

// Minimal gateway surface this function needs — the real McpGateway satisfies it, and tests pass a
// mock. Kept structural so this module does not depend on the concrete class.
export interface RegistrarGateway {
  register(tool: string, handler: ToolHandler, meta: ToolMeta): void;
}

// Namespacing to avoid collisions with the built-in connectors (github.*, slack.* …): every remote
// tool is prefixed with the server id. Dotted = the canonical gateway tool name; underscore = the
// opencode-safe MCP alias (mcp.ts maps the alias → the dotted gwTool).
export function remoteToolNames(serverId: string, toolName: string): { gwTool: string; alias: string } {
  const safeServer = sanitize(serverId);
  const safeTool = sanitize(toolName);
  return {
    gwTool: `mcpmarket_${safeServer}.${safeTool}`,
    alias: `mcpmarket_${safeServer}_${safeTool}`,
  };
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

// Connect to a remote marketplace MCP server, list its tools, and register EACH on the gateway with a
// forwarding handler and the SAFE_META guardrail. Returns the registered tool descriptors so the caller
// can seed tool_policies(require_approval) (Phase 2/3) and surface them in tools/list. declaredMeta is
// recorded for provenance but deliberately ignored for the live meta (guardrail #1/#8).
export async function registerRemoteServer(
  gw: RegistrarGateway,
  server: MarketplaceServer,
  opts: RemoteMcpClientOpts = {},
): Promise<RegisterRemoteResult> {
  // Anti-SSRF (review finding): the mcp_url is remote-supplied (registry/platctl), so validate it
  // through the hardened validator before opening any socket — blocks metadata (169.254.169.254),
  // loopback/RFC1918, integer/hex IP encodings, non-http(s) schemes. The private/metadata checks are
  // UNCONDITIONAL (independent of the allow-list), so an attacker-set mcp_url can't reach internal
  // services + exfil the Bearer credential. (Prod: pass a `resolve` for DNS-rebind + a real
  // marketplace host allow-list instead of allow-self.)
  const orgId = server.orgId ?? "platform";
  if (!opts.skipSsrf) {  // skipSsrf: test/dev-only opt-out for a loopback fixture; NEVER set in prod.
    await validateUrl(server.mcpUrl, orgId, {
      allowList: () => { try { return [new URL(server.mcpUrl).hostname]; } catch { return []; } },
      resolve: opts.resolve,
    });
  }
  const client = new RemoteMcpClient(server.mcpUrl, opts);
  await client.initialize();
  const remoteTools = await client.toolsList();
  if (remoteTools.length > MAX_REMOTE_TOOLS) {
    throw new RemoteMcpError(
      `server ${server.id} advertised ${remoteTools.length} tools (max ${MAX_REMOTE_TOOLS})`);
  }
  const source = `mcpmarket:${server.id}`;
  const registered: RegisteredRemoteTool[] = [];

  for (const tool of remoteTools) {
    const { gwTool, alias } = remoteToolNames(server.id, tool.name);
    // Forwarding handler: forward tools/call to the REMOTE server (no local exec, guardrail #4) with
    // THIS requester's Vault credential (ctx.credential) as the Bearer token — never the "vault:stub"
    // sentinel. gw.call() has already run auth/allowed_tools/approval/taint BEFORE this executes, and
    // DLP-scrubs + audits the (capped) string this returns AFTER.
    const forwardingHandler: ToolHandler = async (args, ctx) => {
      const token = ctx.credential && ctx.credential !== "vault:stub" ? ctx.credential : undefined;
      return client.toolsCall(tool.name, args, token);
    };
    // SAFE_META ALWAYS — the server's declaredMeta is a claim, not the live default (guardrail #8).
    gw.register(gwTool, forwardingHandler, SAFE_META);
    registered.push({
      gwTool,
      alias,
      remoteName: tool.name,
      meta: SAFE_META,
      description: tool.description,
      inputSchema: tool.inputSchema,
      source,
    });
  }
  return { serverId: server.id, source, tools: registered };
}

// ──────────────────────────────────────────────────── mcpmarket catalog + source seam (ADR-012) ──
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  mcpUrl: string;
  category: string;
  needsAuth: boolean;
}

// ADR-012 config-driven seam: the DEFAULT source is the committed catalog JSON (no verified offline
// access to the real mcpmarket registry API). Swap in the live registry here — a config change, not a
// rearchitecture: e.g. `if (process.env.MCPMARKET_API_URL) return await fetchLiveCatalog(...)`.
export function mcpmarketSource(): CatalogEntry[] {
  // TODO(mcpmarket): when MCPMARKET_API_URL is configured, fetch the live registry here instead.
  const path = new URL("../mcpmarket-catalog.json", import.meta.url);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as CatalogEntry[];
}

// The current catalog (memoized-free; cheap enough to read per call, and picks up edits in dev).
export function mcpmarketCatalog(): CatalogEntry[] {
  return mcpmarketSource();
}

// Rank catalog entries against a free-text query. Simple token-overlap scoring over id/name/category
// (weighted) + description; entries with zero matches are dropped. Deterministic, dependency-free.
export function searchCatalog(query: string, catalog: CatalogEntry[] = mcpmarketCatalog()): CatalogEntry[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [...catalog];
  const scored = catalog
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.map((s) => s.entry);
}

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function scoreEntry(entry: CatalogEntry, terms: string[]): number {
  const id = entry.id.toLowerCase();
  const name = entry.name.toLowerCase();
  const category = entry.category.toLowerCase();
  const description = entry.description.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (id === t || name === t) score += 5;           // exact id/name hit
    if (id.includes(t)) score += 3;
    if (name.includes(t)) score += 3;
    if (category.includes(t)) score += 2;
    if (description.includes(t)) score += 1;
  }
  return score;
}

// ───────────────────────────────────────────── agent-facing meta-tools (mcpmarket.search / …) ──
// MCP_TOOLS-shaped entries so the parent can splice them into mcp.ts's MCP_TOOLS. NOT registered here
// (STRICT SCOPE: this module never edits mcp.ts) — exported for the parent to wire (see WIRING below).
export const MCPMARKET_MCP_TOOLS: McpToolDef[] = [
  {
    name: "mcpmarket_search",
    gwTool: "mcpmarket.search",
    description: "Search the mcpmarket catalog for a marketplace MCP server that provides a missing capability.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "Capability to search for, e.g. 'list linear issues'." } },
      required: ["query"],
    },
  },
  {
    name: "mcpmarket_request_register",
    gwTool: "mcpmarket.request_register",
    description:
      "Request that a marketplace MCP server (by catalog id) be registered. Requires admin approval; " +
      "the agent can propose but cannot self-register (guardrail #2).",
    inputSchema: {
      type: "object",
      properties: { serverId: { type: "string", description: "Catalog id from mcpmarket.search." } },
      required: ["serverId"],
    },
  },
];

// mcpmarket.search handler: read-only catalog lookup over OUR OWN committed config → trusted, so it
// neither ingests untrusted content nor egresses. Returns ranked candidates as a JSON string.
export const mcpmarketSearchHandler: ToolHandler = async (args) => {
  const query = String((args as { query?: unknown }).query ?? "");
  const matches = searchCatalog(query).map((e) => ({
    id: e.id,
    name: e.name,
    description: e.description,
    category: e.category,
    needsAuth: e.needsAuth,
  }));
  return JSON.stringify({ query, matches });
};

// mcpmarket.request_register handler: does NOT register (that is the admin/platctl path, Phase 3). It
// records the request + raises the approval need; the agent can propose but cannot self-register
// (guardrail #2). Provenance (source) is included so the pending request is traceable.
export const mcpmarketRequestRegisterHandler: ToolHandler = async (args) => {
  const serverId = String((args as { serverId?: unknown }).serverId ?? "");
  const entry = mcpmarketCatalog().find((e) => e.id === serverId);
  if (!entry) {
    return JSON.stringify({ status: "unknown_server", serverId });
  }
  return JSON.stringify({
    status: "approval_required",
    approver: "admin",
    source: `mcpmarket:${entry.id}`,
    server: { id: entry.id, name: entry.name, mcpUrl: entry.mcpUrl, needsAuth: entry.needsAuth },
    note: "Registration lands tools as require_approval with most-restrictive taint (SAFE_META) until a human promotes them.",
  });
};

// Egress metadata for the two meta-tools (§17.6.2). Both are control-plane, read-only over trusted
// config → never taint the turn, never public egress. request_register is ALSO expected to be
// approval-gated by POLICY (approval_tools in the TASK JWT) — that is orthogonal to egress class and
// is enforced by the gateway's approval check, not here.
export const MCPMARKET_META: Record<string, ToolMeta> = {
  "mcpmarket.search": { ingestsUntrusted: false, egressClass: "none" },
  "mcpmarket.request_register": { ingestsUntrusted: false, egressClass: "none" },
};

// Bundle so the parent can register the meta-tool handlers on the gateway in one loop (see WIRING).
export const MCPMARKET_META_HANDLERS: Record<string, { handler: ToolHandler; meta: ToolMeta }> = {
  "mcpmarket.search": { handler: mcpmarketSearchHandler, meta: MCPMARKET_META["mcpmarket.search"] },
  "mcpmarket.request_register": {
    handler: mcpmarketRequestRegisterHandler,
    meta: MCPMARKET_META["mcpmarket.request_register"],
  },
};

// ══════════════════════════════════════════════════════════════════════════════════════════════
// WIRING (for the parent to apply — this module deliberately does NOT edit server.ts / mcp.ts):
//
// ── services/mcp-gateway/src/mcp.ts ──
//   1. import at top:
//        import { MCPMARKET_MCP_TOOLS } from "./remote-mcp.ts";
//   2. append the meta-tools to the MCP catalog so opencode can see them:
//        export const MCP_TOOLS: McpToolDef[] = [ ...existing..., ...MCPMARKET_MCP_TOOLS ];
//      (or spread MCPMARKET_MCP_TOOLS into the array literal). No handler logic changes — tools/call
//      already routes def.gwTool through gw.call(), which finds the handler the parent registers below.
//
// ── services/mcp-gateway/src/server.ts, inside buildGateway(), after the existing connectors ──
//   1. import at top:
//        import { MCPMARKET_META_HANDLERS, registerRemoteServer, mcpmarketCatalog } from "./remote-mcp.ts";
//   2. register the agent-facing meta-tools (always available, keyless):
//        for (const [name, { handler, meta }] of Object.entries(MCPMARKET_META_HANDLERS)) {
//          gw.register(name, handler, meta);
//        }
//   3. on boot, auto-register the ACTIVE marketplace servers (status='active' from the mcp_servers
//      table once Phase 3 lands; until then, seed from the catalog behind a config flag). Because
//      registerRemoteServer is async and buildGateway is sync, do it as a best-effort post-boot step
//      (mirrors resolver.load() at the bottom of server.ts) rather than blocking buildGateway:
//        // near the boot block:
//        if (process.env.MCPMARKET_AUTOREGISTER === "1") {
//          for (const s of mcpmarketCatalog()) {
//            registerRemoteServer(gw, { id: s.id, name: s.name, mcpUrl: s.mcpUrl }).catch((e) =>
//              console.error(`[mcpmarket] register ${s.id} failed`, e));
//          }
//        }
//      NOTE: registerRemoteServer registers with SAFE_META (ingestsUntrusted:true, egressClass:"public").
//      The tools still need their dotted gwTool names added to a token's allowed_tools AND seeded as
//      require_approval in tool_policies (Phase 2/3) before the agent can run them — registration alone
//      makes them visible/proposable, not freely runnable (guardrails #1/#2/#3).
//   4. to expose each registered remote tool over MCP (opencode), the parent should also splice the
//      returned RegisteredRemoteTool[] into MCP_TOOLS at boot ({ name: alias, gwTool, description,
//      inputSchema }); that is a dynamic-catalog concern left to the parent's Phase 2 tools/list work.
// ══════════════════════════════════════════════════════════════════════════════════════════════
