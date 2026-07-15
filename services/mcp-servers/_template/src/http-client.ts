// Reusable resilient HTTP client (instructions.md §14 "règles communes": retries exponentiels sur
// 429/5xx ; §13.1 dispatch: "connexion pooled, circuit breaker, timeout 60s"). A real connector's
// rest.ts (see ../github/src/rest.ts for the un-generalized, single-connector shape this factors
// out of) constructs ONE ResilientHttpClient and calls `.request(url, init)` instead of raw
// fetch — retries, breaker and timeout are then automatic and shared across every call site.

export interface RetryOpts {
  retries?: number; // additional attempts after the first (default 3)
  baseDelayMs?: number; // first backoff delay (default 200ms, doubles each attempt)
  maxDelayMs?: number; // backoff cap (default 4000ms)
  retryStatuses?: Iterable<number>; // response statuses that trigger a retry (default 429 + 5xx)
  timeoutMs?: number; // per-attempt timeout via AbortController (default 10s)
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>; // overridable in tests to avoid real waits
}

export interface CircuitBreakerOpts {
  failureThreshold?: number; // consecutive failures before the breaker opens (default 5)
  resetTimeoutMs?: number; // time in "open" before a single half-open probe is allowed (default 30s)
  nowImpl?: () => number; // overridable clock for tests
}

export class CircuitBreakerOpenError extends Error {
  constructor() {
    super("circuit breaker is open — upstream has been failing repeatedly, refusing new calls");
    this.name = "CircuitBreakerOpenError";
  }
}

export class HttpRetriesExhaustedError extends Error {
  status: number;
  constructor(status: number, url: string) {
    super(`upstream kept returning ${status} after retries: ${url}`);
    this.name = "HttpRetriesExhaustedError";
    this.status = status;
  }
}

export type BreakerState = "closed" | "open" | "half_open";

// Simple consecutive-failure breaker: closed → open after N consecutive failures; open refuses
// every call until resetTimeoutMs elapses, then allows exactly one half-open probe; that probe's
// outcome decides closed (success) or open again (failure). No external deps, no timers to leak.
export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOpts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.now = opts.nowImpl ?? Date.now;
  }

  get currentState(): BreakerState {
    return this.state;
  }

  async exec<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === "open") {
      if (this.now() - this.openedAt < this.resetTimeoutMs) {
        throw new CircuitBreakerOpenError();
      }
      this.state = "half_open"; // let exactly one call through as a probe
    }
    try {
      const result = await fn();
      this.consecutiveFailures = 0;
      this.state = "closed";
      return result;
    } catch (err) {
      this.consecutiveFailures++;
      if (this.state === "half_open" || this.consecutiveFailures >= this.failureThreshold) {
        this.state = "open";
        this.openedAt = this.now();
      }
      throw err;
    }
  }
}

const DEFAULT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);

// Retries with exponential backoff on network errors and on the given retryStatuses (default
// 429/5xx per §14's "règles communes"). A non-retryable status (e.g. 404) is returned immediately
// so the caller's own status-mapping (see rest.ts's mapStatus) decides the named §21 error.
export async function fetchWithRetry(url: string, init: RequestInit, opts: RetryOpts = {}): Promise<Response> {
  const retries = opts.retries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 200;
  const maxDelayMs = opts.maxDelayMs ?? 4000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const retryStatuses = new Set(opts.retryStatuses ?? DEFAULT_RETRY_STATUSES);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleepImpl = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let lastNetworkErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { ...init, signal: controller.signal });
      clearTimeout(timer);
      if (!retryStatuses.has(res.status)) return res; // success or a non-retryable status
      if (attempt === retries) throw new HttpRetriesExhaustedError(res.status, url);
      await sleepImpl(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs));
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof HttpRetriesExhaustedError) throw err;
      lastNetworkErr = err;
      if (attempt === retries) throw lastNetworkErr;
      await sleepImpl(Math.min(baseDelayMs * 2 ** attempt, maxDelayMs));
    }
  }
  // Unreachable (the loop always returns or throws), kept for type-safety.
  throw lastNetworkErr ?? new Error("fetchWithRetry: exhausted retries");
}

// Combines retry + breaker + timeout behind one call. The real connector's rest.ts constructs
// ONE of these and reuses it across every backend method (TODO(connector): tune retries/breaker
// per the real upstream's documented rate limits).
export class ResilientHttpClient {
  private readonly breaker: CircuitBreaker;
  private readonly retryOpts: RetryOpts;

  constructor(opts: RetryOpts & { breaker?: CircuitBreakerOpts } = {}) {
    this.breaker = new CircuitBreaker(opts.breaker);
    this.retryOpts = opts;
  }

  get breakerState(): BreakerState {
    return this.breaker.currentState;
  }

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    return this.breaker.exec(() => fetchWithRetry(url, init, this.retryOpts));
  }
}
