// mcpmarket learned-skill durability (opt-in). rehydrateMcpmarket re-mounts persisted skills on boot
// when MCPMARKET_STATE_PATH is set; unset → pure no-op (no file access, no behavior change). A stale
// catalog id is skipped gracefully. Full connect-and-re-mount is proven live (server.ts e2e); here we
// cover the opt-in gate + graceful-skip without a network fixture. Run: node --test test/
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync } from "node:fs";
import { buildGateway, rehydrateMcpmarket } from "../src/server.ts";

function keyless<T>(fn: () => T): T {
  const prev = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN; // buildGateway defaults to StubBackend only when GITHUB_TOKEN is unset
  try { return fn(); } finally { if (prev === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = prev; }
}

test("rehydrateMcpmarket is a no-op when MCPMARKET_STATE_PATH is unset (opt-in — no regression)", async () => {
  const prev = process.env.MCPMARKET_STATE_PATH;
  delete process.env.MCPMARKET_STATE_PATH;
  try {
    const r = await keyless(() => rehydrateMcpmarket(buildGateway()));
    assert.deepEqual(await r, { mounted: 0, total: 0 });
  } finally {
    if (prev === undefined) delete process.env.MCPMARKET_STATE_PATH; else process.env.MCPMARKET_STATE_PATH = prev;
  }
});

test("rehydrateMcpmarket counts but skips an unknown catalog id (fail-open on a stale entry)", async () => {
  const prev = process.env.MCPMARKET_STATE_PATH;
  const f = `/tmp/olma-test-mcpmarket-${process.pid}.json`;
  writeFileSync(f, JSON.stringify(["does-not-exist-in-catalog"]));
  process.env.MCPMARKET_STATE_PATH = f;
  try {
    const r = await keyless(() => rehydrateMcpmarket(buildGateway()));
    assert.deepEqual(r, { mounted: 0, total: 1 }); // counted (total 1), not mounted (unknown id, skipped)
  } finally {
    try { unlinkSync(f); } catch { /* ignore */ }
    if (prev === undefined) delete process.env.MCPMARKET_STATE_PATH; else process.env.MCPMARKET_STATE_PATH = prev;
  }
});
