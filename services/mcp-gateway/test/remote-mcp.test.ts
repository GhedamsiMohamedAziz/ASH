// mcpmarket auto-register bridge tests (docs/mcpmarket-bridge.md, invariant #8). A tiny in-process
// fake remote MCP server (http.createServer) answers initialize/tools/list/tools/call so we can prove
// the RemoteMcpClient handshake + list + call + 256 KB cap + timeout + breaker, and that
// registerRemoteServer registers each remote tool with the SAFE_META guardrail (NOT the server's
// declared looser meta) and forwards calls. Run: node --test test/remote-mcp.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  RemoteMcpClient,
  RemoteResponseTooLargeError,
  registerRemoteServer,
  searchCatalog,
  mcpmarketCatalog,
  mcpmarketSearchHandler,
  mcpmarketRequestRegisterHandler,
  remoteToolNames,
  SAFE_META,
  type CatalogEntry,
  type RegistrarGateway,
} from "../src/remote-mcp.ts";
import type { ToolHandler } from "../src/gateway.ts";
import type { ToolMeta } from "../src/taint.ts";

// ─────────────────────────────────────────────────────────────────── fake remote MCP server ──
interface FakeServerOpts {
  status?: number;                 // force an HTTP status (e.g. 500 to trip the breaker)
  delayMs?: number;                // delay before responding (to force a client timeout)
  callResultText?: string;         // text returned by tools/call
  hugeBytes?: number;              // pad tools/call result to exceed the cap
  tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

function fakeMcpServer(opts: FakeServerOpts = {}): { server: Server; url: () => string; calls: any[] } {
  const calls: any[] = [];
  const tools = opts.tools ?? [
    { name: "echo", description: "echo back", inputSchema: { type: "object", properties: { msg: { type: "string" } } } },
    { name: "ping", description: "ping", inputSchema: { type: "object" } },
  ];
  const server = createServer(async (req, res) => {
    if (opts.status && opts.status >= 400) {
      res.writeHead(opts.status);
      return res.end("upstream error");
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const msg = raw ? JSON.parse(raw) : {};
    calls.push({ method: msg.method, params: msg.params, auth: req.headers["authorization"] ?? null });

    const reply = (body: unknown) => {
      const send = () => {
        res.writeHead(200, { "content-type": "application/json", "mcp-session-id": "sess_fake" });
        res.end(JSON.stringify(body));
      };
      if (opts.delayMs) setTimeout(send, opts.delayMs);
      else send();
    };

    // Notifications carry no id → 202, no body.
    if (typeof msg.method === "string" && msg.method.startsWith("notifications/")) {
      res.writeHead(202);
      return res.end();
    }
    if (msg.method === "initialize") {
      return reply({
        jsonrpc: "2.0", id: msg.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } },
      });
    }
    if (msg.method === "tools/list") {
      return reply({ jsonrpc: "2.0", id: msg.id, result: { tools } });
    }
    if (msg.method === "tools/call") {
      let text = opts.callResultText ?? `called ${msg.params?.name} with ${JSON.stringify(msg.params?.arguments ?? {})}`;
      if (opts.hugeBytes) text = "x".repeat(opts.hugeBytes);
      return reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text }] } });
    }
    return reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
  });
  return {
    server,
    url: () => {
      const { port } = server.address() as AddressInfo;
      return `http://127.0.0.1:${port}/mcp`;
    },
    calls,
  };
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
}
function close(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

// skipSsrf: the fixtures bind a real loopback server, which the SSRF guard correctly rejects;
// opt out so the happy-path tests reach it. A dedicated test below exercises the guard itself.
const NO_WAIT = { sleepImpl: async () => {}, skipSsrf: true };

// A mock gateway capturing every register() call so we can assert meta + invoke the forwarding handler.
function mockGateway(): RegistrarGateway & { registered: Map<string, { handler: ToolHandler; meta: ToolMeta }> } {
  const registered = new Map<string, { handler: ToolHandler; meta: ToolMeta }>();
  return {
    registered,
    register(tool, handler, meta) {
      registered.set(tool, { handler, meta });
    },
  };
}

// ──────────────────────────────────────────────────────────────────── RemoteMcpClient tests ──
test("RemoteMcpClient does the initialize handshake, lists and calls tools", async () => {
  const fake = fakeMcpServer();
  await listen(fake.server);
  try {
    const client = new RemoteMcpClient(fake.url(), NO_WAIT);
    const init = await client.initialize();
    assert.equal(init.protocolVersion, "2025-06-18");

    const tools = await client.toolsList();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["echo", "ping"]);

    const result = await client.toolsCall("echo", { msg: "hi" });
    assert.match(result, /called echo/);
    assert.match(result, /"msg":"hi"/);

    // the notifications/initialized notification was sent during initialize
    assert.ok(fake.calls.some((c) => c.method === "notifications/initialized"));
  } finally {
    await close(fake.server);
  }
});

test("RemoteMcpClient forwards a Bearer auth token to the remote server", async () => {
  const fake = fakeMcpServer();
  await listen(fake.server);
  try {
    const client = new RemoteMcpClient(fake.url(), NO_WAIT);
    await client.initialize();
    await client.toolsCall("echo", { msg: "x" }, "tok_secret_123");
    const callRow = fake.calls.find((c) => c.method === "tools/call");
    assert.equal(callRow.auth, "Bearer tok_secret_123");
  } finally {
    await close(fake.server);
  }
});

test("RemoteMcpClient rejects a response larger than the 256 KB cap (fail-closed)", async () => {
  const fake = fakeMcpServer({ hugeBytes: 300 * 1024 });
  await listen(fake.server);
  try {
    const client = new RemoteMcpClient(fake.url(), { ...NO_WAIT, retries: 0 });
    await client.initialize();
    await assert.rejects(() => client.toolsCall("echo", {}), RemoteResponseTooLargeError);
  } finally {
    await close(fake.server);
  }
});

test("RemoteMcpClient honours a custom (small) response cap", async () => {
  const fake = fakeMcpServer({ callResultText: "y".repeat(5000) });
  await listen(fake.server);
  try {
    const client = new RemoteMcpClient(fake.url(), { ...NO_WAIT, retries: 0, maxResponseBytes: 1024 });
    await client.initialize();
    await assert.rejects(() => client.toolsCall("echo", {}), RemoteResponseTooLargeError);
  } finally {
    await close(fake.server);
  }
});

test("RemoteMcpClient times out a slow remote server", async () => {
  const fake = fakeMcpServer({ delayMs: 200 });
  await listen(fake.server);
  try {
    const client = new RemoteMcpClient(fake.url(), { ...NO_WAIT, retries: 0, timeoutMs: 25 });
    await assert.rejects(() => client.initialize());
  } finally {
    await close(fake.server);
  }
});

test("RemoteMcpClient opens the circuit breaker after repeated 5xx failures", async () => {
  const fake = fakeMcpServer({ status: 500 });
  await listen(fake.server);
  try {
    const client = new RemoteMcpClient(fake.url(), {
      ...NO_WAIT,
      retries: 0,
      breaker: { failureThreshold: 2 },
    });
    await assert.rejects(() => client.initialize()); // failure 1
    await assert.rejects(() => client.initialize()); // failure 2 → breaker opens
    assert.equal(client.breakerState, "open");
    // next call is refused by the breaker, not by another upstream round-trip
    await assert.rejects(() => client.initialize(), /circuit breaker is open/);
  } finally {
    await close(fake.server);
  }
});

// ─────────────────────────────────────────────────────────────── registerRemoteServer tests ──
test("registerRemoteServer registers each tool with SAFE_META, IGNORING the server's declared looser meta", async () => {
  const fake = fakeMcpServer();
  await listen(fake.server);
  try {
    const gw = mockGateway();
    // The marketplace server CLAIMS the loosest possible meta — it must be ignored for the live default.
    const declaredMeta: ToolMeta = { ingestsUntrusted: false, egressClass: "none" };
    const result = await registerRemoteServer(
      gw,
      { id: "linear", name: "Linear MCP", mcpUrl: fake.url(), declaredMeta },
      NO_WAIT,
    );

    // Namespaced dotted gwTool names were registered (server-id prefixed, no collision with github.*).
    const { gwTool: echoGw, alias: echoAlias } = remoteToolNames("linear", "echo");
    assert.equal(echoGw, "mcpmarket_linear.echo");
    assert.equal(echoAlias, "mcpmarket_linear_echo");
    assert.ok(gw.registered.has(echoGw));
    assert.ok(gw.registered.has("mcpmarket_linear.ping"));

    // THE guardrail: registered meta is SAFE_META, NOT the declared { ingestsUntrusted:false, none }.
    for (const [, { meta }] of gw.registered) {
      assert.equal(meta.ingestsUntrusted, true, "auto-registered tool must taint the turn");
      assert.equal(meta.egressClass, "public", "auto-registered tool must default to public egress");
    }
    assert.notEqual(SAFE_META.egressClass, declaredMeta.egressClass);

    // Provenance recorded for every tool (guardrail #5).
    assert.ok(result.tools.every((t) => t.source === "mcpmarket:linear"));
    assert.equal(result.tools.length, 2);
  } finally {
    await close(fake.server);
  }
});

test("registerRemoteServer's forwarding handler calls through to the remote server", async () => {
  const fake = fakeMcpServer({ callResultText: "REMOTE_OK" });
  await listen(fake.server);
  try {
    const gw = mockGateway();
    await registerRemoteServer(gw, { id: "linear", name: "Linear", mcpUrl: fake.url() }, NO_WAIT);
    const entry = gw.registered.get("mcpmarket_linear.echo")!;
    // Simulate gw.call invoking the handler with a real Vault credential in ctx.
    const out = await entry.handler({ msg: "hi" }, { userId: "usr_1", orgId: "org_1", credential: "tok_abc" });
    assert.equal(out, "REMOTE_OK");
    const callRow = fake.calls.find((c) => c.method === "tools/call");
    assert.equal(callRow.auth, "Bearer tok_abc"); // per-user credential forwarded
  } finally {
    await close(fake.server);
  }
});

test("forwarding handler does NOT forward the vault:stub sentinel as a bearer token", async () => {
  const fake = fakeMcpServer();
  await listen(fake.server);
  try {
    const gw = mockGateway();
    await registerRemoteServer(gw, { id: "linear", name: "Linear", mcpUrl: fake.url() }, NO_WAIT);
    const entry = gw.registered.get("mcpmarket_linear.echo")!;
    await entry.handler({ msg: "x" }, { userId: "usr_1", orgId: "org_1", credential: "vault:stub" });
    const callRow = fake.calls.find((c) => c.method === "tools/call");
    assert.equal(callRow.auth, null); // stub sentinel is never sent to the remote server
  } finally {
    await close(fake.server);
  }
});

test("registerRemoteServer rejects an SSRF mcp_url (metadata IP) BEFORE opening a socket", async () => {
  // No skipSsrf → the real guard runs. A registry/attacker-supplied mcp_url pointing at the cloud
  // metadata endpoint (or any private host) must throw before any connection or credential use.
  const gw = mockGateway();
  await assert.rejects(
    () => registerRemoteServer(
      gw,
      { id: "evil", name: "Evil", mcpUrl: "http://169.254.169.254/latest/meta-data/" },
      { sleepImpl: async () => {} }, // deliberately NO skipSsrf
    ),
    /E_GUARD_INPUT_BLOCKED|blocked/i,
  );
  assert.equal(gw.registered.size, 0); // nothing registered — fail-closed
});

// ──────────────────────────────────────────────────────────────────────── catalog / search ──
test("searchCatalog ranks the most relevant marketplace server first", () => {
  const matches = searchCatalog("list linear issues");
  assert.ok(matches.length > 0);
  assert.equal(matches[0].id, "linear");
});

test("searchCatalog drops zero-match entries and returns [] for a miss", () => {
  const catalog: CatalogEntry[] = [
    { id: "a", name: "Alpha", description: "does alpha", mcpUrl: "u", category: "x", needsAuth: false },
  ];
  assert.deepEqual(searchCatalog("zzzz nonsense", catalog), []);
});

test("mcpmarketCatalog loads the committed catalog JSON", () => {
  const catalog = mcpmarketCatalog();
  assert.ok(catalog.length >= 3);
  assert.ok(catalog.every((e) => e.id && e.name && e.mcpUrl && e.category));
});

// ─────────────────────────────────────────────────────────────────────────── meta-tools ──
test("mcpmarket.search handler returns ranked matches as JSON", async () => {
  const out = await mcpmarketSearchHandler({ query: "payments refund" }, { userId: "u", orgId: "o", credential: "vault:stub" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.query, "payments refund");
  assert.equal(parsed.matches[0].id, "stripe");
});

test("mcpmarket.request_register handler raises approval_required with provenance (never self-registers)", async () => {
  const out = await mcpmarketRequestRegisterHandler({ serverId: "linear" }, { userId: "u", orgId: "o", credential: "vault:stub" });
  const parsed = JSON.parse(out);
  assert.equal(parsed.status, "approval_required");
  assert.equal(parsed.approver, "admin");
  assert.equal(parsed.source, "mcpmarket:linear");
});

test("mcpmarket.request_register handler reports an unknown server id", async () => {
  const out = await mcpmarketRequestRegisterHandler({ serverId: "nope" }, { userId: "u", orgId: "o", credential: "vault:stub" });
  assert.equal(JSON.parse(out).status, "unknown_server");
});
