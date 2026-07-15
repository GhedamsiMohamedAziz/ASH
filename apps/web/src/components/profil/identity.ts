// Pure view-model helpers for the Profil page (§2.6/§4.4). No React, no fetch — same split as
// src/pages.ts (Mémoires/Automatisations) so this stays trivially testable.
//
// `decodeSessionClaims` mirrors auth.ts's `currentUser()` (same base64url decode, same "display
// only, never trust for authz" caveat) but also reads `role`, which /api/v1/whoami deliberately
// does NOT return (services/backend-core/app/main.py `whoami()` only echoes user_id/org_id). The
// role claim IS present in the real minted JWT (services/auth-service/app/service.py `mint()`),
// so this is real backend data — just read locally instead of round-tripped through an endpoint,
// exactly like the "logged in as" chip in LoginControl already does for sub/org.
export interface SessionClaims {
  sub: string;
  org_id: string;
  role?: string;
}

export function decodeSessionClaims(token: string | null): SessionClaims | null {
  if (!token) return null;
  try {
    const payload = token.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (!json.sub || !json.org_id) return null;
    return { sub: json.sub, org_id: json.org_id, role: typeof json.role === "string" ? json.role : undefined };
  } catch {
    return null;
  }
}

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrateur",
  power_user: "Power user",
  member: "Membre",
};

export function roleLabel(role?: string | null): string {
  if (!role) return "—";
  return ROLE_LABEL[role] ?? role;
}

// The three `identities` providers (db/migrations/0001_init.sql, §16.1): entra|slack|web.
export type ChannelProvider = "web" | "slack" | "entra";

export interface ChannelRow {
  provider: ChannelProvider;
  label: string;
  linked: boolean;
}

// Real state, honestly reflected: the CURRENT session is always the `web` identity binding for
// this user (that's what got you this page) — no linking flow needed, it already exists. Slack
// and Teams (entra) linking has no reachable HTTP route yet (auth-service's linking.py exists but
// main.py never wires it) so they are always "non lié" today. Never fabricate a linked state.
export function channelRows(): ChannelRow[] {
  return [
    { provider: "web", label: "Web", linked: true },
    { provider: "slack", label: "Slack", linked: false },
    { provider: "entra", label: "Microsoft Teams (Entra ID)", linked: false },
  ];
}

// Exact-match confirmation for the RGPD danger zone (type-to-confirm). Trimmed, case-sensitive —
// the phrase shown to the user IS the exact string expected back.
export function isConfirmMatch(input: string, expected: string): boolean {
  return expected.length > 0 && input.trim() === expected;
}
