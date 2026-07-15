// Shared typed fetch wrapper for backend-core's REST surface (base `/api/v1`, proxied by Vite
// to :8000 in dev). Every route component — Chat today, the other 4 pages next — should read
// through this instead of hand-rolling fetch+authHeaders, so auth attachment, JSON handling and
// error shape stay in one place (§8.2 "un event, un contrat" applied to the client too).
import { authHeaders } from "../auth.ts";

const API_BASE = "/api/v1";

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = authHeaders({
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  });
  const res = await fetch(`${API_BASE}${path}`, { ...init, headers });
  if (!res.ok) {
    let message = res.statusText || `HTTP ${res.status}`;
    let code: string | undefined;
    try {
      const body = await res.json();
      // backend-core error envelope (packages/errors/gen.py envelope()): { error: { code, message, trace_id } }
      code = body?.error?.code ?? body?.code;
      message = body?.error?.message ?? body?.message ?? message;
    } catch {
      // non-JSON error body — keep the statusText fallback above
    }
    throw new ApiError(res.status, message, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body !== undefined ? JSON.stringify(body) : "{}" }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body !== undefined ? JSON.stringify(body) : "{}" }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// Tolerant-degrade read (ADR-017 spirit): resolves to `fallback` instead of throwing, for panels
// that must render an empty/neutral state rather than crash when the backend, an upstream proxy,
// or an admin-only route (e.g. /admin/usage for a non-admin caller) is unreachable/unauthorized.
// NEVER invent data in the fallback — it should be an empty list/neutral shape, never a guessed
// number.
export async function tryGet<T>(path: string, fallback: T): Promise<T> {
  try {
    return await api.get<T>(path);
  } catch {
    return fallback;
  }
}
