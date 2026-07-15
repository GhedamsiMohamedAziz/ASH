// Live JWKS reload for ES256 TASK-JWT verification (instructions.md §13.4 rotation).
//
// In ES256 mode the gateway verifies TASK JWTs against a JWKS of P-256 public keys, selected by the
// token's `kid`. Key rollover (current+next, §13.4) MUST NOT require a restart: this source re-reads
// TASK_JWT_JWKS_PATH on an interval so a newly-added `kid` is picked up live, while old tokens whose
// `kid` is still in the refreshed set keep verifying.
//
// FAIL-SAFE (the whole point): a refresh that reads a briefly-missing or malformed file KEEPS the
// last-good keyset in memory and logs — it never drops to an empty keyset. Dropping keys would
// fail-closed EVERY token and cause an outage; a reload error must only ever RETAIN prior good keys,
// never widen access. Selection stays fail-closed (unknown kid → reject) via verifyES256 unchanged.
import { loadJwks, type Jwks } from "../../../packages/shared-ts/src/jwt.ts";

export const DEFAULT_JWKS_RELOAD_SECONDS = 300; // 5 minutes

export interface ReloadingJwksOptions {
  /** Reload cadence. <= 0 disables the timer (manual `reload()` only — used in tests). */
  reloadSeconds?: number;
  /** Injectable loader (tests point this at a temp file / stub); defaults to loadJwks. */
  load?: (path: string) => Jwks;
  /** Where reload failures are reported; defaults to console.error. */
  logger?: (msg: string, err: unknown) => void;
}

// Holds the active JWKS in memory and refreshes it on an interval. The verifier reads `current()`
// at verify-time, so a successful reload is visible to the very next token without a restart.
export class ReloadingJwks {
  private jwks: Jwks;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly path: string;
  private readonly load: (path: string) => Jwks;
  private readonly logger: (msg: string, err: unknown) => void;

  constructor(path: string, options: ReloadingJwksOptions = {}) {
    this.path = path;
    this.load = options.load ?? loadJwks;
    this.logger = options.logger ?? ((msg, err) => console.error(msg, err));
    // Initial load throws on a bad/empty JWKS — same fail-closed boot posture as before (a broken
    // JWKS at startup must not silently start with no keys).
    this.jwks = this.load(this.path);
    const seconds = options.reloadSeconds ?? DEFAULT_JWKS_RELOAD_SECONDS;
    if (seconds > 0) {
      this.timer = setInterval(() => this.reload(), seconds * 1000);
      // Do not keep the process alive solely for the reload timer.
      this.timer.unref?.();
    }
  }

  /** The active keyset. Verifiers call this per token so live reloads take effect immediately. */
  current(): Jwks {
    return this.jwks;
  }

  /** Re-read the JWKS. On ANY failure, RETAIN the last-good keyset (never empty/widen) and log. */
  reload(): void {
    try {
      this.jwks = this.load(this.path);
    } catch (err) {
      this.logger(
        `[jwks] reload of ${this.path} failed; retaining last-good keyset (${Object.keys(this.jwks).length} keys)`,
        err,
      );
    }
  }

  /** Stop the reload timer (shutdown / tests) so the interval does not leak. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
