// Fixed left sidebar (§4.2): 5 routes + permanent budget gauge. Icon-only (64px) under 860px,
// expanded (240px) at/above it — the same breakpoint the conversation list uses, so the sidebar
// and the conversation list collapse together (§4.2 "sidebar réduite à 64 px et liste de
// conversations repliée sous 860 px").
import { NavLink } from "react-router-dom";
import { ROUTES } from "../../routes/index.ts";
import { BudgetGauge } from "./BudgetGauge.tsx";
import { cn } from "@/lib/utils";

export function Sidebar() {
  return (
    <nav
      aria-label="Navigation principale"
      className="flex w-16 min-[860px]:w-60 shrink-0 flex-col border-r border-border bg-panel"
    >
      <div className="flex h-14 shrink-0 items-center justify-center border-b border-border min-[860px]:justify-start min-[860px]:px-4">
        <span className="font-heading text-lg font-bold text-cyan min-[860px]:hidden" aria-hidden>A</span>
        <span className="hidden font-heading text-lg font-bold tracking-tight text-foreground min-[860px]:inline">
          Axone
        </span>
      </div>

      <ul className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
        {ROUTES.map(({ path, label, icon: Icon, automation }) => (
          <li key={path}>
            <NavLink
              to={`/${path}`}
              title={label}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium transition-colors",
                  "justify-center min-[860px]:justify-start",
                  isActive
                    ? automation
                      ? "bg-amber/10 text-amber"
                      : "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                )
              }
            >
              <Icon className={cn("size-4 shrink-0", automation && "text-amber")} />
              <span className="hidden truncate min-[860px]:inline">{label}</span>
            </NavLink>
          </li>
        ))}
      </ul>

      <div className="shrink-0 border-t border-border p-2 min-[860px]:p-3">
        <BudgetGauge />
      </div>
    </nav>
  );
}
