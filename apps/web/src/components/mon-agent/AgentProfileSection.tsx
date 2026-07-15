// Profile selector (§2.6 "sélection du profil (dev / généraliste / data / ops)"). A real local
// choice — see agentConfig.ts header comment for why this is localStorage, not a fetched value.
import { useState, type ComponentType, type KeyboardEvent } from "react";
import { Check, Code2, Users, BarChart3, Wrench } from "lucide-react";
import { AGENT_PROFILES, getStoredProfile, setStoredProfile } from "./agentConfig";
import { cn } from "@/lib/utils";

const PROFILE_ICON: Record<string, ComponentType<{ className?: string }>> = {
  dev: Code2,
  generalist: Users,
  "data-analyst": BarChart3,
  ops: Wrench,
};

export function AgentProfileSection() {
  const [selected, setSelected] = useState(getStoredProfile);

  const choose = (id: string) => {
    setSelected(id);
    setStoredProfile(id);
  };

  const onKeyDown = (e: KeyboardEvent, index: number) => {
    if (!["ArrowRight", "ArrowLeft", "ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
    const next = (index + dir + AGENT_PROFILES.length) % AGENT_PROFILES.length;
    const el = document.getElementById(`profile-${AGENT_PROFILES[next].id}`);
    el?.focus();
  };

  return (
    <section aria-labelledby="mon-agent-profile-heading" className="flex flex-col gap-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="mon-agent-profile-heading" className="font-heading text-sm font-semibold uppercase tracking-wide text-foreground">
          Profil de l'agent
        </h2>
        <span className="font-mono text-[11px] text-muted-foreground">stocké sur cet appareil</span>
      </div>

      <div role="radiogroup" aria-label="Profil de l'agent" className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {AGENT_PROFILES.map((p, i) => {
          const Icon = PROFILE_ICON[p.id] ?? Code2;
          const active = p.id === selected;
          return (
            <button
              key={p.id}
              id={`profile-${p.id}`}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              onClick={() => choose(p.id)}
              onKeyDown={(e) => onKeyDown(e, i)}
              className={cn(
                "group flex flex-col gap-2 rounded-lg border bg-card px-3.5 py-3 text-left transition-colors",
                active ? "border-amber bg-amber/10" : "border-border hover:border-amber/40 hover:bg-panel-2"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn("flex size-7 items-center justify-center rounded-md", active ? "bg-amber/20 text-amber" : "bg-panel-2 text-muted-foreground")}>
                  <Icon className="size-4" aria-hidden />
                </span>
                {active && <Check className="size-4 shrink-0 text-amber" aria-hidden />}
              </div>
              <div className="flex flex-col gap-0.5">
                <span className={cn("font-heading text-sm font-semibold", active ? "text-foreground" : "text-foreground/90")}>
                  {p.label}
                </span>
                <span className="text-xs leading-snug text-muted-foreground">{p.description}</span>
              </div>
              <div className="mt-1 flex flex-wrap gap-1">
                {p.tools.map((t) => (
                  <span key={t} className="rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
              <span className="font-mono text-[10px] text-muted-foreground">
                modèle {p.defaultModel === "frontier" ? "frontier" : "éco"} par défaut
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
