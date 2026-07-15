// View-model + pure aggregation for the Facturation page (§4.4, §L5.5). Mirrors the shape of
// pages.ts (automations/audit): deterministic UTC math, no fabricated numbers (ADR-017) — every
// exported function only ever summarizes rows it was actually given. Source of truth is
// GET /api/v1/admin/usage (usage_daily rows: day, org_id, user_id, model, origin, tokens_in/out,
// cost_usd, tool_calls, sandbox_seconds — db/migrations/0001_init.sql). There is no cap/plan/seat
// or invoice endpoint exposed over the API yet, so those stay "—" / empty at the call site rather
// than being invented here.
export interface UsageRow {
  day: string;
  org_id?: string;
  user_id?: string;
  model?: string;
  origin?: string; // "interactive" | "scheduled" (schema default: interactive)
  tokens_in?: number | string;
  tokens_out?: number | string;
  cost_usd: number | string;
  tool_calls?: number;
  sandbox_seconds?: number;
}

export interface DayBucket {
  day: string;        // YYYY-MM-DD (UTC)
  interactive: number;
  scheduled: number;
  total: number;
}

// Postgres NUMERIC round-trips as a string over JSON — coerce defensively (same pattern as
// BudgetGauge's `Number(r.cost_usd ?? 0)`), never NaN into a total.
export function toCost(v: number | string | undefined | null): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

// Deterministic UTC "YYYY-MM" for the current month — matches BudgetGauge's month key exactly so
// the sidebar gauge and this page's KPI never disagree.
export function currentMonthKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export function mtdTotal(rows: UsageRow[], monthKey: string = currentMonthKey()): number {
  return rows.filter((r) => r.day?.startsWith(monthKey)).reduce((acc, r) => acc + toCost(r.cost_usd), 0);
}

// Split by `origin` (§L5.5 "répartition interactif / automatisations") — any row lacking a
// recognized origin is bucketed as "other" rather than silently folded into interactive, so a
// schema surprise is visible instead of misreported.
export interface OriginTotals { interactive: number; scheduled: number; other: number }

export function originTotals(rows: UsageRow[]): OriginTotals {
  const t: OriginTotals = { interactive: 0, scheduled: 0, other: 0 };
  for (const r of rows) {
    const c = toCost(r.cost_usd);
    if (r.origin === "interactive") t.interactive += c;
    else if (r.origin === "scheduled") t.scheduled += c;
    else t.other += c;
  }
  return t;
}

// Last `n` UTC calendar days (inclusive of today), ascending — deterministic, no locale.
export function lastNDays(n = 14, now: Date = new Date()): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - i));
    days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

// Bucket real rows onto a fixed day skeleton so every day renders (0-cost days included) instead
// of a chart that silently compresses when there's no usage.
export function bucketByDay(rows: UsageRow[], days: string[]): DayBucket[] {
  const by = new Map<string, { interactive: number; scheduled: number }>();
  for (const day of days) by.set(day, { interactive: 0, scheduled: 0 });
  for (const r of rows) {
    const bucket = r.day ? by.get(r.day.slice(0, 10)) : undefined;
    if (!bucket) continue; // outside the window
    const c = toCost(r.cost_usd);
    if (r.origin === "scheduled") bucket.scheduled += c;
    else bucket.interactive += c;
  }
  return days.map((day) => {
    const b = by.get(day)!;
    return { day, interactive: b.interactive, scheduled: b.scheduled, total: b.interactive + b.scheduled };
  });
}

export function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`;
}

// Deterministic UTC "DD/MM" — same no-locale discipline as pages.ts#formatTimestamp.
export function formatShortDay(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}`;
}

export function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}
