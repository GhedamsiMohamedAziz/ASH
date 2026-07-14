// Slack webhook security (instructions.md §7.2).
//
// Signature: v0=HMAC-SHA256(signing_secret, `v0:${ts}:${rawBody}`), compared in
// constant time. Anti-replay: reject timestamps outside a 5-minute window.
// Retry dedup: Slack re-sends an event (X-Slack-Retry-Num) if the first HTTP
// response is slow; dedupe on event_id so a task is never run twice.
import { createHmac, timingSafeEqual } from "node:crypto";

const FIVE_MIN = 60 * 5;

export interface SlackHeaders {
  "x-slack-signature"?: string;
  "x-slack-request-timestamp"?: string;
  "x-slack-retry-num"?: string;
}

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "missing" | "stale" | "bad_signature" };

export function verifySlackSignature(
  headers: SlackHeaders,
  rawBody: string,
  signingSecret: string,
  now: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const sig = headers["x-slack-signature"];
  const ts = headers["x-slack-request-timestamp"];
  if (!sig || !ts) return { ok: false, reason: "missing" };

  // Anti-replay window (§7.2).
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(now - tsNum) > FIVE_MIN) {
    return { ok: false, reason: "stale" };
  }

  const base = `v0:${ts}:${rawBody}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

// Build the signature a real Slack request would carry (used by tests + local tooling).
export function signSlackRequest(rawBody: string, signingSecret: string, ts: number): string {
  return "v0=" + createHmac("sha256", signingSecret).update(`v0:${ts}:${rawBody}`).digest("hex");
}

// Retry / duplicate-event guard. Prod backs this with Redis (event_id, 5-min TTL);
// this in-memory set covers the adapter's dedup contract for dev/tests.
export class EventDedup {
  private seen = new Set<string>();
  private capacity: number;
  constructor(capacity = 10000) {
    this.capacity = capacity;
  }

  /** Returns true if this event was already processed (drop it). */
  isDuplicate(eventId: string): boolean {
    if (!eventId) return false;
    if (this.seen.has(eventId)) return true;
    this.seen.add(eventId);
    if (this.seen.size > this.capacity) this.seen.delete(this.seen.values().next().value!);
    return false;
  }
}
