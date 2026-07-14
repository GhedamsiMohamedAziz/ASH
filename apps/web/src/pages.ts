// View-models for the Memories (§4.4) + Automations (§4.4, §7.3) pages. Pure/testable.

export interface MemoryItem { id: string; content: string; kind: string; }
export interface MemoryGroup { kind: string; label: string; items: MemoryItem[]; }

const KIND_LABEL: Record<string, string> = {
  fact: "Faits", preference: "Préférences", procedure: "Procédures", correction: "Corrections",
};

// Group memories by type for the Mémoires page (§4.4 — transparency §9.1.3).
export function groupMemories(items: MemoryItem[]): MemoryGroup[] {
  const by = new Map<string, MemoryItem[]>();
  for (const m of items) (by.get(m.kind) ?? by.set(m.kind, []).get(m.kind)!).push(m);
  return [...by.entries()].map(([kind, items]) => ({ kind, label: KIND_LABEL[kind] ?? kind, items }));
}

export interface Automation { id: string; name: string; humanSchedule: string; status: string; costPerRun: number; }
export interface AutomationRow { id: string; title: string; subtitle: string; canPause: boolean; color: "amber" | "muted"; }

// Format an automation for the list (amber = automations colour, §4.5).
export function automationRow(a: Automation): AutomationRow {
  return {
    id: a.id, title: a.name,
    subtitle: `⟳ ${a.humanSchedule} · ${a.status} · $${a.costPerRun.toFixed(4)}/run`,
    canPause: a.status === "active",
    color: a.status === "active" ? "amber" : "muted",
  };
}

// ---- Audit view (§16.1, §4.4) — the governance moat made visible ------------------------
// Renders the gateway's audit trail: who acted, on whose behalf (Mode B, §3.2), what tool,
// the allow/deny/approval verdict, and which secret categories DLP redacted (§13.5). This is
// the surface that proves the moat to a buyer, so the mapping is pure + tested.

// Mirrors services/mcp-gateway/src/gateway.ts AuditEntry.
export interface AuditEntry {
  ts: number;
  actor: string;
  on_behalf_of: string | null;
  action: string;
  tool: string;
  status: "ok" | "denied" | "needs_approval" | "error";
  redacted: string[];
  reason?: string;
}

export interface AuditRow {
  id: string;
  tool: string;
  who: string;                 // "actor" or "actor ⇢ on_behalf_of" in team mode
  statusLabel: string;
  color: "green" | "amber" | "rose" | "muted";
  redactions: string[];        // DLP categories masked on this call
  reason?: string;
  time: string;                // HH:MM:SS from the epoch-seconds ts (0 → "—")
}

const AUDIT_STATUS: Record<AuditEntry["status"], { label: string; color: AuditRow["color"] }> = {
  ok:             { label: "autorisé",  color: "green" },
  needs_approval: { label: "approbation requise", color: "amber" },
  denied:         { label: "refusé",    color: "rose" },
  error:          { label: "erreur",    color: "rose" },
};

function hms(ts: number): string {
  if (!ts) return "—"; // gateway stamps ts=0 in tests; real rows get now() at the DB (§16.1)
  const d = new Date(ts * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function auditRow(e: AuditEntry, index = 0): AuditRow {
  const s = AUDIT_STATUS[e.status] ?? { label: e.status, color: "muted" as const };
  return {
    id: `${e.ts}:${e.tool}:${index}`,
    tool: e.tool,
    who: e.on_behalf_of ? `${e.actor} ⇢ ${e.on_behalf_of}` : e.actor,
    statusLabel: s.label,
    color: s.color,
    redactions: e.redacted ?? [],
    reason: e.reason,
    time: hms(e.ts),
  };
}

// Counts by verdict for the audit header (e.g. "12 autorisés · 1 refusé · 2 caviardés").
export function auditSummary(entries: AuditEntry[]): {
  ok: number; denied: number; needs_approval: number; error: number; redactedCalls: number;
} {
  const c = { ok: 0, denied: 0, needs_approval: 0, error: 0, redactedCalls: 0 };
  for (const e of entries) {
    c[e.status] = (c[e.status] ?? 0) + 1;
    if ((e.redacted ?? []).length) c.redactedCalls += 1;
  }
  return c;
}
