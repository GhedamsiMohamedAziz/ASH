// Automations — the core, amber section (§2.6, §4.5 "ambre = tout ce qui touche aux
// automatisations"). Real data only: GET /api/v1/automations (backend-core → scheduled_jobs,
// owner-scoped). Pause/resume PATCHes {status} and applies the row the backend actually returns
// — never a guessed next state (ADR-017 spirit, matches the AutomationsTab pattern in
// RightPanel.tsx). Pure formatting (schedule/budget/next-run/quota) reuses pages.ts, tested there.
import { useEffect, useState } from "react";
import { Loader2, Pause, Play, RotateCw } from "lucide-react";
import { api, tryGet } from "@/lib/api";
import { automationQuota, automationRow, type AutomationJob } from "@/pages";
import { cn } from "@/lib/utils";

// The live API serialises the numeric(10,2) monthly_budget_usd column as a JSON string
// ("10.00") since Page.items is typed `list[Any]` on the backend (no float coercion happens).
// pages.ts's AutomationJob/automationRow expect a real number, so this raw shape stays local and
// gets normalised in `load()` below — never passed straight through un-coerced.
interface RawAutomation {
  id: string; name: string; cron: string; timezone: string; status: string;
  monthly_budget_usd?: number | string | null; next_run_at?: string | null;
}

function normalize(raw: RawAutomation): AutomationJob {
  return {
    id: raw.id, name: raw.name, cron: raw.cron, timezone: raw.timezone, status: raw.status,
    monthly_budget_usd: raw.monthly_budget_usd == null ? null : Number(raw.monthly_budget_usd),
    next_run_at: raw.next_run_at ?? null,
  };
}

export function AutomationsSection({ refreshKey }: { refreshKey?: number | string }) {
  const [jobs, setJobs] = useState<AutomationJob[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let stop = false;
    setJobs(null);
    (async () => {
      const page = await tryGet<{ items: RawAutomation[] }>("/automations", { items: [] });
      if (stop) return;
      setJobs(page.items.map(normalize));
    })();
    return () => { stop = true; };
  }, [refreshKey]);

  const togglePause = async (job: AutomationJob) => {
    if (busyId) return; // single-flight: one in-flight mutation at a time across the whole list
    const nextStatus = job.status === "active" ? "paused" : "active";
    setBusyId(job.id);
    try {
      const updated = await api.patch<RawAutomation>(`/automations/${job.id}`, { status: nextStatus });
      const normalized = normalize(updated);
      setJobs((prev) => (prev ?? []).map((j) => (j.id === job.id ? normalized : j)));
    } catch {
      // backend unreachable / rejected the patch — leave the row exactly as it was, no guess
    } finally {
      setBusyId(null);
    }
  };

  const list = jobs ?? [];
  const loading = jobs === null;

  return (
    <section aria-labelledby="mon-agent-automations-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="mon-agent-automations-heading" className="flex items-center gap-2 font-heading text-sm font-semibold uppercase tracking-wide text-amber">
          <RotateCw className="size-4" aria-hidden /> Automatisations
        </h2>
        {!loading && (
          <span
            className="rounded-full border border-amber/30 bg-amber/10 px-2.5 py-0.5 font-mono text-[11px] text-amber"
            title="Jobs actifs / plafond par utilisateur (§16.1)"
          >
            {automationQuota(list)}
          </span>
        )}
      </div>

      {loading && (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-4 py-6 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" aria-hidden /> Chargement des automatisations…
        </div>
      )}

      {!loading && list.length === 0 && (
        <div className="rounded-lg border border-dashed border-border bg-card px-4 py-6 text-center text-sm italic text-muted-foreground">
          Aucune automatisation.
        </div>
      )}

      {!loading && list.length > 0 && (
        <ul className="flex flex-col gap-2.5">
          {list.map((job) => {
            const row = automationRow(job);
            const busy = busyId === job.id;
            return (
              <li
                key={row.id}
                className={cn(
                  "flex flex-col gap-2 rounded-lg border bg-card px-4 py-3 transition-colors sm:flex-row sm:items-center sm:justify-between sm:gap-4",
                  row.color === "amber" ? "border-amber/25" : "border-border"
                )}
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={cn(
                        "flex size-6 shrink-0 items-center justify-center rounded-full",
                        row.color === "amber" ? "bg-amber/15 text-amber" : "bg-panel-2 text-muted-foreground"
                      )}
                      title="Planifiée (cron)"
                    >
                      <RotateCw className="size-3.5" aria-hidden />
                    </span>
                    <span className="truncate font-heading text-sm font-semibold text-foreground">{row.title}</span>
                    <span
                      className={cn(
                        "rounded-md px-2 py-0.5 text-[11px] font-medium",
                        row.color === "amber" ? "bg-amber/10 text-amber" : "bg-secondary text-muted-foreground"
                      )}
                    >
                      {row.statusLabel}
                    </span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 pl-8 font-mono text-[11px] text-muted-foreground">
                    <span>{row.scheduleLabel}</span>
                    {row.budgetLabel && <span>· {row.budgetLabel}</span>}
                    {row.nextRunLabel && <span>· {row.nextRunLabel}</span>}
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => togglePause(job)}
                  disabled={busy}
                  className={cn(
                    "flex shrink-0 items-center justify-center gap-1.5 self-start rounded-md border px-3 py-1.5 text-xs font-medium transition-colors sm:self-auto",
                    "border-border text-foreground hover:border-amber/50 hover:bg-amber/10 hover:text-amber",
                    "disabled:cursor-not-allowed disabled:opacity-60"
                  )}
                >
                  {busy ? (
                    <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  ) : row.canPause ? (
                    <Pause className="size-3.5" aria-hidden />
                  ) : (
                    <Play className="size-3.5" aria-hidden />
                  )}
                  {row.canPause ? "Pause" : "Reprendre"}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
