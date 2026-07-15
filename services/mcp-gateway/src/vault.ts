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

// The resolver the gateway calls. Decrypts the credential at call time; returns a
// sentinel string the sandbox never sees (the gateway passes it to the MCP server
// and it stays server-side). Throws E_CONN_NEEDS_CONNECTION if no token stored.
export class CredentialResolver {
  private vault: SecretBackend;
  private kms: KmsProvider;
  private wrappedDataKey: WrappedKey;
  // The KmsProvider defaults to LocalKmsProvider → the data key is the vault's key, wrapped and
  // unwrapped in-process, so the at-rest SealedToken format is BYTE-IDENTICAL to before (credentials
  // are still sealed with that same 32-byte data key). Inject a real KMS to move the KEK off-box.
  constructor(vault: SecretBackend, kms: KmsProvider = new LocalKmsProvider()) {
    this.vault = vault;
    this.kms = kms;
    // Envelope the data key once; hold only the WRAPPED form, unwrap at use time.
    this.wrappedDataKey = kms.wrap(vault.getEncryptionKey());
  }

  /** Unwrap the data key via the KMS at use time (never held in plaintext at rest here). */
  private dataKey(): Buffer {
    return this.kms.unwrap(this.wrappedDataKey);
  }

  /** Store a user's OAuth token, sealed. Called by the OAuth callback (AX-038). */
  store(userId: string, provider: string, token: string): void {
    this.vault.putToken(userId, provider, seal(token, this.dataKey()));
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
