// "Consommation vs plafond" (§L5.5). Echoes the sidebar BudgetGauge's real month-to-date spend
// (same GET /api/v1/admin/usage source, same UTC month key) but as the detailed page. No cap
// endpoint exists yet (only per-job monthly_budget_usd, not an org-wide ceiling), so — exactly
// like BudgetGauge — this NEVER draws a progress bar against an invented plafond; it says so.
import { Gauge } from "lucide-react";
import { StatCard } from "./StatCard";
import { formatUsd } from "./billing";
import type { UsageStatus } from "./useUsageDaily";

// hasData distinguishes "no usage_daily rows reached us at all" (unauthorized / backend down /
// genuinely no history — tolerant-degrade folds these together, same as BudgetGauge) from "rows
// came back and this month really does sum to zero" — only the latter renders "$0.00"; the
// former renders "—" so a dash never gets misread as a confirmed zero-spend month.
export function ConsumptionCard({
  status, mtdUsd, hasData,
}: { status: UsageStatus; mtdUsd: number; hasData: boolean }) {
  return (
    <StatCard icon={Gauge} label="Consommation ce mois">
      <div className="font-mono text-3xl text-foreground">
        {status === "loading" ? (
          <span aria-live="polite" className="text-muted-foreground">…</span>
        ) : hasData ? (
          <span aria-live="polite">{formatUsd(mtdUsd)}</span>
        ) : (
          <span aria-live="polite" className="text-muted-foreground">—</span>
        )}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Dépense réelle du mois en cours, agrégée depuis <code className="font-mono">usage_daily</code>.
        Aucun plafond n'est exposé par l'API pour l'instant — pas de barre de progression contre un
        chiffre inventé.
      </p>
    </StatCard>
  );
}
