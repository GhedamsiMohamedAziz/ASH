// Reusable HTTP client tests: retry-on-5xx, give-up-after-N, and circuit breaker.
// Run: node --test test/http-client.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fetchWithRetry,
  HttpRetriesExhaustedError,
  CircuitBreaker,
  CircuitBreakerOpenError,
  ResilientHttpClient,
} from "../src/http-client.ts";

// A mock fetch returning a canned status every call, counting invocations.
function mockFetch(status: number, sink: { calls: number }): typeof fetch {
  return (async () => {
    sink.calls++;
    return { ok: status >= 200 && status < 300, status, text: async () => "" } as any;
  }) as unknown as typeof fetch;
}

const NO_WAIT = { sleepImpl: async () => {} }; // tests don't need real backoff delays

// --------------------------------------------------------------------------------- retries
test("fetchWithRetry returns immediately on success", async () => {
  const sink = { calls: 0 };
  const res = await fetchWithRetry("http://x", {}, { fetchImpl: mockFetch(200, sink), ...NO_WAIT });
  assert.equal(res.status, 200);
  assert.equal(sink.calls, 1);
});

test("fetchWithRetry retries on 5xx and gives up after N retries", async () => {
  const sink = { calls: 0 };
  await assert.rejects(
    () => fetchWithRetry("http://x", {}, { fetchImpl: mockFetch(503, sink), retries: 2, ...NO_WAIT }),
    (e: any) => e instanceof HttpRetriesExhaustedError && e.status === 503,
  );
  assert.equal(sink.calls, 3); // initial attempt + 2 retries
});

test("fetchWithRetry does not retry a non-retryable status (e.g. 404)", async () => {
  const sink = { calls: 0 };
  const res = await fetchWithRetry("http://x", {}, { fetchImpl: mockFetch(404, sink), retries: 3, ...NO_WAIT });
  assert.equal(res.status, 404);
  assert.equal(sink.calls, 1);
});

test("fetchWithRetry retries network errors too, then rethrows", async () => {
  let calls = 0;
  const failing: typeof fetch = (async () => {
    calls++;
    throw new Error("ECONNRESET");
  }) as unknown as typeof fetch;
  await assert.rejects(
    () => fetchWithRetry("http://x", {}, { fetchImpl: failing, retries: 1, ...NO_WAIT }),
    /ECONNRESET/,
  );
  assert.equal(calls, 2);
});

// ---------------------------------------------------------------------------- circuit breaker
test("circuit breaker opens after the failure threshold and short-circuits further calls", async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
  const failing = () => Promise.reject(new Error("boom"));

  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => breaker.exec(failing), /boom/);
  }
  assert.equal(breaker.currentState, "open");

  let called = false;
  await assert.rejects(
    () => breaker.exec(async () => { called = true; }),
    (e: any) => e instanceof CircuitBreakerOpenError,
  );
  assert.equal(called, false); // the underlying call never runs while open
});

test("circuit breaker half-opens after resetTimeoutMs and closes again on a successful probe", async () => {
  let now = 0;
  const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 1000, nowImpl: () => now });
  await assert.rejects(() => breaker.exec(() => Promise.reject(new Error("x"))));
  await assert.rejects(() => breaker.exec(() => Promise.reject(new Error("x"))));
  assert.equal(breaker.currentState, "open");

  now = 1500; // past resetTimeoutMs
  const result = await breaker.exec(async () => "ok");
  assert.equal(result, "ok");
  assert.equal(breaker.currentState, "closed");
});

test("ResilientHttpClient combines retry + breaker: repeated 5xx opens the breaker", async () => {
  const sink = { calls: 0 };
  const client = new ResilientHttpClient({
    fetchImpl: mockFetch(500, sink),
    retries: 0,
    breaker: { failureThreshold: 2, resetTimeoutMs: 60_000 },
    ...NO_WAIT,
  });
  await assert.rejects(() => client.request("http://x"));
  await assert.rejects(() => client.request("http://x"));
  assert.equal(client.breakerState, "open");
  const callsBeforeOpen = sink.calls;
  await assert.rejects(() => client.request("http://x"), (e: any) => e instanceof CircuitBreakerOpenError);
  assert.equal(sink.calls, callsBeforeOpen); // breaker refused before touching fetch again
});
