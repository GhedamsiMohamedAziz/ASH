// CLI bridge used by the cross-process Redis taint integration test
// (tests/integration/../../services/prompt-layer/tests/test_redis_taint_e2e.py).
//
// Exercises the REAL Gateway `RedisTaint` class (services/mcp-gateway/src/taint.ts) against a
// real Redis instance, so the Python-side test can prove the TS and Python TaintLedger
// implementations share state via Redis using the same `taint:{task_id}` key scheme (§17.6 /
// §4.4). This file is new and lives outside services/mcp-gateway/ on purpose — the Gateway's own
// src/ and test/ directories are out of scope for this change.
//
// Usage:
//   node redis_taint_bridge.mjs taint <redisUrl> <taskId>   -> taints taskId, prints "OK"
//   node redis_taint_bridge.mjs check <redisUrl> <taskId>   -> prints "true" or "false"
//
// On success prints a single line to stdout (see above) and exits 0. If the "redis" npm client
// isn't installed (no node_modules for services/mcp-gateway in this checkout), the dynamic
// `import("redis")` inside taint.ts rejects; this script detects that specific failure and prints
// "MODULE_NOT_FOUND:redis" to stderr with exit code 2, so the Python harness can fall back to a
// raw redis-cli/key-based check instead of failing outright.

import { pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const taintModulePath = path.resolve(here, "../../services/mcp-gateway/src/taint.ts");

const [, , mode, redisUrl, taskId] = process.argv;

if (!mode || !redisUrl || !taskId) {
  console.error("usage: redis_taint_bridge.mjs <taint|check> <redisUrl> <taskId>");
  process.exit(64);
}

let RedisTaint;
try {
  ({ RedisTaint } = await import(pathToFileURL(taintModulePath).href));
} catch (err) {
  console.error("FAILED_TO_LOAD_TAINT_MODULE: " + (err?.message ?? err));
  process.exit(3);
}

const store = new RedisTaint(redisUrl);

try {
  if (mode === "taint") {
    await store.taint(taskId);
    console.log("OK");
  } else if (mode === "check") {
    const tainted = await store.isTainted(taskId);
    console.log(tainted ? "true" : "false");
  } else {
    console.error(`unknown mode: ${mode}`);
    process.exit(64);
  }
  process.exit(0);
} catch (err) {
  const msg = String(err?.message ?? err);
  if (/cannot find (package|module) 'redis'/i.test(msg) || /Cannot find package 'redis'/i.test(msg)) {
    console.error("MODULE_NOT_FOUND:redis");
    process.exit(2);
  }
  console.error("ERROR: " + msg);
  process.exit(1);
}
