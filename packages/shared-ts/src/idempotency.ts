// Idempotency-key store (instructions.md §21, Principle #8).
// Wire-compatible contract with packages/shared-py/olma_shared/idempotency.py.
// Prod backs this with Redis (24h TTL, §16.2); this is the in-memory dev impl.

export interface IdempotencyStore {
  remember(key: string, value: unknown, ttlSeconds?: number): boolean;
  get(key: string): unknown | null;
  seen(key: string): boolean;
}

export class InMemoryStore implements IdempotencyStore {
  private data = new Map<string, { exp: number; value: unknown }>();

  private purge(now: number): void {
    for (const [k, v] of this.data) if (v.exp <= now) this.data.delete(k);
  }

  /** Store value if absent. Returns true if newly stored, false if it existed. */
  remember(key: string, value: unknown, ttlSeconds = 86400): boolean {
    const now = Date.now() / 1000;
    this.purge(now);
    if (this.data.has(key)) return false;
    this.data.set(key, { exp: now + ttlSeconds, value });
    return true;
  }

  get(key: string): unknown | null {
    const now = Date.now() / 1000;
    const entry = this.data.get(key);
    if (!entry) return null;
    if (entry.exp <= now) {
      this.data.delete(key);
      return null;
    }
    return entry.value;
  }

  seen(key: string): boolean {
    return this.get(key) !== null;
  }

  clear(): void {
    this.data.clear();
  }
}
