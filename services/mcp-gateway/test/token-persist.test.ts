// Connector-token DURABILITY tests (§13.2): the resolver persists each sealed token through a
// TokenStore (backend-core /internal/oauth-tokens) and REHYDRATES from it on boot, so a gateway
// restart no longer wipes connections. Exercised keylessly against a tiny mock backend-core HTTP
// server. The encryption boundary is proven: only the SEALED blob crosses the seam — the mock
// backend never sees plaintext. Run: node --test test/token-persist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import {
  BackendCoreTokenStore,
  CredentialResolver,
  InMemoryVault,
  seal,
  type SealedToken,
} from "../src/vault.ts";

const SERVICE_TOKEN = "dev-internal-service-token";

// A stand-in for backend-core's /internal/oauth-tokens: an in-memory row list, gated on the same
// X-Service-Token header the real service requires. Records every POST for assertions.
type Row = { user_id: string; provider: string; org_id: string | null; sealed_token: string;
  scopes: string[] | null; expires_at: string | null };
function mockBackendCore() {
  const rows: Row[] = [];
  const posts: any[] = [];
  const server: Server = createServer((req, res) => {
    if (req.headers["x-service-token"] !== SERVICE_TOKEN) {
      res.writeHead(403); return res.end();
    }
    if (req.method === "POST" && req.url === "/internal/oauth-tokens") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        const body = JSON.parse(raw);
        posts.push(body);
        // upsert on (user_id, provider)
        const i = rows.findIndex((r) => r.user_id === body.user_id && r.provider === body.provider);
        const row: Row = {
          user_id: body.user_id, provider: body.provider, org_id: body.org_id ?? null,
          sealed_token: body.sealed_token, scopes: body.scopes ?? null, expires_at: body.expires_at ?? null,
        };
        if (i >= 0) rows[i] = row; else rows.push(row);
        res.writeHead(204); res.end();
      });
      return;
    }
    if (req.method === "GET" && req.url === "/internal/oauth-tokens") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ tokens: rows }));
    }
    res.writeHead(404); res.end();
  });
  return { server, rows, posts };
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

test("store() persists the sealed token to backend-core (asserts the POST, ciphertext only)", async () => {
  const mock = mockBackendCore();
  const baseUrl = await listen(mock.server);
  try {
    const key = randomBytes(32);
    const vault = new InMemoryVault(key);
    const store = new BackendCoreTokenStore(baseUrl, SERVICE_TOKEN);
    const resolver = new CredentialResolver(vault, undefined, store);

    resolver.store("usr_dev", "github", "ghp_realsecrettoken");
    await resolver.settled(); // best-effort persist is async — wait for it

    assert.equal(mock.posts.length, 1, "expected exactly one persist POST");
    const posted = mock.posts[0];
    assert.equal(posted.user_id, "usr_dev");
    assert.equal(posted.provider, "github");
    // Encryption boundary: the wire payload is base64(JSON(SealedToken)) — never the plaintext.
    const decoded = Buffer.from(posted.sealed_token, "base64").toString("utf8");
    assert.doesNotMatch(decoded, /ghp_realsecrettoken/, "plaintext must never cross to backend-core");
    const sealed = JSON.parse(decoded) as SealedToken;
    assert.ok(sealed.iv && sealed.tag && sealed.ct, "sealed blob must carry iv/tag/ct");
  } finally {
    mock.server.close();
  }
});

test("rehydrate on boot: a seeded backend-core row is loaded back and resolve() returns the token", async () => {
  const mock = mockBackendCore();
  const baseUrl = await listen(mock.server);
  try {
    // Seed the mock as if a PRIOR gateway instance had persisted usr_dev's github token, sealed
    // under a known key. A FRESH resolver over a vault with that SAME key must rehydrate it.
    const key = randomBytes(32);
    const sealed = seal("ghp_survivestherestart", key);
    mock.rows.push({
      user_id: "usr_dev", provider: "github", org_id: "org_dev",
      sealed_token: Buffer.from(JSON.stringify(sealed), "utf8").toString("base64"),
      scopes: ["repo"], expires_at: null,
    });

    const vault = new InMemoryVault(key);
    const store = new BackendCoreTokenStore(baseUrl, SERVICE_TOKEN);
    const resolver = new CredentialResolver(vault, undefined, store);

    // Before load: no in-memory token → the connection is "lost".
    assert.deepEqual(resolver.providers("usr_dev"), []);

    const { loaded, skipped } = await resolver.load();
    assert.equal(loaded, 1);
    assert.equal(skipped, 0);

    // After rehydrate: the connection is back and the credential resolves to the real token.
    assert.deepEqual(resolver.providers("usr_dev"), ["github"]);
    assert.equal(resolver.resolve("usr_dev", "github.create_pr"), "ghp_survivestherestart");
  } finally {
    mock.server.close();
  }
});

test("rehydrate skips a token sealed under a DIFFERENT key (rotation), never poisoning the map", async () => {
  const mock = mockBackendCore();
  const baseUrl = await listen(mock.server);
  try {
    // Row sealed under a foreign key; the resolver's vault uses a different one → open() fails.
    const foreign = seal("ghp_unreadable", randomBytes(32));
    mock.rows.push({
      user_id: "usr_dev", provider: "github", org_id: null,
      sealed_token: Buffer.from(JSON.stringify(foreign), "utf8").toString("base64"),
      scopes: null, expires_at: null,
    });
    const resolver = new CredentialResolver(new InMemoryVault(randomBytes(32)), undefined,
      new BackendCoreTokenStore(baseUrl, SERVICE_TOKEN));
    const { loaded, skipped } = await resolver.load();
    assert.equal(loaded, 0);
    assert.equal(skipped, 1);
    assert.deepEqual(resolver.providers("usr_dev"), [], "an undecryptable row must not be trusted");
  } finally {
    mock.server.close();
  }
});

test("no TokenStore configured: store() stays pure in-memory (offline path unchanged)", async () => {
  const resolver = new CredentialResolver(new InMemoryVault());
  resolver.store("usr_dev", "github", "ghp_local");
  await resolver.settled();
  assert.equal(resolver.resolve("usr_dev", "github.search"), "ghp_local");
  assert.deepEqual(await resolver.load(), { loaded: 0, skipped: 0 });
});
