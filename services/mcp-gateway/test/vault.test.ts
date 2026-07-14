// AX-037 (Vault/AES-GCM) + AX-036 (DLP file scan) tests. Run: node --test test/vault.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  CredentialMissing,
  CredentialResolver,
  InMemoryVault,
  open,
  seal,
} from "../src/vault.ts";
import { McpGateway } from "../src/gateway.ts";
import { sign } from "../../../packages/shared-ts/src/jwt.ts";
import { guardMemoryWrite, scanFile } from "../src/dlp.ts";

const SECRET = "dev-task-jwt-secret";

// ---------------------------------------------------------------- AES-256-GCM (§16.1)
test("seal/open round-trips a token", () => {
  const key = randomBytes(32);
  const sealed = seal("ghp_secrettoken", key);
  assert.equal(open(sealed, key), "ghp_secrettoken");
});

test("tampered ciphertext fails to decrypt (GCM auth)", () => {
  const key = randomBytes(32);
  const sealed = seal("token", key);
  sealed.ct = sealed.ct.slice(0, -2) + "00"; // flip last byte
  assert.throws(() => open(sealed, key));
});

test("wrong key fails to decrypt", () => {
  const sealed = seal("token", randomBytes(32));
  assert.throws(() => open(sealed, randomBytes(32)));
});

test("non-32-byte key is rejected", () => {
  assert.throws(() => seal("x", randomBytes(16)));
});

// ---------------------------------------------------------------- resolver (§13.2)
test("resolver stores sealed and resolves the plaintext credential", () => {
  const vault = new InMemoryVault();
  const r = new CredentialResolver(vault);
  r.store("usr_1", "github", "ghp_abc");
  // stored value is sealed, not plaintext
  const stored = vault.getToken("usr_1", "github")!;
  assert.notEqual(stored.ct, Buffer.from("ghp_abc").toString("hex"));
  // resolver decrypts at call time
  assert.equal(r.resolve("usr_1", "github.create_pr"), "ghp_abc");
});

test("resolver throws CredentialMissing when no token stored", () => {
  const r = new CredentialResolver(new InMemoryVault());
  assert.throws(() => r.resolve("usr_1", "github.search"), CredentialMissing);
});

test("Mode B resolves the ORG service credential, not a personal one (§3.1)", () => {
  const r = new CredentialResolver(new InMemoryVault());
  r.storeOrg("org_1", "github", "ghs_orgInstallToken"); // GitHub App installation token
  // requester has NO personal token, but the org credential resolves in Mode B
  assert.equal(r.resolve("agent-org@org_1", "github.create_pr", "org_1"), "ghs_orgInstallToken");
  // without orgId (Mode A) the same subject has no personal token → missing
  assert.throws(() => r.resolve("agent-org@org_1", "github.create_pr"), CredentialMissing);
});

// ---------------------------------------------------------------- gateway integration
function jwt(allowed: string[]) {
  return sign({ sub: "usr_1", org_id: "org_1", iat: 1000, exp: 2000, allowed_tools: allowed, approval_tools: [] }, SECRET);
}

test("gateway injects the real decrypted credential into the tool handler", async () => {
  const vault = new InMemoryVault();
  const resolver = new CredentialResolver(vault);
  resolver.store("usr_1", "github", "ghp_realtoken");
  const gw = new McpGateway(SECRET, { now: 1500 }, (u, t) => resolver.resolve(u, t));
  let seenCredential = "";
  gw.register("github.search", async (_a, ctx) => {
    seenCredential = ctx.credential;
    return "ok";
  });
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: jwt(["github.search"]) });
  assert.equal(r.status, "ok");
  assert.equal(seenCredential, "ghp_realtoken"); // handler got the decrypted token
});

test("gateway returns E_CONN_NEEDS_CONNECTION when no credential stored", async () => {
  const resolver = new CredentialResolver(new InMemoryVault());
  const gw = new McpGateway(SECRET, { now: 1500 }, (u, t) => resolver.resolve(u, t));
  gw.register("github.search", async () => "ok");
  const r = await gw.call({ tool: "github.search", args: {}, taskJwt: jwt(["github.search"]) });
  assert.equal(r.code, "E_CONN_NEEDS_CONNECTION");
});

// ---------------------------------------------------------------- DLP file scan (AX-036, §9.3)
test("scanFile reports secrets by line", () => {
  const content = "line1 ok\nAKIA" + "A".repeat(16) + "\nline3 ok\nghp_" + "b".repeat(36);
  const findings = scanFile(content);
  assert.ok(findings.some((f) => f.category === "aws_access_key" && f.line === 2));
  assert.ok(findings.some((f) => f.category === "github_token" && f.line === 4));
});

test("clean file yields no findings", () => {
  assert.deepEqual(scanFile("const x = 1;\nexport default x;"), []);
});

test("guardMemoryWrite scrubs secrets from agent memory writes (§9.1.3)", () => {
  const r = guardMemoryWrite("remember the token ghp_" + "c".repeat(36));
  assert.equal(r.clean, false);
  assert.match(r.content, /REDACTED:github_token/);
  assert.ok(r.redacted.includes("github_token"));
});
