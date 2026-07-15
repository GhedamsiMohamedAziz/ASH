// "Répartition interactif / automatisations" (§L5.5) — a first-class split of usage_daily by
// `origin`. Real donut built with inline SVG (no chart dependency): cyan = interactive
// (action/flux, §4.5), amber = scheduled (automations, §4.5) — the app's one true accent mapping,
// never a generic categorical palette. Legend rows carry the exact $ figures so nothing is
// reachable only by hovering the arc (dataviz interaction contract).
import { PieChart } from "lucide-react";
import { formatUsd, pct, type OriginTotals } from "./billing";
import type { UsageStatus } from "./useUsageDaily";
import { cn } from "@/lib/utils";

const R = 56;
const STROKE = 20;
const CIRC = 2 * Math.PI * R;
const GAP = 6; // px, in stroke-dasharray units — the "surface gap" between the two arcs

function arc(len: number, offset: number, color: string) {
  const drawLen = Math.max(len - GAP, 0);
  return (
    <circle
      r={R}
      cx={70}
      cy={70}
      fill="none"
      stroke={color}
      strokeWidth={STROKE}
      strokeDasharray={`${drawLen} ${CIRC - drawLen}`}
      strokeDashoffset={-(offset + GAP / 2)}
      strokeLinecap="butt"
    />
  );
}

export function OriginSplitCard({ status, totals }: { status: UsageStatus; totals: OriginTotals }) {
  const total = totals.interactive + totals.scheduled + totals.other;
  const loading = status === "loading";
  const empty = !loading && total <= 0;

  const interactiveLen = total > 0 ? (totals.interactive / total) * CIRC : 0;
  const scheduledLen = total > 0 ? (totals.scheduled / total) * CIRC : 0;

  return (
    <div className="flex flex-col gap-4 rounded-xl border border-border bg-card p-4">
      <div className="flex items-center gap-2 text-muted-foreground">
        <PieChart className="size-4 shrink-0 text-cyan" aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide">Répartition interactif / automatisations</span>
      </div>

      <div className="flex flex-col items-center gap-4 min-[420px]:flex-row min-[420px]:items-center">
        <div className="relative shrink-0">
          <svg width={140} height={140} viewBox="0 0 140 140" role="img" aria-label="Répartition de la dépense entre usage interactif et automatisations">
            <circle r={R} cx={70} cy={70} fill="none" stroke="var(--panel-2)" strokeWidth={STROKE} />
            {!loading && !empty && (
              <g transform="rotate(-90 70 70)">
                {interactiveLen > 0 && arc(interactiveLen, 0, "var(--cyan)")}
                {scheduledLen > 0 && arc(scheduledLen, interactiveLen, "var(--amber)")}
              </g>
            )}
          </svg>
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="font-mono text-lg text-foreground">
              {loading ? "…" : empty ? "—" : formatUsd(total)}
            </span>
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground">ce mois</span>
          </div>
        </div>

        <div className="flex w-full flex-col gap-2.5">
          <LegendRow color="cyan" label="Interactif" value={totals.interactive} total={total} empty={empty} />
          <LegendRow color="amber" label="Automatisations" value={totals.scheduled} total={total} empty={empty} />
          {totals.other > 0 && (
            <LegendRow color="muted" label="Autre" value={totals.other} total={total} empty={empty} />
          )}
        </div>
      </div>

      {empty && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Aucune donnée d'usage pour ce mois — cette vue se remplira dès que{" "}
          <code className="font-mono">usage_daily</code> aura des lignes réelles.
        </p>
      )}
    </div>
  );
}

function LegendRow({
  color, label, value, total, empty,
}: { color: "cyan" | "amber" | "muted"; label: string; value: number; total: number; empty: boolean }) {
  const dot = color === "cyan" ? "bg-cyan" : color === "amber" ? "bg-amber" : "bg-muted-foreground";
  // Stacked two-line layout (label above, value+% below) rather than one packed row: at the
  // card's fixed narrow width, "label · value · %" on one line was overflowing past the card
  // edge and disappearing behind the neighbouring chart card. Stacking guarantees every figure
  // stays inside its own card at any reasonable width instead of silently clipping.
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className={cn("size-2.5 shrink-0 rounded-full", dot)} aria-hidden />
        {label}
      </span>
      <span className="flex items-baseline justify-between pl-[18px] font-mono">
        <span className="text-sm text-foreground">{empty ? "—" : formatUsd(value)}</span>
        <span className="text-xs text-muted-foreground">{empty ? "" : `${pct(value, total)}%`}</span>
      </span>
    </div>
  );
}
