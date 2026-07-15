// Audit view (§16.1, §4.4) — shadcn/ui. Fetches the REAL audit trail for the conversation from
// backend-core (same fetch+authHeaders pattern as the Mémoires/Connecteurs tabs) and polls it.
// No mock: if the backend has nothing yet (or is unreachable), we render the empty state rather
// than fabricate rows (tolerant-proxy principle, ADR-017). Pure mapping (auditRow/auditSummary)
// lives in pages.ts (tested).
import React, { useEffect, useState } from "react";
import { auditRow, auditSummary, type AuditEntry } from "./pages.ts";
import { authHeaders } from "./auth.ts";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ShieldCheck, Shield } from "lucide-react";

const STATUS_CLASS: Record<string, string> = {
  green: "text-green", amber: "text-amber", rose: "text-rose", muted: "text-muted-foreground",
};

export function AuditPanel({ entries, conversationId, live = true }:
  { entries?: AuditEntry[]; conversationId?: string; live?: boolean }) {
  const [fetched, setFetched] = useState<AuditEntry[] | null>(null);

  useEffect(() => {
    if (!live || !conversationId) return;
    let stop = false;
    const pull = () =>
      fetch(`/api/v1/conversations/${conversationId}/audit`, { headers: authHeaders() })
        .then((r) => r.json())
        .then((j) => { if (!stop) setFetched((j.audit as AuditEntry[]) ?? []); })
        .catch(() => { if (!stop) setFetched((prev) => prev ?? []); });
    pull();
    const iv = setInterval(pull, 1500);
    return () => { stop = true; clearInterval(iv); };
  }, [live, conversationId]);

  // Real data only: live fetch result, or an explicit `entries` override (e.g. embedding this
  // panel without a conversation yet) — never a fabricated mock. Empty until the backend answers.
  const source: AuditEntry[] = live ? (fetched ?? []) : (entries ?? []);
  const rows = source.map(auditRow);
  const s = auditSummary(source);

  return (
    <aside className="flex h-full flex-col bg-background">
      <header className="flex flex-col gap-2 border-b px-4 py-3">
        <div className="flex items-center gap-2 font-semibold">
          <ShieldCheck className="size-4 text-green" /> Journal d'audit
        </div>
        <div className="flex flex-wrap gap-1.5 text-xs">
          <Badge variant="secondary" className="text-green">{s.ok} autorisés</Badge>
          {s.needs_approval > 0 && <Badge variant="secondary" className="text-amber">{s.needs_approval} en attente</Badge>}
          {s.denied > 0 && <Badge variant="secondary" className="text-rose">{s.denied} refusés</Badge>}
          {s.redactedCalls > 0 && <Badge variant="secondary" className="text-cyan">{s.redactedCalls} caviardés</Badge>}
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-3 p-3">
          {rows.length === 0 && <p className="italic text-muted-foreground">Aucune action encore.</p>}
          {rows.map((r, i) => (
            <div key={r.id + i}>
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
                <span className="font-mono text-[11px] text-muted-foreground">{r.time}</span>
                <span className={`text-xs font-semibold ${STATUS_CLASS[r.color] ?? ""}`}>{r.statusLabel}</span>
                <span className="font-mono">{r.tool}</span>
                <span className="text-xs text-muted-foreground">{r.who}</span>
                {r.redactions.length > 0 && (
                  <span className="flex items-center gap-1 text-xs text-cyan">
                    <Shield className="size-3" /> {r.redactions.join(", ")}
                  </span>
                )}
                {r.reason && <span className="basis-full text-xs text-muted-foreground">{r.reason}</span>}
              </div>
              {i < rows.length - 1 && <Separator className="mt-3 opacity-50" />}
            </div>
          ))}
        </div>
      </ScrollArea>
    </aside>
  );
}
