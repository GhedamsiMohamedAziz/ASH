// Approval matrix (§2.6 "toggles d'approbation dont certains verrouillés par l'organisation" —
// the §2.6 rendering of the tool_policies matrix). REAL data now: GET /api/v1/tool_policies
// (services/backend-core/app/main.py) returns the caller's own org+role rows from the
// `tool_policies` table (db/migrations/0001_init.sql / seeded per-org, e.g. 0003 for org_1) — so
// this renders whichever org the logged-in identity belongs to, not a fixed literal. Those rows
// are the org's server-side ENFORCED policy, so they stay read-only/locked (ADR-017 honesty: we
// only claim "verrouillé par votre organisation" because it is now actually fetched and
// enforced server-side). Any tool with NO server rule can still get a genuine local (client-only)
// preference — see LOCAL_APPROVAL_CANDIDATES in agentConfig.ts — clearly labelled "préférence
// locale" so it is never mistaken for org policy.
import { useEffect, useState } from "react";
import { Loader2, Lock, ShieldAlert, ShieldBan, ShieldCheck } from "lucide-react";
import { tryGet } from "@/lib/api";
import { useShell } from "@/components/shell/AppShell";
import { LOCAL_APPROVAL_CANDIDATES, getLocalApprovalPref, setLocalApprovalPref } from "./agentConfig";
import { Toggle } from "./Toggle";

interface ToolPolicyRow {
  tool_pattern: string;
  effect: "allow" | "require_approval" | "deny";
  approver_group: string | null;
}

const EFFECT_META = {
  allow: { label: "Autorisé", icon: ShieldCheck, className: "border-green/30 bg-green/10 text-green" },
  require_approval: { label: "Approbation", icon: ShieldAlert, className: "border-amber/30 bg-amber/10 text-amber" },
  deny: { label: "Bloqué", icon: ShieldBan, className: "border-rose/30 bg-rose/10 text-rose" },
} as const;

export function ApprovalPoliciesSection() {
  const { identityKey } = useShell();
  const [rows, setRows] = useState<ToolPolicyRow[] | null>(null);
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(LOCAL_APPROVAL_CANDIDATES.map((c) => [c.tool, getLocalApprovalPref(c.tool)]))
  );

  useEffect(() => {
    let stop = false;
    setRows(null);
    (async () => {
      const body = await tryGet<{ items: ToolPolicyRow[] }>("/tool_policies", { items: [] });
      if (!stop) setRows(body.items);
    })();
    return () => { stop = true; };
  }, [identityKey]);

  const loading = rows === null;
  const list = rows ?? [];
  const governed = new Set(list.map((r) => r.tool_pattern));
  const localOnly = LOCAL_APPROVAL_CANDIDATES.filter((c) => !governed.has(c.tool));

  return (
    <section aria-labelledby="mon-agent-policies-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="mon-agent-policies-heading" className="font-heading text-sm font-semibold uppercase tracking-wide text-foreground">
          Politique d'approbation
        </h2>
        <span className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground">
          <ShieldCheck className="size-3.5" aria-hidden /> matrice de l'organisation
        </span>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Chargement de la matrice…
        </div>
      ) : list.length === 0 ? (
        <div className="rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          Aucune politique définie pour votre organisation.
        </div>
      ) : (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
          {list.map((row) => {
            const meta = EFFECT_META[row.effect];
            const EffectIcon = meta.icon;
            return (
              <div key={row.tool_pattern} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-xs text-foreground">{row.tool_pattern}</span>
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Lock className="size-3" aria-hidden /> verrouillé par votre organisation
                  </span>
                </div>

                <div className="flex shrink-0 flex-wrap items-center gap-2 self-start sm:self-auto">
                  {row.approver_group && (
                    <span className="rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      approbateur : {row.approver_group}
                    </span>
                  )}
                  <span
                    className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[11px] font-medium ${meta.className}`}
                    title="Défini par la politique de l'organisation"
                  >
                    <EffectIcon className="size-3" aria-hidden /> {meta.label}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {localOnly.length > 0 && (
        <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-dashed border-border bg-card">
          <div className="px-4 pt-3 text-[11px] font-medium uppercase tracking-wide text-cyan/80">
            Préférence locale — pas encore appliquée par la plateforme
          </div>
          {localOnly.map((c) => {
            const checked = prefs[c.tool];
            return (
              <div key={c.tool} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="font-mono text-xs text-foreground">{c.tool}</span>
                  <span className="text-xs text-muted-foreground">{c.label}</span>
                  <span className="text-[11px] text-cyan/80">
                    Aucune règle d'organisation pour cet outil — préférence locale uniquement.
                  </span>
                </div>
                <Toggle
                  checked={checked}
                  label={`Approbation requise pour ${c.tool}`}
                  onChange={(next) => {
                    setLocalApprovalPref(c.tool, next);
                    setPrefs((prev) => ({ ...prev, [c.tool]: next }));
                  }}
                />
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
