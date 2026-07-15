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

// ---- Automations view (§2.6 "Mon agent", §4.5) -------------------------------------------
// GET /api/v1/automations (services/backend-core/app/main.py -> PgStore._JOB_COLUMNS) returns
// exactly {id, user_id, org_id, name, prompt, cron, timezone, status, monthly_budget_usd,
// next_run_at, last_run_at, created_at, updated_at} — there is no cost-per-run or created_by
// column selected, so those are never rendered (ADR-017 spirit: show only real fields). Every
// scheduled_jobs row IS a cron by construction (the `cron` column is NOT NULL), so every
// automation legitimately gets the ⟳ amber chip (§4.5 "amber = automations, everything cron") —
// this isn't a fabricated distinction between "cron-created" and other automations.
export interface AutomationJob {
  id: string; name: string; cron: string; timezone: string; status: string;
  monthly_budget_usd?: number | null; next_run_at?: string | null;
}

export interface AutomationRow {
  id: string; title: string; scheduleLabel: string; statusLabel: string;
  budgetLabel: string | null; nextRunLabel: string | null;
  canPause: boolean; color: "amber" | "muted";
}

const DOW_FR = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

// Human-readable cron (§2.6 "horaire (lisible)"). Only the common "at HH:MM every day" and
// "at HH:MM on a given weekday" shapes get a French phrase; anything more exotic (step values,
// lists, month restrictions) falls back to the raw cron string — never guess a schedule we can't
// actually explain.
export function humanizeCron(cron: string, timezone = "UTC"): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [min, hour, dom, month, dow] = parts;
  const isNum = (s: string) => /^\d+$/.test(s);
  if (!isNum(min) || !isNum(hour)) return cron;
  const hhmm = `${hour.padStart(2, "0")}h${min.padStart(2, "0")}`;
  if (dom === "*" && month === "*" && dow === "*") return `chaque jour à ${hhmm} (${timezone})`;
  if (dom === "*" && month === "*" && /^[0-6]$/.test(dow)) {
    return `chaque ${DOW_FR[Number(dow)]} à ${hhmm} (${timezone})`;
  }
  return cron;
}

// Real, deterministic (UTC) formatting for next_run_at — avoids locale-dependent Date formatting
// so it stays testable and consistent across the audit-time helper's style (hms() above).
export function formatTimestamp(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

// Format an automation for the list (amber = automations colour, §4.5).
export function automationRow(a: AutomationJob): AutomationRow {
  const budget = a.monthly_budget_usd;
  return {
    id: a.id,
    title: a.name,
    scheduleLabel: humanizeCron(a.cron, a.timezone),
    statusLabel: a.status === "active" ? "active" : a.status === "paused" ? "en pause" : a.status,
    budgetLabel: budget != null ? `$${budget.toFixed(2)}/mois` : null,
    nextRunLabel: a.next_run_at ? `prochaine exécution ${formatTimestamp(a.next_run_at)}` : null,
    canPause: a.status === "active",
    color: a.status === "active" ? "amber" : "muted",
  };
}

// Active-job quota (§2.6 "quota affiché (n/20)"; cap from instructions.md §16.1 "max 20 jobs
// actifs/utilisateur"). Counts only active jobs from the real list — paused ones don't consume
// the quota, and the max is the documented per-user cap, not a fabricated number.
export function automationQuota(jobs: { status: string }[], max = 20): string {
  return `${jobs.filter((j) => j.status === "active").length}/${max}`;
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

// ---- Connecteurs view (§2.5, §14) --------------------------------------------------------
// GET /api/v1/me (services/backend-core/app/main.py) returns {provider, connected, label} only —
// it does not carry an identity-type field. The identity model per provider is static metadata
// from the §14 connector table, not a fabricated connection status (ADR-017 spirit: never invent
// STATUS; a provider's identity kind is fixed, known infrastructure fact), so it is safe to derive
// client-side pending a backend field. Keys match the `provider` values in backend-core's
// _PROVIDERS list, plus the org-included connectors (§2.5) for when those are surfaced too.
const PROVIDER_IDENTITY_TYPE: Record<string, string> = {
  github: "OAuth utilisateur",
  slack: "OAuth utilisateur",
  notion: "OAuth utilisateur",
  m365: "Permissions déléguées",
  database: "Compte de service",
  browser: "Aucune / éphémère",
  scheduler: "Service token",
};

// Fallback for any connector not yet in the table above: the generic scoped-credential bucket.
export function identityTypeLabel(provider: string): string {
  return PROVIDER_IDENTITY_TYPE[provider] ?? "Token par projet";
}
