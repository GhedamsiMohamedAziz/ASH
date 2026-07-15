// Permanent monthly budget gauge (§4.2) — "la philosophie de maîtrise des coûts rendue visible à
// l'utilisateur", so it lives in the sidebar, not tucked into an admin screen. Real data only:
// GET /api/v1/admin/usage returns usage_daily rows (cost is real, written by the llm-proxy cost
// pipeline). There is no per-org monthly CAP exposed over the API yet (only per-job
// monthly_budget_usd), so this renders the real month-to-date spend and never fabricates a
// percentage against an invented ceiling. Tolerant-degrade (ADR-017): no data / unauthorized
// (e.g. a non-admin caller) / backend down all render the same neutral "—", never a guessed
// number.
import { useEffect, useState } from "react";
import { Coins } from "lucide-react";
import { tryGet } from "@/lib/api";
import { cn } from "@/lib/utils";

interface UsageRow { day: string; cost_usd: number | string; }
interface UsagePage { items: UsageRow[]; }

type State = "loading" | "data" | "empty";

export function BudgetGauge() {
  const [state, setState] = useState<State>("loading");
  const [totalUsd, setTotalUsd] = useState(0);

  useEffect(() => {
    let stop = false;
    (async () => {
      const page = await tryGet<UsagePage>("/admin/usage", { items: [] });
      if (stop) return;
      if (page.items.length === 0) { setState("empty"); return; }
      const month = new Date().toISOString().slice(0, 7); // deterministic UTC YYYY-MM
      const sum = page.items
        .filter((r) => r.day?.startsWith(month))
        .reduce((acc, r) => acc + Number(r.cost_usd ?? 0), 0);
      setTotalUsd(sum);
      setState("data");
    })();
    return () => { stop = true; };
  }, []);

  return (
    <div
      className="flex flex-col gap-1.5 rounded-md border-l-2 border-cyan bg-panel-2 px-2.5 py-2.5 min-[860px]:px-3"
      title="Budget mensuel — dépense réelle du mois en cours"
    >
      <div className="flex items-center gap-1.5 text-muted-foreground">
        <Coins className="size-3.5 shrink-0" aria-hidden />
        <span className="hidden min-[860px]:inline text-[10px] font-medium uppercase tracking-wide">
          Budget ce mois
        </span>
      </div>
      <div className={cn("font-mono text-sm", state === "data" ? "text-foreground" : "text-muted-foreground")}>
        {state === "loading" && <span aria-live="polite">…</span>}
        {state === "data" && <span aria-live="polite">${totalUsd.toFixed(2)}</span>}
        {state === "empty" && <span aria-live="polite">—</span>}
      </div>
    </div>
  );
}
