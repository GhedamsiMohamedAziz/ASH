// MCP Gateway HTTP surface (instructions.md §13). Node stdlib http — no framework
// dep. POST /v1/tool/call runs a tool through the gateway; GET /healthz, GET /audit.
// In prod this listens on :8443 with mTLS from the sandboxes only (§17.4).
import { createServer } from "node:http";
import { McpGateway, type ToolCall } from "./gateway.ts";
import { GithubMcp, StubBackend, type GithubBackend } from "../../mcp-servers/github/src/github.ts";
import { RestBackend } from "../../mcp-servers/github/src/rest.ts";
import { CredentialResolver, InMemoryVault, CredentialMissing } from "./vault.ts";
import { verifyES256, type VerifyOpts } from "../../../packages/shared-ts/src/jwt.ts";
import { ReloadingJwks, DEFAULT_JWKS_RELOAD_SECONDS } from "./jwks-reload.ts";

// Module-level Vault + resolver: the ONE credential store shared by the gateway's per-call
// injection (resolveCredential) and the HTTP connect surface (POST /v1/connect). Storing a token
// via the route is therefore visible to the very next tool call for that user (§13.2).
const DEFAULT_ORG = process.env.OLMA_ORG ?? "org_1";
export const vault = new InMemoryVault();
export const resolver = new CredentialResolver(vault);

// Fail closed in prod: verifying TASK tokens against a well-known dev secret would let
// anyone mint a valid token. Require the env var when OLMA_ENV=prod.
const SECRET = process.env.TASK_JWT_SECRET
  ?? (process.env.OLMA_ENV === "prod"
        ? (() => { throw new Error("TASK_JWT_SECRET must be set when OLMA_ENV=prod"); })()
        : "dev-task-jwt-secret");

// TASK JWT algorithm seam (ADR-012, §13.4). HS256 (shared secret) is the DEFAULT so the
// offline/keyless dev + test path is unchanged. Set TASK_JWT_ALG=ES256 to verify P-256
// ECDSA TASK JWTs against a JWKS (TASK_JWT_JWKS_PATH) — the gateway selects the key by the
// token's `kid` (2-key current+next rotation). No silent fallback: ES256 mode requires the
// JWKS and rejects unknown kids / wrong alg fail-closed.
const TASK_JWT_ALG = process.env.TASK_JWT_ALG ?? "HS256";

// The live JWKS source for ES256 mode (null in the default HS256 path → no reload timer). Held at
// module level so shutdown/tests can stop the interval via stopJwksReload().
let jwksSource: ReloadingJwks | null = null;

// Build the verification strategy passed to the gateway. HS256 → undefined (gateway uses its
// built-in shared-secret verify, byte-identical to before). ES256 → a JWKS-backed verifier that
// reads the LIVE keyset each call, so key rollover (current+next, §13.4) needs no restart.
function buildVerifyToken(opts: VerifyOpts): ((token: string) => Record<string, any>) | undefined {
  if (TASK_JWT_ALG === "HS256") return undefined;
  if (TASK_JWT_ALG === "ES256") {
    const jwksPath = process.env.TASK_JWT_JWKS_PATH;
    if (!jwksPath) throw new Error("TASK_JWT_JWKS_PATH must be set when TASK_JWT_ALG=ES256");
    // Periodic reload (default 5 min, override via TASK_JWT_JWKS_RELOAD_SECONDS): a newly-added kid
    // is picked up live; a malformed/missing refresh RETAINS the last-good keyset (never fails-closed
    // all tokens). Verify against current() so each call sees the freshest keys.
    const reloadSeconds = Number(process.env.TASK_JWT_JWKS_RELOAD_SECONDS ?? DEFAULT_JWKS_RELOAD_SECONDS);
    jwksSource?.stop(); // if rebuilt, don't leak a prior timer
    const source = new ReloadingJwks(jwksPath, { reloadSeconds });
    jwksSource = source;
    return (token: string) => verifyES256(token, source.current(), opts);
  }
  throw new Error(`unsupported TASK_JWT_ALG: ${TASK_JWT_ALG}`);
}

// Stop the JWKS reload timer (clean shutdown / tests) so the interval does not leak.
export function stopJwksReload(): void {
  jwksSource?.stop();
  jwksSource = null;
}

// Egress metadata (§17.6.2): search/read/list_issues ingest untrusted repo content; create/merge
// publish OUT (public). The gateway REQUIRES this at registration — a tool with no meta throws.
const GH_META: Record<string, { ingestsUntrusted: boolean; egressClass: string }> = {
  "github.search": { ingestsUntrusted: true, egressClass: "none" },
  "github.read": { ingestsUntrusted: true, egressClass: "none" },
  "github.list_issues": { ingestsUntrusted: true, egressClass: "none" },
  "github.create_pr": { ingestsUntrusted: false, egressClass: "public" },
  "github.merge_pr": { ingestsUntrusted: false, egressClass: "public" },
};

// The GitHub connector becomes REAL with zero code change: set GITHUB_TOKEN and the gateway swaps
// StubBackend → RestBackend (§ADR-012). The token reaches the tool via the credential resolver (the
// Vault stand-in, §13.2) — NOT ambient env inside the backend — so it stays a per-request injection
// on the one egress point, not a shared ambient secret (confused-deputy guard, §3.2). Pass
// `githubBackend` to inject a fetch-mocked RestBackend in tests (keyless).
export function buildGateway(opts: { githubBackend?: GithubBackend } = {}): McpGateway {
  const token = process.env.GITHUB_TOKEN;
  const backend: GithubBackend = opts.githubBackend ?? (token ? new RestBackend() : new StubBackend());
  // Preserve today's behavior: if the standalone GITHUB_TOKEN is set, seed it as the org's github
  // service credential so existing github.* calls resolve without an explicit /v1/connect (§ADR-012).
  // Real per-user tokens arrive later via POST /v1/connect → resolver.store.
  if (token) resolver.storeOrg(DEFAULT_ORG, "github", token);
  // Only the pure offline/stub path (no env token, no injected backend) has no real egress — there a
  // missing credential is harmless, so we hand back a sentinel to keep the dev/test chain keyless.
  const usingStub = !token && !opts.githubBackend;
  // Real Vault injection (§13.2): the requester's personal token first (Mode A), else the org's
  // service credential (Mode B). A genuine miss throws CredentialMissing → the gateway denies with
  // E_CONN_NEEDS_CONNECTION (fail-closed) — the sandbox never gets a shared/ambient token.
  const resolveCredential = (userId: string, tool: string): string => {
    try {
      return resolver.resolve(userId, tool);
    } catch (e) {
      if (!(e instanceof CredentialMissing)) throw e;
      try {
        return resolver.resolve(userId, tool, DEFAULT_ORG);
      } catch (e2) {
        if (usingStub && e2 instanceof CredentialMissing) return "vault:stub";
        throw e2;
      }
    }
  };
  const verifyOpts: VerifyOpts = {
    iss: "olma-prompt-layer",
    aud: "olma-mcp-gateway",
    requireExp: true, // a TASK token with no expiry never expires — reject it
  };
  const gw = new McpGateway(SECRET, verifyOpts, resolveCredential,
    undefined, buildVerifyToken(verifyOpts));
  // Mount the real GitHub MCP tool surface (stub or REST behind the same interface).
  const tools = new GithubMcp(backend).tools();
  for (const [name, meta] of Object.entries(GH_META)) {
    gw.register(name, tools[name], meta);
  }
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
    // Connector store (§13.2, AX-038): the OAuth callback / backend proxies a token here; it is
    // sealed (AES-256-GCM) in the Vault under (userId, provider) and never returned toward the sandbox.
    if (req.method === "POST" && req.url === "/v1/connect") {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      let body: { userId?: string; provider?: string; token?: string };
      try {
        body = JSON.parse(raw);
      } catch {
        return send(400, { error: { code: "E_VALIDATION", message: "bad json" } });
      }
      const { userId, provider, token } = body;
      if (!userId || !provider || !token) {
        return send(400, { error: { code: "E_VALIDATION", message: "userId, provider and token are required" } });
      }
      resolver.store(userId, provider, token);
      return send(200, { connected: true, provider });
    }
    // Report the providers this user can already reach: their own stored tokens plus the org-seeded
    // service credentials (Mode B). Tokens themselves never leave the Vault — only the provider names.
    if (req.method === "GET" && req.url?.startsWith("/v1/connections")) {
      const url = new URL(req.url, "http://localhost");
      const userId = url.searchParams.get("userId") ?? "";
      const providers = new Set<string>([
        ...resolver.providers(userId),
        ...resolver.providers(userId, DEFAULT_ORG),
      ]);
      const connections = [...providers].map((provider) => ({ provider, connected: true }));
      return send(200, { connections });
    }
    send(404, { error: { code: "E_NOT_FOUND", message: "not found" } });
  });
}

// Boot when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8443);
  createGatewayServer().listen(port, () => console.log(`mcp-gateway on :${port}`));
}
