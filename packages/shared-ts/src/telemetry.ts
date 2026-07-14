// W3C traceparent propagation (instructions.md §8.1, §19).
// Wire-compatible with packages/shared-py/olma_shared/telemetry.py.
import { randomBytes } from "node:crypto";

const TP_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

export interface SpanContext {
  traceId: string; // 32 hex
  spanId: string; // 16 hex
  sampled: boolean;
}

const hex = (n: number): string => randomBytes(n).toString("hex");

export const toTraceparent = (c: SpanContext): string =>
  `00-${c.traceId}-${c.spanId}-${c.sampled ? "01" : "00"}`;

export const newTrace = (sampled = true): SpanContext => ({
  traceId: hex(16),
  spanId: hex(8),
  sampled,
});

export function parse(traceparent: string): SpanContext | null {
  const m = TP_RE.exec((traceparent || "").trim());
  if (!m) return null;
  const [, , traceId, spanId, flags] = m;
  if (traceId === "0".repeat(32) || spanId === "0".repeat(16)) return null;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 0x01) === 0x01 };
}

export function child(traceparent: string | null | undefined): SpanContext {
  const parent = traceparent ? parse(traceparent) : null;
  if (!parent) return newTrace();
  return { traceId: parent.traceId, spanId: hex(8), sampled: parent.sampled };
}
