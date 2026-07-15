// Left column of /chat (§4.3): real conversations from GET /api/v1/conversations. Cron-originated
// convos (channel === "scheduler", models.py Channel enum) get the ⟳ amber marker — this is a real
// backend field, never a client-side guess (ADR-017 spirit). Collapses under 860px (§4.2) since the
// center thread + right panel need the room; reachable again above that width.
import { Plus, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export interface ConversationSummary {
  id: string;
  channel: string;
  title: string | null;
  status: string;
  created_at: string;
}

export function ConversationList({ items, selectedId, onSelect, onNew, busy }: {
  items: ConversationSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  busy?: boolean;
}) {
  return (
    <aside className="hidden min-[860px]:flex h-full min-w-0 flex-col border-r border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-3">
        <span className="font-heading text-sm font-semibold tracking-tight text-foreground">Conversations</span>
        <Button size="icon" variant="outline" className="size-7" onClick={onNew} disabled={busy} title="Nouvelle conversation">
          <Plus className="size-3.5" />
        </Button>
      </div>
      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-1 p-2">
          {items.length === 0 && (
            <p className="p-2 text-xs italic text-muted-foreground">Aucune conversation.</p>
          )}
          {items.map((c) => {
            const scheduled = c.channel === "scheduler";
            const active = c.id === selectedId;
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => onSelect(c.id)}
                aria-current={active ? "true" : undefined}
                className={cn(
                  "flex w-full flex-col gap-0.5 rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                  active
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground"
                )}
              >
                <span className="flex items-center gap-1.5 truncate">
                  {scheduled && <Repeat className="size-3 shrink-0 text-amber" aria-hidden />}
                  <span className="truncate">{c.title || `Conversation ${c.id.slice(-6)}`}</span>
                </span>
                {scheduled && <span className="pl-[18px] font-mono text-[10px] text-amber/80">planifiée</span>}
              </button>
            );
          })}
        </div>
      </ScrollArea>
    </aside>
  );
}
