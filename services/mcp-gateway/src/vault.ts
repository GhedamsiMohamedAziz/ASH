// Credential store + injection (instructions.md §13.2, §16.1, ADR 001).
//
// Zero secrets in the sandbox: OAuth tokens live encrypted (AES-256-GCM with a
// Vault-held key) and are decrypted ONLY here, at the moment the gateway makes a
// tool call, then handed to the MCP server — never returned toward the sandbox.
// Prod backs the key + secret storage with HashiCorp Vault; this module defines
// the interface and an in-memory implementation for dev/tests.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

export interface SealedToken {
  iv: string; // hex
  tag: string; // hex (GCM auth tag)
  ct: string; // hex ciphertext
}

// AES-256-GCM: authenticated encryption. A tampered ciphertext/tag fails to
// decrypt (throws) rather than yielding garbage — matches the BYTEA at-rest
// storage of oauth_tokens (§16.1).
export function seal(plaintext: string, key: Buffer): SealedToken {
  if (key.length !== 32) throw new Error("key must be 32 bytes (AES-256)");
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ct: ct.toString("hex") };
}

export function open(sealed: SealedToken, key: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, Buffer.from(sealed.iv, "hex"));
  decipher.setAuthTag(Buffer.from(sealed.tag, "hex"));
  const pt = Buffer.concat([decipher.update(Buffer.from(sealed.ct, "hex")), decipher.final()]);
  return pt.toString("utf8");
}

// Secret backend: Vault in prod, in-memory in dev. Holds the encryption key and
// the sealed per-(user, provider) tokens.
export interface SecretBackend {
  getEncryptionKey(): Buffer;
  putToken(userId: string, provider: string, sealed: SealedToken): void;
  getToken(userId: string, provider: string): SealedToken | undefined;
  /** Enumerate the providers a holder has a stored token for (for /v1/connections). */
  listProviders(holder: string): string[];
}

export class InMemoryVault implements SecretBackend {
  private key: Buffer;
  private tokens = new Map<string, SealedToken>();
  constructor(key?: Buffer) {
    this.key = key ?? randomBytes(32);
  }
  getEncryptionKey(): Buffer {
    return this.key;
  }
  putToken(userId: string, provider: string, sealed: SealedToken): void {
    this.tokens.set(`${userId}:${provider}`, sealed);
  }
  getToken(userId: string, provider: string): SealedToken | undefined {
    return this.tokens.get(`${userId}:${provider}`);
  }
  listProviders(holder: string): string[] {
    const prefix = `${holder}:`;
    const out: string[] = [];
    for (const key of this.tokens.keys()) {
      if (key.startsWith(prefix)) out.push(key.slice(prefix.length));
    }
    return out;
  }
}

// Map a tool name to the OAuth provider it needs (github.* → github, etc.).
export function providerForTool(tool: string): string {
  return tool.split(".")[0];
}

// ------------------------------------------------------------------ KMS envelope seam (ADR-019)
// Envelope encryption: the DATA KEY that seals credentials (AES-256-GCM above) is itself encrypted
// ("wrapped") by a Key-Encryption-Key (KEK) held by a KMS, and only unwrapped in-process at use
// time. Same seam shape as BillingProvider (StubBilling vs real PSP) and the LLM/GitHub edges: a
// keyless offline default (LocalKmsProvider) that keeps dev/tests unchanged, with a real cloud KMS
// dropping in behind the identical interface — only the real one moves the KEK off-box.
export type WrappedKey = SealedToken; // opaque envelope of the data key (LocalKms: AES-256-GCM blob)

export interface KmsProvider {
  /** Encrypt a 32-byte data key under the KEK → an opaque wrapped blob stored/held at rest. */
  wrap(dataKey: Buffer): WrappedKey;
  /** Decrypt a wrapped blob back to the 32-byte data key. Wrong KEK / tamper → throws (fail-closed). */
  unwrap(wrapped: WrappedKey): Buffer;
}

// Default provider: the current in-process behavior. A local KEK (random by default, or injected)
// wraps/unwraps the data key with the same AES-256-GCM primitive — no external calls, no key
// material off-box, so dev stays keyless/offline. A real KMS plugs in HERE: implement KmsProvider
// with e.g. AWS KMS Encrypt/Decrypt or GCP KMS encrypt/decrypt of the data key (the KEK never
// leaves the KMS), then inject it via `new CredentialResolver(vault, new AwsKmsProvider(keyArn))`.
export class LocalKmsProvider implements KmsProvider {
  private kek: Buffer;
  constructor(kek?: Buffer) {
    if (kek && kek.length !== 32) throw new Error("KEK must be 32 bytes (AES-256)");
    this.kek = kek ?? randomBytes(32);
  }
  wrap(dataKey: Buffer): WrappedKey {
    if (dataKey.length !== 32) throw new Error("data key must be 32 bytes (AES-256)");
    return seal(dataKey.toString("hex"), this.kek);
  }
  unwrap(wrapped: WrappedKey): Buffer {
    return Buffer.from(open(wrapped, this.kek), "hex");
  }
}

// ------------------------------------------------------------------ durable token store (§13.2)
// Connector OAuth tokens must SURVIVE a gateway restart. The in-memory vault above is volatile, so
// the resolver ALSO persists each sealed token through a TokenStore (backend-core's service-gated
// /internal/oauth-tokens) and rehydrates from it on boot. The encryption boundary is strict: only
// the CIPHERTEXT (SealedToken) crosses this seam — the gateway keeps the AES key, backend-core
// stores/returns only sealed bytes. Default undefined → pure in-memory, so offline tests are keyless.
export interface PersistedToken {
  userId: string;
  provider: string;
  sealed: SealedToken; // the AES-256-GCM ciphertext blob — never plaintext
  orgId?: string | null;
  scopes?: string[] | null;
  expiresAt?: string | null;
}

export interface TokenStore {
  /** Durably persist one sealed token. Best-effort at the call site (log + continue on throw). */
  save(token: PersistedToken): Promise<void>;
  /** Load every persisted sealed token so the resolver can rehydrate its in-memory map on boot. */
  loadAll(): Promise<PersistedToken[]>;
}

// backend-core-backed TokenStore: POST/GET /internal/oauth-tokens with X-Service-Token — the SAME
// internal surface (§3.2) the Scheduler persists crons through, never the public gateway. The
// sealed blob travels as base64(JSON(SealedToken)); backend-core stores the decoded bytes as the
// access_token BYTEA and hands them straight back, so it only ever sees ciphertext.
export class BackendCoreTokenStore implements TokenStore {
  private baseUrl: string;
  private serviceToken: string;
  constructor(baseUrl: string, serviceToken: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.serviceToken = serviceToken;
  }
  private static encode(sealed: SealedToken): string {
    return Buffer.from(JSON.stringify(sealed), "utf8").toString("base64");
  }
  private static decode(b64: string): SealedToken {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as SealedToken;
  }
  async save(t: PersistedToken): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/oauth-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", "X-Service-Token": this.serviceToken },
      body: JSON.stringify({
        user_id: t.userId, provider: t.provider,
        sealed_token: BackendCoreTokenStore.encode(t.sealed),
        org_id: t.orgId ?? null, scopes: t.scopes ?? null, expires_at: t.expiresAt ?? null,
      }),
    });
    if (!res.ok) throw new Error(`oauth-token persist failed: HTTP ${res.status}`);
  }
  async loadAll(): Promise<PersistedToken[]> {
    const res = await fetch(`${this.baseUrl}/internal/oauth-tokens`, {
      headers: { "X-Service-Token": this.serviceToken },
    });
    if (!res.ok) throw new Error(`oauth-token load failed: HTTP ${res.status}`);
    const body = (await res.json()) as { tokens?: Array<Record<string, any>> };
    return (body.tokens ?? []).map((r) => ({
      userId: r.user_id, provider: r.provider, orgId: r.org_id,
      scopes: r.scopes ?? null, expiresAt: r.expires_at ?? null,
      sealed: BackendCoreTokenStore.decode(r.sealed_token),
    }));
  }
}

// The resolver the gateway calls. Decrypts the credential at call time; returns a
// sentinel string the sandbox never sees (the gateway passes it to the MCP server
// and it stays server-side). Throws E_CONN_NEEDS_CONNECTION if no token stored.
export class CredentialResolver {
  private vault: SecretBackend;
  private kms: KmsProvider;
  private wrappedDataKey: WrappedKey;
  private tokenStore?: TokenStore;
  private lastPersist: Promise<void> = Promise.resolve();
  // The KmsProvider defaults to LocalKmsProvider → the data key is the vault's key, wrapped and
  // unwrapped in-process, so the at-rest SealedToken format is BYTE-IDENTICAL to before (credentials
  // are still sealed with that same 32-byte data key). Inject a real KMS to move the KEK off-box.
  // Inject a TokenStore to make connections DURABLE across restarts (default undefined → volatile).
  constructor(vault: SecretBackend, kms: KmsProvider = new LocalKmsProvider(), tokenStore?: TokenStore) {
    this.vault = vault;
    this.kms = kms;
    this.tokenStore = tokenStore;
    // Envelope the data key once; hold only the WRAPPED form, unwrap at use time.
    this.wrappedDataKey = kms.wrap(vault.getEncryptionKey());
  }

  /** Unwrap the data key via the KMS at use time (never held in plaintext at rest here). */
  private dataKey(): Buffer {
    return this.kms.unwrap(this.wrappedDataKey);
  }

  /** Store a user's OAuth token, sealed. Called by the OAuth callback (AX-038). Also DURABLY
   * persists the sealed blob (best-effort) when a TokenStore is configured, so the connection
   * survives a gateway restart — a persist failure logs and continues, never breaking connect. */
  store(userId: string, provider: string, token: string): void {
    const sealed = seal(token, this.dataKey());
    this.vault.putToken(userId, provider, sealed);
    if (this.tokenStore) {
      this.lastPersist = this.tokenStore.save({ userId, provider, sealed }).catch((err) => {
        console.error(`[vault] token persist failed for ${userId}/${provider}: ${err?.message ?? err}`);
      });
    }
  }

  /** Await the most recent best-effort persist (tests / graceful shutdown). */
  async settled(): Promise<void> {
    await this.lastPersist;
  }

  /** Rehydrate the in-memory vault from the TokenStore on boot (§13.2): load every persisted sealed
   * blob and re-insert it, so connections survive a restart. Each blob is tag-verified with the
   * gateway key first; any that fail to open (e.g. the key was rotated) are skipped + logged rather
   * than poisoning the map. No-op (0/0) when no TokenStore is configured — offline path unchanged. */
  async load(): Promise<{ loaded: number; skipped: number }> {
    if (!this.tokenStore) return { loaded: 0, skipped: 0 };
    let rows: PersistedToken[];
    try {
      rows = await this.tokenStore.loadAll();
    } catch (err: any) {
      console.error(`[vault] rehydrate load failed: ${err?.message ?? err}`);
      return { loaded: 0, skipped: 0 };
    }
    let loaded = 0;
    let skipped = 0;
    for (const r of rows) {
      try {
        open(r.sealed, this.dataKey()); // verify the tag decrypts with OUR key before trusting it
        this.vault.putToken(r.userId, r.provider, r.sealed);
        loaded++;
      } catch {
        console.error(`[vault] skipping undecryptable token ${r.userId}/${r.provider} (key rotated?)`);
        skipped++;
      }
    }
    return { loaded, skipped };
  }

  /** Store an ORG service credential (Mode B, §3.1): one entry per org+connector,
   * keyed as `org:<orgId>`, e.g. a GitHub App installation token. */
  storeOrg(orgId: string, provider: string, token: string): void {
    this.vault.putToken(`org:${orgId}`, provider, seal(token, this.dataKey()));
  }

  /** Resolve + decrypt the credential for a tool call (§13.2).
   * Mode A: the requester's personal token. Mode B: the org service credential —
   * the requester's identity still drives authz/audit, but the CREDENTIAL is the
   * org's (§3.2). `orgId` set → Mode B. */
  resolve(subject: string, tool: string, orgId?: string): string {
    const provider = providerForTool(tool);
    const holder = orgId ? `org:${orgId}` : subject;
    const sealed = this.vault.getToken(holder, provider);
    if (!sealed) throw new CredentialMissing(provider);
    return open(sealed, this.dataKey());
  }

  /** List the providers a holder is connected to. `orgId` set → the org's service
   * credentials (Mode B); else the requester's personal tokens (Mode A). Used by
   * GET /v1/connections to report what a user (and their org) can already reach. */
  providers(subject: string, orgId?: string): string[] {
    const holder = orgId ? `org:${orgId}` : subject;
    return this.vault.listProviders(holder);
  }
}

export class CredentialMissing extends Error {
  code = "E_CONN_NEEDS_CONNECTION";
  provider: string;
  constructor(provider: string) {
    super(`no connection for ${provider}`);
    this.provider = provider;
  }
}
