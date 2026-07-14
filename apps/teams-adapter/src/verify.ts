// Bot Framework JWT validation (instructions.md §7.1).
//
// Each Teams activity carries a Bot Framework-signed JWT. The adapter validates it
// fail-closed: signature (RS256 via the connector's OpenID JWKS — injected here as
// a key lookup), issuer, audience (= the bot's App ID), and a 5-minute clock skew.
// This module does the CLAIM checks + skew; the JWKS fetch/RS256 verify is provided
// by the shared JWT layer in prod (auth-service / packages/shared-ts).

export interface BotFrameworkClaims {
  iss: string;
  aud: string; // must equal the bot App ID
  exp: number; // seconds
  nbf?: number;
  serviceUrl?: string;
}

export interface ValidateOpts {
  botAppId: string;
  now?: number; // seconds
  skew?: number; // seconds, default 300 (5 min, §7.1)
  // Trusted Bot Framework issuers (metadata-derived in prod).
  trustedIssuers?: string[];
}

export type ValidateResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "not_yet_valid" | "bad_audience" | "bad_issuer" };

const DEFAULT_ISSUERS = [
  "https://api.botframework.com",
  "https://login.botframework.com/v1/.well-known/openidconfiguration",
];

// Validate the standard Bot Framework claims (§7.1). Fail-closed on any mismatch.
export function validateClaims(claims: BotFrameworkClaims, opts: ValidateOpts): ValidateResult {
  const now = opts.now ?? Math.floor(Date.now() / 1000);
  const skew = opts.skew ?? 300;
  const issuers = opts.trustedIssuers ?? DEFAULT_ISSUERS;

  if (now > claims.exp + skew) return { ok: false, reason: "expired" };
  if (claims.nbf !== undefined && now + skew < claims.nbf) return { ok: false, reason: "not_yet_valid" };
  if (claims.aud !== opts.botAppId) return { ok: false, reason: "bad_audience" };
  if (!issuers.includes(claims.iss)) return { ok: false, reason: "bad_issuer" };
  return { ok: true };
}
