// Fetches every usage_daily row reachable to the current identity via GET /api/v1/admin/usage
// (paginated, cursor-based — see backend-core's Page model). Tolerant-degrade (ADR-017 spirit),
// same discipline as BudgetGauge: a non-admin caller (403), no bearer at all (401), or the
// backend being down all resolve to the SAME neutral "ready, zero rows" — this hook never
// distinguishes "unauthorized" from "genuinely empty" to the caller, so the page can't leak an
// auth signal and can't fabricate a number either way.
import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { UsageRow } from "./billing";

export type UsageStatus = "loading" | "ready";

interface UsagePage { items: UsageRow[]; next_cursor: string | null }

const PAGE_LIMIT = 100;
const MAX_PAGES = 20; // 2,000 rows ceiling — generous for a single org's usage_daily history

async function fetchAllUsage(): Promise<UsageRow[]> {
  const rows: UsageRow[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    try {
      const qs = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) qs.set("cursor", cursor);
      const res: UsagePage = await api.get<UsagePage>(`/admin/usage?${qs.toString()}`);
      rows.push(...res.items);
      if (!res.next_cursor) break;
      cursor = res.next_cursor;
    } catch {
      break; // unauthorized / backend down / mid-pagination failure — keep whatever was fetched
    }
  }
  return rows;
}

export function useUsageDaily(identityKey: number): { status: UsageStatus; rows: UsageRow[] } {
  const [status, setStatus] = useState<UsageStatus>("loading");
  const [rows, setRows] = useState<UsageRow[]>([]);

  useEffect(() => {
    let stop = false;
    setStatus("loading");
    (async () => {
      const items = await fetchAllUsage();
      if (stop) return;
      setRows(items);
      setStatus("ready");
    })();
    return () => { stop = true; };
  }, [identityKey]);

  return { status, rows };
}
