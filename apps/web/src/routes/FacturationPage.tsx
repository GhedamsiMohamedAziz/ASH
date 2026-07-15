// Route: /facturation (§4.4, §L5.5). Plan & sièges, consommation vs plafond, répartition
// interactif/automatisations (`usage_daily.origin`), graphe 14 jours et factures téléchargeables.
// Real data only (ADR-017): GET /api/v1/admin/usage is the single source of truth for spend, read
// once here and aggregated client-side (components/facturation/billing.ts) so the KPI tiles, the
// donut and the 14-day chart never disagree. There is no cap/plan/seat or invoice endpoint yet, so
// those sections honestly render "—" / an empty state instead of a guessed number — see each
// component's header comment for exactly which backend route (or the lack of one) backs it.
import { useMemo } from "react";
import { useShell } from "@/components/shell/AppShell";
import { useUsageDaily } from "@/components/facturation/useUsageDaily";
import { mtdTotal, originTotals, lastNDays, bucketByDay } from "@/components/facturation/billing";
import { PlanSeatsCard } from "@/components/facturation/PlanSeatsCard";
import { ConsumptionCard } from "@/components/facturation/ConsumptionCard";
import { OriginSplitCard } from "@/components/facturation/OriginSplitCard";
import { DailyCostChart } from "@/components/facturation/DailyCostChart";
import { InvoicesCard } from "@/components/facturation/InvoicesCard";

export function FacturationPage() {
  const { identityKey } = useShell();
  const { status, rows } = useUsageDaily(identityKey);

  const mtdRows = useMemo(() => {
    const month = new Date().toISOString().slice(0, 7);
    return rows.filter((r) => r.day?.startsWith(month));
  }, [rows]);

  const mtdUsd = useMemo(() => mtdTotal(rows), [rows]);
  const totals = useMemo(() => originTotals(mtdRows), [mtdRows]);
  const days = useMemo(() => bucketByDay(rows, lastNDays(14)), [rows]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-5xl flex-col gap-5 p-4 min-[640px]:p-6">
        <header className="flex flex-col gap-1">
          <h1 className="font-heading text-xl font-semibold tracking-tight text-foreground">Facturation</h1>
          <p className="text-sm text-muted-foreground">
            Plan, consommation, répartition d'usage et factures — chiffres réels uniquement.
          </p>
        </header>

        <section aria-label="Plan et consommation" className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <PlanSeatsCard identityKey={identityKey} />
          <ConsumptionCard status={status} mtdUsd={mtdUsd} hasData={rows.length > 0} />
        </section>

        <section aria-label="Répartition et activité" className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[380px_minmax(0,1fr)]">
          <OriginSplitCard status={status} totals={totals} />
          <DailyCostChart status={status} days={days} />
        </section>

        <section aria-label="Factures">
          <InvoicesCard />
        </section>
      </div>
    </div>
  );
}
