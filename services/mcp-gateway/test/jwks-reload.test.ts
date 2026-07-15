// Live JWKS reload (instructions.md §13.4 rotation). Proves key rollover needs no restart, that a
// bad refresh retains the last-good keyset (never fails-closed all tokens), and that the timer stops.
// Run: node --test test/jwks-reload.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReloadingJwks } from "../src/jwks-reload.ts";

// Two committed P-256 test keys (same vectors as the shared-ts ES256 fixtures).
const KEY_JUL = {
  kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: "task-2026-07",
  x: "DOStmij1vvk6tMe4AxVWQLf1979Mnvbzs2XbLomknNE", y: "ExujUsX0ELGfmozQ1A9hbiXozXztp1R706AAmXxv9q8",
};
const KEY_AUG = {
  kty: "EC", crv: "P-256", alg: "ES256", use: "sig", kid: "task-2026-08",
  x: "OT74ZxB2jyMtbPVV4LpofWCZzxRPAf0kKxXEKhV6ExQ", y: "ZZP45I4t5E_2luJZGRlqrrTe-zRQANWL20nlcIOVI2s",
};

function jwksFile(keys: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "jwks-"));
  const path = join(dir, "task.jwks.json");
  writeFileSync(path, JSON.stringify({ keys }));
  return path;
}

test("reload picks up a newly-added kid without a restart", () => {
  const path = jwksFile([KEY_JUL]);
  const src = new ReloadingJwks(path, { reloadSeconds: 0 }); // manual reload only
  assert.deepEqual(Object.keys(src.current()), ["task-2026-07"]);

  // Rotate in the "next" key (current + next), then reload.
  writeFileSync(path, JSON.stringify({ keys: [KEY_JUL, KEY_AUG] }));
  src.reload();
  assert.deepEqual(Object.keys(src.current()).sort(), ["task-2026-07", "task-2026-08"]);
  // old kid still verifiable (still present in the refreshed set)
  assert.ok(src.current()["task-2026-07"]);
  src.stop();
});

test("a malformed refresh retains the prior good keyset (never fails-closed all tokens)", () => {
  const path = jwksFile([KEY_JUL, KEY_AUG]);
  const logs: string[] = [];
  const src = new ReloadingJwks(path, { reloadSeconds: 0, logger: (m) => logs.push(m) });
  assert.equal(Object.keys(src.current()).length, 2);

  // Corrupt the file (invalid JSON), then reload — must KEEP the last-good keys, not empty out.
  writeFileSync(path, "{ this is not json");
  src.reload();
  assert.deepEqual(Object.keys(src.current()).sort(), ["task-2026-07", "task-2026-08"]);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /retaining last-good keyset/);
  src.stop();
});

test("an empty/missing-keys refresh also retains the prior keyset", () => {
  const path = jwksFile([KEY_JUL]);
  const src = new ReloadingJwks(path, { reloadSeconds: 0, logger: () => {} });
  writeFileSync(path, JSON.stringify({ keys: [] })); // jwksFromDocument rejects empty → retain
  src.reload();
  assert.deepEqual(Object.keys(src.current()), ["task-2026-07"]);
  src.stop();
});

test("the reload timer can be stopped (no leak) and fires on the interval", async () => {
  const path = jwksFile([KEY_JUL]);
  const src = new ReloadingJwks(path, { reloadSeconds: 0.01 }); // 10ms cadence
  writeFileSync(path, JSON.stringify({ keys: [KEY_JUL, KEY_AUG] }));
  await new Promise((r) => setTimeout(r, 30)); // let the timer fire at least once
  assert.equal(Object.keys(src.current()).length, 2, "interval reload picked up the new kid");
  src.stop();
  // After stop the file can change with no further effect.
  writeFileSync(path, JSON.stringify({ keys: [KEY_JUL] }));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(Object.keys(src.current()).length, 2, "no reload after stop() — timer did not leak");
});

test("a bad JWKS at construction still throws (fail-closed boot)", () => {
  const path = jwksFile([]);
  assert.throws(() => new ReloadingJwks(path, { reloadSeconds: 0 }));
});
