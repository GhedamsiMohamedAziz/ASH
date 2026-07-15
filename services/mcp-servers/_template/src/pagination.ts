// Pagination + response-size truncation (instructions.md §14 "règles communes": "pagination
// systématique, réponses tronquées à 256 Ko"). Shared by every read/list tool a connector
// exposes — not just this template's example.read.

export const MAX_RESPONSE_BYTES = 256 * 1024; // 256 KB

export interface Page<T> {
  items: T[];
  nextCursor?: string;
}

// Cursor-as-offset pagination over an already-fetched array. TODO(connector): if the real
// upstream API paginates natively (e.g. a `page_token`), pass its cursor straight through instead
// of re-implementing offset math here — this helper exists for backends (like StubBackend) that
// return the full set and need slicing done locally.
export function paginate<T>(all: T[], cursor: string | undefined, pageSize: number): Page<T> {
  const start = cursor ? Number(cursor) : 0;
  const safeStart = Number.isFinite(start) && start >= 0 ? Math.trunc(start) : 0;
  const items = all.slice(safeStart, safeStart + pageSize);
  const nextIndex = safeStart + items.length;
  return { items, nextCursor: nextIndex < all.length ? String(nextIndex) : undefined };
}

// Truncates a JSON-serializable payload so its serialized form fits within maxBytes. If the
// payload has a top-level `items` array (every paginated tool response does), items are dropped
// from the end until it fits and `truncated: true` is set so the caller — and eventually the MCP
// client — knows the page was cut short (never a silent partial result, §13.1 "result filtering").
// Falls back to a hard string slice for payloads with no items array.
export function truncateJson(payload: any, maxBytes: number = MAX_RESPONSE_BYTES): { json: string; truncated: boolean } {
  const initial = JSON.stringify(payload);
  if (Buffer.byteLength(initial, "utf8") <= maxBytes) return { json: initial, truncated: false };

  if (!Array.isArray(payload?.items)) {
    return { json: initial.slice(0, maxBytes), truncated: true };
  }

  // Binary search the largest item count whose serialized page still fits — O(log n) stringify
  // calls instead of popping one item and re-stringifying the whole array per iteration (O(n^2),
  // which is unusable once `items` is large enough to need truncating in the first place).
  const items = payload.items;
  const fits = (n: number) =>
    Buffer.byteLength(JSON.stringify({ ...payload, items: items.slice(0, n), truncated: true }), "utf8") <= maxBytes;

  if (!fits(0)) {
    // Even zero items plus the rest of the payload overflows maxBytes — last resort, hard-slice.
    return { json: JSON.stringify({ ...payload, items: [], truncated: true }).slice(0, maxBytes), truncated: true };
  }
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return { json: JSON.stringify({ ...payload, items: items.slice(0, lo), truncated: true }), truncated: true };
}
