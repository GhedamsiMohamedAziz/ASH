// Optional bearer identity (Lane 4). The web ships with NO login: absence of a token MUST behave
// exactly as before — backend-core falls back to its DEV_USER/org_1 identity. When a token is
// present in localStorage under `olma_token`, we attach it as `Authorization: Bearer <token>` so
// backend-core can resolve the real user/org from an auth-service RS256 token. Purely additive.
const TOKEN_KEY = "olma_token";

export function authToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // localStorage can throw (private mode / SSR) — behave as if no token.
  }
}

// Merge the bearer header into an existing header bag, only when a token is present. Returns the
// base bag untouched when there is no token, so callers keep their exact pre-token behaviour.
export function authHeaders(base: Record<string, string> = {}): Record<string, string> {
  const t = authToken();
  return t ? { ...base, Authorization: `Bearer ${t}` } : base;
}

export function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    // localStorage can throw (private mode / SSR) — nothing to persist, identity stays dev-default.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // no-op — see setToken().
  }
}

// Display-only decode of the current token's claims, e.g. for a "logged in as" chip. NEVER trust
// this for authorization — it does not verify the signature. Returns null on no token or any
// decode failure so callers can just render nothing.
export function currentUser(): { sub: string; org: string } | null {
  const t = authToken();
  if (!t) return null;
  try {
    const payload = t.split(".")[1];
    const json = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
    if (!json.sub || !json.org_id) return null;
    return { sub: json.sub, org: json.org_id };
  } catch {
    return null;
  }
}

// Dev login (§7.1): POST the claimed identity to backend-core, which proxies auth-service's
// dev-login and returns a real RS256 token. On success the token is persisted so authHeaders()
// starts attaching it; throws on any non-2xx so callers can surface an inline error.
export async function login(sub: string, org_id: string, role?: string): Promise<{ sub: string; org: string }> {
  const res = await fetch("/api/v1/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ sub, org_id, role }),
  });
  if (!res.ok) throw new Error("login failed");
  const json = await res.json();
  setToken(json.token);
  return { sub: json.user_id, org: json.org_id };
}
