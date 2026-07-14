// Dependency-free HS256 JWT sign/verify (instructions.md §13.4).
// Wire-compatible with packages/shared-py/olma_shared/jwt.py. Fail-closed:
// any signature/claim problem throws JWTError, never returns partial data.
import { createHmac, timingSafeEqual } from "node:crypto";

export class JWTError extends Error {}
export class InvalidSignature extends JWTError {}
export class ExpiredToken extends JWTError {}
export class InvalidClaim extends JWTError {}

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
