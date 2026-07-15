// Dependency-free HS256 JWT sign/verify (instructions.md §13.4).
// Wire-compatible with packages/shared-py/olma_shared/jwt.py. Fail-closed:
// any signature/claim problem throws JWTError, never returns partial data.
//
// HS256 is the dev default (shared secret). ES256 verification is added below as a
// config-gated seam (ADR-012, §13.4): the gateway loads a JWKS of P-256 public keys
// and selects the key by the token's `kid` header — HS256 stays byte-identical and
// remains the default, ES256 is opt-in via TASK_JWT_ALG=ES256. Both use only Node's
// built-in `node:crypto` (no new dependency).
import { createHmac, timingSafeEqual, createPublicKey, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";

export class JWTError extends Error {}
export class InvalidSignature extends JWTError {}
export class ExpiredToken extends JWTError {}
export class InvalidClaim extends JWTError {}
export class UnknownKey extends JWTError {}

const b64uEncode = (buf: Buffer): string =>
  buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

const b64uDecode = (s: string): Buffer =>
  Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

const hmac = (input: string, secret: string): Buffer =>
  createHmac("sha256", secret).update(input).digest();

export function sign(payload: Record<string, unknown>, secret: string): string {
  const seg = [
    b64uEncode(Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" }))),
    b64uEncode(Buffer.from(JSON.stringify(payload))),
  ];
  seg.push(b64uEncode(hmac(seg.join("."), secret)));
  return seg.join(".");
}

export interface VerifyOpts {
  iss?: string;
  aud?: string;
  leeway?: number;
  now?: number; // seconds
  requireExp?: boolean; // fail closed if the token carries no expiry (short-lived TASK tokens)
}

export function verify(token: string, secret: string, opts: VerifyOpts = {}): Record<string, any> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JWTError("malformed token");
  const [h, p, s] = parts;

  let header: any, claims: any, givenSig: Buffer;
  try {
    header = JSON.parse(b64uDecode(h).toString());
    claims = JSON.parse(b64uDecode(p).toString());
    givenSig = b64uDecode(s);
  } catch {
    throw new JWTError("undecodable token");
  }

  if (header.alg !== "HS256") throw new JWTError(`unexpected alg: ${header.alg}`); // no 'none' bypass

  const expected = hmac(`${h}.${p}`, secret);
  if (expected.length !== givenSig.length || !timingSafeEqual(expected, givenSig))
    throw new InvalidSignature("signature mismatch");

  const leeway = opts.leeway ?? 0;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (opts.requireExp && claims.exp === undefined)
    throw new InvalidClaim("exp required"); // a token with no lifetime never expires — fail closed
  if (claims.exp !== undefined && now > Number(claims.exp) + leeway)
    throw new ExpiredToken("token expired");
  if (claims.nbf !== undefined && now + leeway < Number(claims.nbf))
    throw new InvalidClaim("token not yet valid");
  if (opts.iss !== undefined && claims.iss !== opts.iss) throw new InvalidClaim("issuer mismatch");
  if (opts.aud !== undefined && claims.aud !== opts.aud) throw new InvalidClaim("audience mismatch");
  return claims;
}

// ------------------------------------------------------------------ ES256 (P-256)
// A JWKS is a `kid` -> P-256 public KeyObject map (the rotation model of §13.4: 2 active
// keys, current + next). The TS gateway VERIFIES ES256 TASK JWTs; prompt-layer (Python)
// mints them. JOSE ES256 signatures are raw R||S (IEEE P1363, 64 bytes), which Node's
// `crypto.verify` consumes via `dsaEncoding: "ieee-p1363"`.
export type Jwks = Record<string, KeyObject>;

interface Jwk {
  kty?: string;
  crv?: string;
  kid?: string;
  x?: string;
  y?: string;
  alg?: string;
}

// Build a `kid` -> KeyObject map from a parsed JWKS document ({ keys: [...] }). Only
// EC P-256 signing keys are accepted; anything else is rejected (fail-closed, no silent
// skips that could leave a kid resolvable to nothing).
export function jwksFromDocument(doc: { keys?: Jwk[] }): Jwks {
  const keys = doc?.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new JWTError("empty or malformed JWKS");
  const out: Jwks = {};
  for (const jwk of keys) {
    if (jwk.kty !== "EC" || jwk.crv !== "P-256")
      throw new JWTError(`unsupported JWK (expected EC/P-256): kty=${jwk.kty} crv=${jwk.crv}`);
    if (!jwk.kid || !jwk.x || !jwk.y) throw new JWTError("JWK missing kid/x/y");
    out[jwk.kid] = createPublicKey({ key: jwk as Record<string, unknown>, format: "jwk" });
  }
  return out;
}

// Load a JWKS from a file path (env TASK_JWT_JWKS_PATH). Mirrors how the auth-service
// exposes its RS256 JWKS; here the gateway reads a static/rotated JWKS of the TASK
// signing keys.
export function loadJwks(path: string): Jwks {
  return jwksFromDocument(JSON.parse(readFileSync(path, "utf8")));
}

// Verify an ES256 TASK JWT against the active JWKS. Same claim checks and fail-closed
// posture as the HS256 `verify` above; selection is by the token's `kid` header. Never
// accepts `alg:none`, an unexpected alg, or an unknown `kid` — and never falls back to
// HS256 (the caller chose ES256 mode).
export function verifyES256(token: string, jwks: Jwks, opts: VerifyOpts = {}): Record<string, any> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new JWTError("malformed token");
  const [h, p, s] = parts;

  let header: any, claims: any, givenSig: Buffer;
  try {
    header = JSON.parse(b64uDecode(h).toString());
    claims = JSON.parse(b64uDecode(p).toString());
    givenSig = b64uDecode(s);
  } catch {
    throw new JWTError("undecodable token");
  }

  if (header.alg !== "ES256") throw new JWTError(`unexpected alg: ${header.alg}`); // no 'none' bypass
  const kid = header.kid;
  // own-property check only: `in` would let inherited props (toString/constructor/__proto__) satisfy the guard
  if (!kid || !Object.prototype.hasOwnProperty.call(jwks, kid)) throw new UnknownKey(`unknown kid: ${kid}`); // fail closed, no fallback

  // JOSE ES256 = ECDSA P-256 over SHA-256, signature as raw R||S (IEEE P1363).
  const ok = cryptoVerify("sha256", Buffer.from(`${h}.${p}`), { key: jwks[kid], dsaEncoding: "ieee-p1363" }, givenSig);
  if (!ok) throw new InvalidSignature("signature mismatch");

  const leeway = opts.leeway ?? 0;
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  if (opts.requireExp && claims.exp === undefined)
    throw new InvalidClaim("exp required"); // a token with no lifetime never expires — fail closed
  if (claims.exp !== undefined && now > Number(claims.exp) + leeway)
    throw new ExpiredToken("token expired");
  if (claims.nbf !== undefined && now + leeway < Number(claims.nbf))
    throw new InvalidClaim("token not yet valid");
  if (opts.iss !== undefined && claims.iss !== opts.iss) throw new InvalidClaim("issuer mismatch");
  if (opts.aud !== undefined && claims.aud !== opts.aud) throw new InvalidClaim("audience mismatch");
  return claims;
}
