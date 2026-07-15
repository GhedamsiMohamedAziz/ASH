// Shared KPI tile for the Facturation page — label + mono figure + optional caption. Kept
// dependency-light (no chart, no fetch) so PlanSeatsCard/ConsumptionCard just supply content.
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";

export function StatCard({
  icon: Icon,
  label,
  accent = "cyan",
  children,
  className,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  accent?: "cyan" | "amber";
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-3 rounded-xl border border-border bg-card p-4", className)}>
      <div className="flex items-center gap-2 text-muted-foreground">
        <Icon className={cn("size-4 shrink-0", accent === "amber" ? "text-amber" : "text-cyan")} aria-hidden />
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      {children}
    </div>
  );
}

export function StatRow({ label, value, muted = false }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={cn("font-mono text-lg", muted ? "text-muted-foreground" : "text-foreground")}>{value}</span>
    </div>
  );
}
