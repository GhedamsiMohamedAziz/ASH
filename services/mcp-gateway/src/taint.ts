// Taint tracking + tool egress registry (instructions.md §17.6, CLAUDE.md invariants #4/#5).
//
// The rule: the moment a turn ingests untrusted content (a tool with ingestsUntrusted returns a
// non-empty result), every public-egress tool for that task flips to require_approval — and in a
// scheduled run, fails (E_GUARD_TAINTED_EGRESS). Detection is NOT a boundary (§17.6.1): the taint
// flag is set by the Gateway from tool metadata, not inferred by a classifier. Once set for a
// task_id, it never clears (§17.6.3) — a turn cannot "untaint" itself by doing something clean.

export type EgressClass = "public" | "internal" | "none";

// Every MCP tool MUST declare both attributes at registration (invariant #4). A tool with no
// metadata cannot be registered — enforced in gateway.register().
export interface ToolMeta {
  ingestsUntrusted: boolean; // does this tool's RESULT bring untrusted content into the turn?
  egressClass: EgressClass;  // "public" = sends data OUT of the trust boundary
}

// Idempotency-style ledger keyed by task_id. In-memory default; a Redis-backed store injects the
// same interface in prod (per-task flag with TTL). Mirrors the scheduler's RunsStore seam (ADR-012).
//
// Return types allow `boolean | Promise<boolean>` (resp. `void | Promise<void>`) rather than a
// bare sync signature: InMemoryTaint stays fully synchronous (existing tests call isTainted()
// directly, unawaited), while RedisTaint below is genuinely async (network I/O). Callers `await`
// both uniformly — awaiting a plain value is a no-op, so this is a superset, not a breaking change.
export interface TaintStore {
  isTainted(taskId: string): boolean | Promise<boolean>;
  taint(taskId: string): void | Promise<void>;
}

export class InMemoryTaint implements TaintStore {
  private tainted = new Set<string>();
  isTainted(taskId: string): boolean {
    return this.tainted.has(taskId);
  }
  taint(taskId: string): void {
    this.tainted.add(taskId); // monotonic: once tainted, always tainted for this task (§17.6.3)
  }
}

// Same TTL as the TASK JWT lifetime (pipeline.py TASK_JWT_TTL, §13.4) — the taint flag naturally
// expires with the task it was set for rather than living in Redis forever.
const DEFAULT_TTL_SECONDS = 900;

// Redis-backed TaintStore (§4.4 "Reste à faire": Gateway + prompt-layer TaintLedger point at the
// SAME Redis so a scheduled run's taint is visible cross-process). Config-gated seam (ADR-012): the
// "redis" client is imported lazily, on first real use, so the offline/keyless default path (no
// REDIS_URL) never needs the package installed — mirrors pgstore.py's asyncpg import, which is only
// reached inside the `if DATABASE_URL:` branch.
export class RedisTaint implements TaintStore {
  private client: RedisLike | null = null;
  private connecting: Promise<void> | null = null;
  private readonly url: string;
  private readonly ttlSeconds: number;

  constructor(url: string, ttlSeconds: number = DEFAULT_TTL_SECONDS) {
    this.url = url;
    this.ttlSeconds = ttlSeconds;
  }

  private async ready(): Promise<RedisLike> {
    if (!this.client) {
      const { createClient } = await import("redis");
      const client = createClient({ url: this.url }) as unknown as RedisLike;
      client.on("error", (err: unknown) => console.error("[taint] redis client error", err));
      this.client = client;
    }
    if (!this.connecting) this.connecting = this.client.connect();
    await this.connecting;
    return this.client;
  }

  async isTainted(taskId: string): Promise<boolean> {
    const client = await this.ready();
    const exists = await client.exists(taintKey(taskId));
    return exists > 0;
  }

  async taint(taskId: string): Promise<void> {
    const client = await this.ready();
    // NX: only set if absent — idempotent and never refreshes/extends an existing flag, so a
    // later taint() call for the same task_id cannot un-taint or reset its TTL (§17.6.3).
    await client.set(taintKey(taskId), "1", { NX: true, EX: this.ttlSeconds });
  }
}

function taintKey(taskId: string): string {
  return `taint:${taskId}`;
}

// Minimal shape of the "redis" v4 client this file relies on — avoids a hard static dependency on
// the package's types (which aren't installed in the offline/keyless default path).
interface RedisLike {
  connect(): Promise<void>;
  exists(key: string): Promise<number>;
  set(key: string, value: string, opts: { NX: boolean; EX: number }): Promise<unknown>;
  on(event: "error", cb: (err: unknown) => void): void;
}

// Factory (mirrors RunsStore/PgStore-style config-gated seam, ADR-012): REDIS_URL configured →
// RedisTaint (shared with prompt-layer's TaintLedger, §4.4); unset → InMemoryTaint, the default so
// the offline/keyless dev + test path is unchanged.
export function taintStoreFromEnv(env: NodeJS.ProcessEnv = process.env): TaintStore {
  const url = env.REDIS_URL;
  return url ? new RedisTaint(url) : new InMemoryTaint();
}
