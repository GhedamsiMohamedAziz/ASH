// MCP Gateway HTTP surface (instructions.md §13). Node stdlib http — no framework
// dep. POST /v1/tool/call runs a tool through the gateway; GET /healthz, GET /audit.
// In prod this listens on :8443 with mTLS from the sandboxes only (§17.4).
import { createServer } from "node:http";
import { McpGateway, type ToolCall, type ToolHandler } from "./gateway.ts";
import { GithubMcp, StubBackend, type GithubBackend } from "../../mcp-servers/github/src/github.ts";
import { RestBackend } from "../../mcp-servers/github/src/rest.ts";
import { BrowserMcp, type BrowserBackend } from "../../mcp-servers/browser/src/browser.ts";
import { DatabaseMcp, type DbBackend } from "../../mcp-servers/database/src/database.ts";
import { SchedulerMcp, type AutomationBackend, type CronSpec, type JobRef } from "../../mcp-servers/scheduler/src/scheduler.ts";
import { M365Mcp, type M365Backend } from "../../mcp-servers/m365/src/m365.ts";
import type { AllowListResolver } from "../../mcp-servers/browser/src/ssrf.ts";
import { CredentialResolver, InMemoryVault, CredentialMissing } from "./vault.ts";
import { verifyES256, type VerifyOpts } from "../../../packages/shared-ts/src/jwt.ts";
import { ReloadingJwks, DEFAULT_JWKS_RELOAD_SECONDS } from "./jwks-reload.ts";
import { handleMcpRpc, bearer } from "./mcp.ts";

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

// Browser connector egress metadata (§17.6.2). Both tools pull WEB CONTENT — arbitrary untrusted
// input — into the turn, so ingestsUntrusted:true. egressClass "public" because the URL argument
// itself is an outbound channel: a fetch to an attacker-controlled host can carry exfiltrated data
// OUTSIDE the trust boundary. That is exactly what must be reclassified on a tainted turn — so once
// this turn has ingested untrusted content, browser.read_page / browser.fetch flip to
// require_approval (interactive) or E_GUARD_TAINTED_EGRESS (scheduled), even though they also ingest.
const BROWSER_META: Record<string, { ingestsUntrusted: boolean; egressClass: string }> = {
  "browser.read_page": { ingestsUntrusted: true, egressClass: "public" },
  "browser.fetch": { ingestsUntrusted: true, egressClass: "public" },
};

// Database connector egress metadata (§17.6.2). All three tools are READ-ONLY (no write tool exists
// on this connector) so nothing leaves the trust boundary → egressClass "none". Rows can still hold
// user-generated / untrusted content (comments, names, free-text columns), so ingestsUntrusted:true:
// reading them taints the turn, which then gates any later public-egress tool.
const DB_META: Record<string, { ingestsUntrusted: boolean; egressClass: string }> = {
  "database.query": { ingestsUntrusted: true, egressClass: "none" },
  "database.list_tables": { ingestsUntrusted: true, egressClass: "none" },
  "database.describe": { ingestsUntrusted: true, egressClass: "none" },
};

// Scheduler connector egress metadata (§17.6.2). Every tool reads or mutates the requester's OWN
// automation config (cron jobs) and returns job metadata only — no message or content ever leaves
// the trust boundary → egressClass "none" for all five. The results are structured job records the
// agent itself authored (ids, statuses, schedules), not attacker-influenceable content, so
// ingestsUntrusted:false — a scheduler call never taints the turn and is never taint-gated. NOTE:
// scheduler.create_cron is separately require_approval by POLICY (tool_policies → approval_tools in
// the TASK JWT, §13.3); that human-in-the-loop gate is orthogonal to egress class and is enforced by
// the gateway's approval check, NOT here. Do not conflate "require_approval policy" with "public egress".
const SCHED_META: Record<string, { ingestsUntrusted: boolean; egressClass: string }> = {
  "scheduler.create_cron": { ingestsUntrusted: false, egressClass: "none" },
  "scheduler.list_crons": { ingestsUntrusted: false, egressClass: "none" },
  "scheduler.pause_cron": { ingestsUntrusted: false, egressClass: "none" },
  "scheduler.resume_cron": { ingestsUntrusted: false, egressClass: "none" },
  "scheduler.run_now": { ingestsUntrusted: false, egressClass: "none" },
};

// M365 / MS Graph connector egress metadata (§17.6.2) — the security-critical classification.
// READS (list_mail/read_mail/search_files) pull mail bodies, message metadata and SharePoint file
// content authored by ARBITRARY external senders — attacker-influenceable untrusted content entering
// the turn → ingestsUntrusted:true. They only read; nothing is sent out → egressClass "none". Reading
// any of them taints the task, which then gates every later public-egress tool (§17.6.3).
// send_mail DELIVERS a composed message to recipients OUTSIDE the trust boundary → egressClass
// "public": on a tainted turn it MUST reclassify (require_approval interactive / E_GUARD_TAINTED_EGRESS
// scheduled) so exfiltration of ingested untrusted content is blocked; it composes outbound, it does
// not bring untrusted content in → ingestsUntrusted:false. create_event WRITES to the user's OWN
// calendar (no external attendee/invite parameter on the backend) — a mutation that stays WITHIN the
// trust boundary, so egressClass "internal" (not read-only, but nothing leaves); its result is just an
// event id → ingestsUntrusted:false.
const M365_META: Record<string, { ingestsUntrusted: boolean; egressClass: string }> = {
  "m365.list_mail": { ingestsUntrusted: true, egressClass: "none" },
  "m365.read_mail": { ingestsUntrusted: true, egressClass: "none" },
  "m365.search_files": { ingestsUntrusted: true, egressClass: "none" },
  "m365.send_mail": { ingestsUntrusted: false, egressClass: "public" },
  "m365.create_event": { ingestsUntrusted: false, egressClass: "internal" },
};

// Default keyless Scheduler backend. The M365 connector ships its own StubM365 default, but
// SchedulerMcp requires an injected AutomationBackend — this deterministic stub keeps the
// offline/dev/test path keyless (mirrors StubBackend/StubFetch/StubDb) until a real HTTP client to
// the automation-service is injected via opts.schedulerBackend.
class StubAutomation implements AutomationBackend {
  async create(_userId: string, _orgId: string, _spec: CronSpec): Promise<JobRef> {
    return { jobId: "job_stub", status: "pending_approval", humanSchedule: "" };
  }
  async list(): Promise<JobRef[]> {
    return [{ jobId: "job_stub", status: "active", humanSchedule: "chaque jour à 8h00 (UTC)" }];
  }
  async pause(jobId: string): Promise<JobRef> {
    return { jobId, status: "paused", humanSchedule: "" };
  }
  async resume(jobId: string): Promise<JobRef> {
    return { jobId, status: "active", humanSchedule: "" };
  }
  async runNow(_jobId: string): Promise<{ runId: string }> {
    return { runId: "srun_stub" };
  }
}

// Thin adapter (handler-shape bridge): the browser/database connector tools return structured
// objects (Promise<unknown>), but the gateway's ToolHandler is Promise<string> — it DLP-scrubs the
// result and uses its length to decide taint. Stringify non-string results so scrub() runs on the
// content and a non-empty result correctly taints the turn (an object's `.length` is undefined, so
// without this the taint set in gateway.call would never fire for these connectors). github tools
// already return strings/arrays with a usable `.length`, so their wiring stays untouched.
function stringifyHandler(h: (a: any, ctx: any) => Promise<unknown>): ToolHandler {
  return async (args, ctx) => {
    const out = await h(args, ctx);
    return typeof out === "string" ? out : JSON.stringify(out);
  };
}

// The GitHub connector becomes REAL with zero code change: set GITHUB_TOKEN and the gateway swaps
// StubBackend → RestBackend (§ADR-012). The token reaches the tool via the credential resolver (the
// Vault stand-in, §13.2) — NOT ambient env inside the backend — so it stays a per-request injection
// on the one egress point, not a shared ambient secret (confused-deputy guard, §3.2). Pass
// `githubBackend` to inject a fetch-mocked RestBackend in tests (keyless).
export function buildGateway(
  opts: {
    githubBackend?: GithubBackend;
    // Real headless-browser fetch injectable here (default StubFetch → offline/keyless), mirroring
    // the githubBackend seam. `browserAllowList` supplies the per-org domain allow-list the SSRF
    // gate enforces (default deny inside BrowserMcp — nothing is reachable until an org opts in).
    browserBackend?: BrowserBackend;
    browserAllowList?: AllowListResolver;
    // Real read-only Postgres backend (pg.ts) injectable here (default StubDb → offline/keyless).
    dbBackend?: DbBackend;
    // Real automation-service client injectable here (default StubAutomation → offline/keyless),
    // mirroring the browserBackend/dbBackend seam.
    schedulerBackend?: AutomationBackend;
    // Real MS Graph (OBO) backend injectable here (default StubM365 inside M365Mcp → offline/keyless).
    m365Backend?: M365Backend;
  } = {},
): McpGateway {
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
  // Mount the Browser connector (StubFetch offline default; real BrowserBackend injectable). The
  // SSRF gate lives inside BrowserMcp and defaults to deny — pass browserAllowList to permit hosts.
  const browserTools = new BrowserMcp({ backend: opts.browserBackend, allowList: opts.browserAllowList }).tools();
  for (const [name, meta] of Object.entries(BROWSER_META)) {
    gw.register(name, stringifyHandler(browserTools[name]), meta);
  }
  // Mount the Database connector (StubDb offline default; real read-only DbBackend injectable).
  const dbTools = new DatabaseMcp(opts.dbBackend).tools();
  for (const [name, meta] of Object.entries(DB_META)) {
    gw.register(name, stringifyHandler(dbTools[name]), meta);
  }
  // Mount the Scheduler connector (StubAutomation offline default; real AutomationBackend injectable).
  // SchedulerMcp.tools() binds userId/orgId at build time, but the gateway only knows them per-call
  // (from the verified TASK JWT). So rebuild the tool map per invocation from ctx.userId/ctx.orgId and
  // dispatch the named tool — then reuse stringifyHandler so the object result is JSON-stringified for
  // gw.call's DLP/taint (a scheduler result is job metadata; egress "none" means it is never gated).
  const scheduler = new SchedulerMcp(opts.schedulerBackend ?? new StubAutomation());
  for (const [name, meta] of Object.entries(SCHED_META)) {
    gw.register(name, stringifyHandler((a, ctx) => scheduler.tools(ctx.userId, ctx.orgId)[name](a)), meta);
  }
  // Mount the M365 connector (StubM365 offline default inside M365Mcp; real Graph backend injectable).
  // Its tool handlers already take (args, ctx) with the Ctx { credential, userId } the gateway supplies.
  const m365Tools = new M365Mcp(opts.m365Backend).tools();
  for (const [name, meta] of Object.entries(M365_META)) {
    gw.register(name, stringifyHandler(m365Tools[name]), meta);
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
    // MCP Streamable-HTTP surface (instructions.md §13): the protocol opencode actually speaks
    // (sandbox/opencode.json → { type: remote, url: .../mcp }). Additive to the REST routes above.
    // Every tools/call is delegated to gw.call() (see mcp.ts), so the FULL auth chain runs unchanged;
    // Authorization: Bearer <TASK_JWT> is threaded into taskJwt — no/bad token fails closed, no bypass.
    if (req.url === "/mcp") {
      // The optional server->client SSE channel is not offered (we push no notifications). The MCP
      // StreamableHTTP client tolerates 405 here and proceeds over POST (JSON-response mode).
      if (req.method === "GET") {
        return send(405, { jsonrpc: "2.0", error: { code: -32000, message: "no SSE stream" } });
      }
      if (req.method === "POST") {
        // Fail-closed resource bounds: the gateway is the single egress point for every sandbox,
        // so an unbounded body or batch is a shared-availability DoS (parsing precedes auth).
        const MAX_BODY = 1 << 20; // 1 MiB
        const MAX_BATCH = 50;
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY) {
            return send(413, { jsonrpc: "2.0", error: { code: -32000, message: "payload too large" } });
          }
        }
        let body: any;
        try {
          body = JSON.parse(raw);
        } catch {
          return send(400, { jsonrpc: "2.0", error: { code: -32700, message: "parse error" } });
        }
        const taskJwt = bearer(req.headers["authorization"]);
        const batched = Array.isArray(body);
        if (batched && body.length > MAX_BATCH) {
          return send(400, { jsonrpc: "2.0", error: { code: -32600, message: "batch too large" } });
        }
        const msgs = batched ? body : [body];
        const responses: any[] = [];
        for (const m of msgs) {
          const r = await handleMcpRpc(gw, m, taskJwt);
          if (r) responses.push(r);
        }
        // An all-notification batch (e.g. notifications/initialized) yields no responses → 202.
        if (responses.length === 0) {
          res.writeHead(202);
          return res.end();
        }
        return send(200, batched ? responses : responses[0]);
      }
      res.writeHead(405);
      return res.end();
    }
    send(404, { error: { code: "E_NOT_FOUND", message: "not found" } });
  });
}

// Boot when run directly.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 8443);
  createGatewayServer().listen(port, () => console.log(`mcp-gateway on :${port}`));
}
