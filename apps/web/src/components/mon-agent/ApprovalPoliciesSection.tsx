// Approval toggles (§2.6 "toggles d'approbation dont certains verrouillés par l'organisation" —
// the §2.6 rendering of the tool_policies matrix). There is no GET /api/v1/tool_policies route
// yet, so this renders the real seeded `member`-role matrix from
// db/migrations/0003_seed_policies.sql (org_1) as read-only, locked rows, plus one representative
// category the seed doesn't govern (m365.send_mail) as a genuine local toggle. See
// agentConfig.ts for the full honesty note.
import { useState } from "react";
import { Lock, ShieldAlert, ShieldBan, ShieldCheck } from "lucide-react";
import { APPROVAL_POLICIES, getLocalApprovalPref, setLocalApprovalPref } from "./agentConfig";
import { Toggle } from "./Toggle";

const EFFECT_META = {
  require_approval: { label: "Approbation requise", icon: ShieldAlert, className: "text-amber" },
  deny: { label: "Bloqué", icon: ShieldBan, className: "text-rose" },
} as const;

export function ApprovalPoliciesSection() {
  // Only the unlocked row's checkbox state actually matters — locked rows always reflect the
  // fixed org effect — but we track it generically in case a future org rule unlocks one.
  const [prefs, setPrefs] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(APPROVAL_POLICIES.map((p) => [p.tool, getLocalApprovalPref(p.tool)]))
  );

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

      <div className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
        {APPROVAL_POLICIES.map((p) => {
          const meta = EFFECT_META[p.effect];
          const EffectIcon = meta.icon;
          const checked = p.locked ? true : prefs[p.tool];
          return (
            <div key={p.tool} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex min-w-0 flex-col gap-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-foreground">{p.tool}</span>
                  <span className={`flex items-center gap-1 text-[11px] ${meta.className}`}>
                    <EffectIcon className="size-3" aria-hidden /> {meta.label}
                  </span>
                  {p.approverGroup && (
                    <span className="rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                      approbateur : {p.approverGroup}
                    </span>
                  )}
                </div>
                <span className="text-xs text-muted-foreground">{p.label}</span>
                {p.locked ? (
                  <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                    <Lock className="size-3" aria-hidden /> verrouillé par votre organisation
                  </span>
                ) : (
                  <span className="text-[11px] text-cyan/80">préférence locale — pas encore appliquée par la plateforme</span>
                )}
              </div>

              {p.effect === "deny" ? (
                // A "deny" row isn't a require-approval gate to flip — it's an outright block.
                // An on/off switch here would imply a choice that doesn't exist, so this stays a
                // static indicator instead of a Toggle.
                <span
                  className="flex shrink-0 items-center gap-1.5 self-start rounded-full border border-rose/30 bg-rose/10 px-3 py-1 text-[11px] font-medium text-rose sm:self-auto"
                  title="Toujours bloqué par la politique de l'organisation"
                >
                  <Lock className="size-3" aria-hidden /> bloqué
                </span>
              ) : (
                <Toggle
                  checked={checked}
                  disabled={p.locked}
                  label={`Approbation requise pour ${p.tool}`}
                  onChange={(next) => {
                    if (p.locked) return;
                    setLocalApprovalPref(p.tool, next);
                    setPrefs((prev) => ({ ...prev, [p.tool]: next }));
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
