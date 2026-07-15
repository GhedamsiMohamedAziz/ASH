// Minimal OTel seam (instructions.md §19 observability) — dependency-light by design so a fresh
// connector copied from this template has ZERO required deps. Default is a no-op tracer; a real
// connector (or this one, once wired) swaps in `@opentelemetry/api` at boot without touching any
// call site, because every call site only ever asks getTracer() for the current tracer.

export interface Span {
  setAttribute(key: string, value: string | number | boolean): void;
  recordException(err: unknown): void;
  end(): void;
}

export interface Tracer {
  // Wraps fn in a span named `name`; the span ends (and records the exception) whether fn
  // resolves or rejects, so callers never have to remember span.end() themselves.
  startSpan<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T>;
}

class NoopSpan implements Span {
  setAttribute(): void {}
  recordException(): void {}
  end(): void {}
}

class NoopTracer implements Tracer {
  async startSpan<T>(_name: string, fn: (span: Span) => Promise<T>): Promise<T> {
    const span = new NoopSpan();
    try {
      return await fn(span);
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  }
}

let tracer: Tracer = new NoopTracer();

// TODO(real OTel): call this once at boot (server.ts) when OTEL_EXPORTER_OTLP_ENDPOINT is set,
// e.g.:
//   import { trace, type Span as OtelSpan } from "@opentelemetry/api";
//   const otelTracer = trace.getTracer("olma-mcp-<connector>");
//   setTracer({
//     startSpan: (name, fn) =>
//       otelTracer.startActiveSpan(name, async (s: OtelSpan) => {
//         try { return await fn({ setAttribute: (k, v) => s.setAttribute(k, v),
//                                  recordException: (e) => s.recordException(e as Error),
//                                  end: () => {} }); }
//         finally { s.end(); }
//       }),
//   });
// Until then this no-op keeps the offline/keyless dev + test path unchanged.
export function setTracer(t: Tracer): void {
  tracer = t;
}

export function getTracer(): Tracer {
  return tracer;
}
