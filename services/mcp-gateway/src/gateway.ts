// MCP Gateway core (instructions.md §13.1, ADR 001).
//
// The single point of AuthZ, secret injection, DLP and audit in front of every
// MCP server. A sandbox's ONLY network egress. For each tool call it:
//   1. verifies the TASK JWT (fail-closed),
//   2. checks the tool is in the token's allowed_tools (defense in depth, §9.4),
//   3. gates approval_tools (human-in-the-loop, §13.3),
//   4. injects the org/user credential (from Vault; stubbed here),
//   5. routes to the MCP server, DLP-scrubs the result (§13.5),
//   6. audits the call (who/what/when/result, §16.1).
import { verify, JWTError, type VerifyOpts } from "../../../packages/shared-ts/src/jwt.ts";
import { scrub } from "./dlp.ts";
import { taintStoreFromEnv, type TaintStore, type ToolMeta } from "./taint.ts";

export interface ToolCall {
  tool: string; // e.g. "github.create_pr"
  args: Record<string, unknown>;
  taskJwt: string;
}

export interface AuditEntry {
  ts: number;
  actor: string;
  on_behalf_of: string | null;
  action: string; // "tool.call"
  tool: string;
  status: "ok" | "denied" | "needs_approval" | "error";
  redacted: string[];
  reason?: string;
}

export interface GatewayResult {
  status: "ok" | "denied" | "needs_approval" | "error";
  code?: string; // taxonomy §21
  result?: string;
  redacted?: string[];
  reason?: string;
}

// Pluggable MCP backend: name -> handler. Prod routes to the real MCP servers;
// tests inject stubs. Credentials are injected here (from Vault) — never seen by
// the sandbox (§13.2).
export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: { userId: string; orgId: string; credential: string },
) => Promise<string>;

export class McpGateway {
  private handlers = new Map<string, ToolHandler>();
  private meta = new Map<string, ToolMeta>();
  public audit: AuditEntry[] = [];
  private secret: string;
  private opts: VerifyOpts;
  private verifyToken: (token: string) => Record<string, any>;
  private resolveCredential: (userId: string, tool: string) => string;
  private taint: TaintStore;

  constructor(
    secret: string,
    opts: VerifyOpts = {},
    // credential resolver stands in for Vault (§13.2); never returns to sandbox.
    resolveCredential: (userId: string, tool: string) => string = () => "vault:stub",
    // REDIS_URL configured → shared RedisTaint (cross-process, §4.4); unset → InMemoryTaint, so
    // the offline/keyless dev + test path is unchanged (ADR-012 config-gated seam).
    taint: TaintStore = taintStoreFromEnv(),
    // TASK JWT verification strategy (ADR-012 seam, §13.4). Default = HS256 shared-secret verify,
    // so the dev/test path is unchanged. server.ts swaps in an ES256/JWKS verifier when
    // TASK_JWT_ALG=ES256 — the gateway itself is algorithm-agnostic and stays fail-closed either way.
    verifyToken?: (token: string) => Record<string, any>,
  ) {
    this.secret = secret;
    this.opts = opts;
    this.verifyToken = verifyToken ?? ((token: string) => verify(token, this.secret, this.opts));
    this.resolveCredential = resolveCredential;
    this.taint = taint;
  }

  // Invariant #4 (§17.6.2): every tool declares ingestsUntrusted + egressClass at registration.
  // meta is REQUIRED — a tool cannot be registered without it (fail at wiring time, not runtime).
  register(tool: string, handler: ToolHandler, meta: ToolMeta): void {
    if (!meta || typeof meta.ingestsUntrusted !== "boolean" || !meta.egressClass) {
      throw new Error(`tool ${tool} registered without egress metadata (ingestsUntrusted/egressClass) — §17.6.2`);
    }
    this.handlers.set(tool, handler);
    this.meta.set(tool, meta);
  }

  private record(e: AuditEntry): void {
    this.audit.push(e);
  }

  async call(req: ToolCall): Promise<GatewayResult> {
    let claims: Record<string, any>;
    try {
      claims = this.verifyToken(req.taskJwt);
    } catch (e) {
      const reason = e instanceof JWTError ? e.message : "verify failed";
      this.record(mkAudit("unknown", null, req.tool, "denied", [], reason));
      return { status: "denied", code: "E_AUTH_INVALID_TOKEN", reason };
    }

    const actor: string = claims.sub;
    const onBehalf: string | null = claims.on_behalf_of ?? null;
    const subject = onBehalf ?? actor; // policy applies to the requester (§3.2)
    const allowed: string[] = claims.allowed_tools ?? [];
    const approval: string[] = claims.approval_tools ?? [];
    const taskId: string | null = claims.task_id ?? null;
    const origin: string = claims.origin ?? "interactive";
    const meta = this.meta.get(req.tool);

    // Defense in depth: even though the Prompt Layer computed allowed_tools, the
    // Gateway re-checks (§9.4). Fail-closed if the tool is not allowed.
    if (!allowed.includes(req.tool)) {
      this.record(mkAudit(actor, onBehalf, req.tool, "denied", [], "tool not in allowed_tools"));
      return { status: "denied", code: "E_PERM_TOOL_DENIED", reason: "tool not allowed" };
    }

    // Taint egress gate (§17.6.3), BEFORE the normal approval check and OVERRIDING policy: if
    // this turn has ingested untrusted content and the tool sends data OUT (egressClass public),
    // a scheduled run fails outright; an interactive run is forced to human approval — even if
    // tool_policies said allow. Detection isn't a boundary; the taint flag is.
    if (meta?.egressClass === "public" && taskId && (await this.taint.isTainted(taskId))) {
      if (origin === "scheduled") {
        this.record(mkAudit(actor, onBehalf, req.tool, "denied", [], "tainted egress (scheduled)"));
        return { status: "denied", code: "E_GUARD_TAINTED_EGRESS",
                 reason: "public egress blocked: turn ingested untrusted content (§17.6)" };
      }
      this.record(mkAudit(actor, onBehalf, req.tool, "needs_approval", [], "tainted egress requires approval"));
      return { status: "needs_approval", code: "E_GUARD_TAINTED_EGRESS",
               reason: "public egress requires approval: turn ingested untrusted content (§17.6)" };
    }

    // Human-in-the-loop gate (§13.3). The caller must resolve approval before
    // re-invoking; the Gateway does not execute an approval-gated tool inline.
    if (approval.includes(req.tool)) {
      this.record(mkAudit(actor, onBehalf, req.tool, "needs_approval", []));
      return { status: "needs_approval", reason: "tool requires approval" };
    }

    const handler = this.handlers.get(req.tool);
    if (!handler) {
      this.record(mkAudit(actor, onBehalf, req.tool, "error", [], "no such tool"));
      return { status: "error", code: "E_INTERNAL", reason: "no handler" };
    }

    try {
      const credential = this.resolveCredential(subject, req.tool); // Vault injection
      const raw = await handler(req.args, { userId: subject, orgId: claims.org_id, credential });
      const { text, redacted } = scrub(raw); // DLP on the way out (§13.5)
      // Taint set (§17.6.3): a tool that ingests untrusted content and actually returned some
      // taints the task, monotonically. From here every public-egress tool needs approval/fails.
      if (meta?.ingestsUntrusted && taskId && raw && raw.length > 0) {
        await this.taint.taint(taskId);
      }
      this.record(mkAudit(actor, onBehalf, req.tool, "ok", redacted));
      return { status: "ok", result: text, redacted };
    } catch (e) {
      const rawReason = e instanceof Error ? e.message : "handler error";
      // DLP the error path too: a handler error can carry a token, a Bearer header, or a
      // URL with an embedded secret (§13.5). scrub() before it reaches audit or the caller.
      const reason = scrub(rawReason).text;
      // A missing OAuth connection is not an upstream error — the user must connect
      // the provider first (§13.2). Surface the distinct taxonomy code.
      const code = (e as any)?.code === "E_CONN_NEEDS_CONNECTION"
        ? "E_CONN_NEEDS_CONNECTION" : "E_TOOL_UPSTREAM_ERROR";
      const status = code === "E_CONN_NEEDS_CONNECTION" ? "denied" : "error";
      this.record(mkAudit(actor, onBehalf, req.tool, status, [], reason));
      return { status: status as GatewayResult["status"], code, reason };
    }
  }
}

function mkAudit(
  actor: string,
  onBehalf: string | null,
  tool: string,
  status: AuditEntry["status"],
  redacted: string[],
  reason?: string,
): AuditEntry {
  // ts is passed 0 here and stamped by the caller's clock in prod; kept static
  // for deterministic tests. Real audit rows get now() at the DB layer (§16.1).
  return { ts: 0, actor, on_behalf_of: onBehalf, action: "tool.call", tool, status, redacted, reason };
}
