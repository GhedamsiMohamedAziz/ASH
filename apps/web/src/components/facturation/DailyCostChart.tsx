// "Graphe 14 jours" (§L5.5) — inline SVG stacked bar chart (no charting dependency), real daily
// cost from usage_daily bucketed client-side (billing.ts#bucketByDay). Each day stacks interactive
// (cyan, bottom) under scheduled (amber, top) so the split from OriginSplitCard reads consistently
// across both views. Cache hit rate: no metric endpoint exposes it anywhere in the backend today
// (grep confirms no cache_hit/hit_rate route), so — per the "never fabricate" rule — that line is
// omitted from the plot rather than invented, with an explicit caption saying so instead of a
// silent gap that could read as an oversight.
import { useState } from "react";
import { TrendingUp } from "lucide-react";
import { formatUsd, formatShortDay, type DayBucket } from "./billing";
import type { UsageStatus } from "./useUsageDaily";

const VB_W = 640;
const VB_H = 200;
const PAD_L = 40;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 26;
const INNER_W = VB_W - PAD_L - PAD_R;
const INNER_H = VB_H - PAD_T - PAD_B;
const BASELINE = PAD_T + INNER_H;
const SEG_GAP = 2; // surface gap between stacked interactive/scheduled segments
const RADIUS = 4;

// Round a max value up to a clean gridline step (1/2/5 × 10^n) — never an arbitrary decimal.
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const exp = Math.floor(Math.log10(value));
  const base = Math.pow(10, exp);
  for (const m of [1, 2, 5, 10]) {
    if (value <= m * base) return m * base;
  }
  return 10 * base;
}

function roundedTopPath(x: number, topY: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  const bottomY = topY + h;
  return `M ${x} ${bottomY} L ${x} ${topY + rr} Q ${x} ${topY} ${x + rr} ${topY} L ${x + w - rr} ${topY} Q ${x + w} ${topY} ${x + w} ${topY + rr} L ${x + w} ${bottomY} Z`;
}

export function DailyCostChart({ status, days }: { status: UsageStatus; days: DayBucket[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const loading = status === "loading";
  const total = days.reduce((a, d) => a + d.total, 0);
  const empty = !loading && total <= 0;

  const maxVal = niceMax(Math.max(...days.map((d) => d.total), 0));
  const slot = INNER_W / Math.max(days.length, 1);
  const barW = Math.min(24, slot * 0.55);

  const bars = days.map((d, i) => {
    const x = PAD_L + i * slot + (slot - barW) / 2;
    type Seg = { key: "interactive" | "scheduled"; value: number; color: string };
    const order: Seg[] = [
      { key: "interactive", value: d.interactive, color: "var(--cyan)" },
      { key: "scheduled", value: d.scheduled, color: "var(--amber)" },
    ];
    let cursorY = BASELINE;
    let started = false;
    const rendered: { key: string; color: string; x: number; topY: number; h: number }[] = [];
    for (const seg of order) {
      if (seg.value <= 0) continue;
      if (started) cursorY -= SEG_GAP;
      const rawH = maxVal > 0 ? (seg.value / maxVal) * INNER_H : 0;
      const h = Math.max(rawH, 2);
      const topY = cursorY - h;
      rendered.push({ key: seg.key, color: seg.color, x, topY, h });
      cursorY = topY;
      started = true;
    }
    return { i, x, day: d, rendered };
  });

  const gridSteps = [0, 0.5, 1];

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          <TrendingUp className="size-4 shrink-0 text-cyan" aria-hidden />
          <span className="text-xs font-medium uppercase tracking-wide">Activité — 14 derniers jours</span>
        </div>
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-cyan" aria-hidden /> Interactif</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-amber" aria-hidden /> Automatisations</span>
        </div>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${VB_W} ${VB_H}`}
          className="w-full"
          role="img"
          aria-label="Dépense quotidienne des 14 derniers jours, répartie entre usage interactif et automatisations"
        >
          {gridSteps.map((s) => {
            const y = BASELINE - s * INNER_H;
            return (
              <g key={s}>
                <line x1={PAD_L} x2={VB_W - PAD_R} y1={y} y2={y} stroke="var(--line)" strokeWidth={1} />
                <text x={PAD_L - 6} y={y + 3} textAnchor="end" className="fill-muted-foreground" fontSize={9} fontFamily="var(--font-mono)">
                  {formatUsd(maxVal * s)}
                </text>
              </g>
            );
          })}

          {!loading && bars.map(({ i, x, day, rendered }) => (
            <g
              key={day.day}
              tabIndex={0}
              role="img"
              aria-label={`${formatShortDay(day.day)} — total ${formatUsd(day.total)}, interactif ${formatUsd(day.interactive)}, automatisations ${formatUsd(day.scheduled)}`}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover((h) => (h === i ? null : h))}
              onFocus={() => setHover(i)}
              onBlur={() => setHover((h) => (h === i ? null : h))}
              className="cursor-default outline-none"
            >
              {/* generous invisible hit target, taller than the tallest possible bar */}
              <rect x={x - 3} y={PAD_T} width={barW + 6} height={INNER_H} fill="transparent" />
              {rendered.length === 0 ? (
                <rect x={x} y={BASELINE - 1} width={barW} height={1} fill="var(--line)" />
              ) : (
                rendered.map((seg, idx) => (
                  <path
                    key={seg.key}
                    d={
                      idx === rendered.length - 1
                        ? roundedTopPath(seg.x, seg.topY, barW, seg.h, RADIUS)
                        : `M ${seg.x} ${seg.topY} h ${barW} v ${seg.h} h ${-barW} Z`
                    }
                    fill={seg.color}
                    opacity={hover === null || hover === i ? 1 : 0.45}
                    className="transition-opacity"
                  />
                ))
              )}
              {i % 2 === 0 && (
                <text x={x + barW / 2} y={VB_H - 8} textAnchor="middle" className="fill-muted-foreground" fontSize={9} fontFamily="var(--font-mono)">
                  {formatShortDay(day.day)}
                </text>
              )}
            </g>
          ))}

          <line x1={PAD_L} x2={VB_W - PAD_R} y1={BASELINE} y2={BASELINE} stroke="var(--line)" strokeWidth={1} />
        </svg>

        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
            Chargement…
          </div>
        )}

        {hover !== null && days[hover] && (
          <div
            className="pointer-events-none absolute top-1 flex flex-col gap-0.5 rounded-md border border-border bg-popover px-2.5 py-1.5 text-xs shadow-md"
            style={{ left: `${((PAD_L + hover * slot + slot / 2) / VB_W) * 100}%`, transform: "translateX(-50%)" }}
          >
            <span className="font-mono text-foreground">{formatShortDay(days[hover].day)} · {formatUsd(days[hover].total)}</span>
            <span className="flex items-center gap-1.5 text-cyan"><span className="size-1.5 rounded-full bg-cyan" /> {formatUsd(days[hover].interactive)}</span>
            <span className="flex items-center gap-1.5 text-amber"><span className="size-1.5 rounded-full bg-amber" /> {formatUsd(days[hover].scheduled)}</span>
          </div>
        )}
      </div>

      {empty && (
        <p className="text-xs leading-relaxed text-muted-foreground">
          Aucune dépense enregistrée sur les 14 derniers jours.
        </p>
      )}
      <p className="text-[11px] text-muted-foreground">
        Taux de succès du cache : non exposé par l'API pour l'instant — omis plutôt qu'estimé.
      </p>
    </div>
  );
}
