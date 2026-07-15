// Route: /mon-agent (§2.6, §4.4) — automation-accented page, amber lead (§4.5). Composes three
// honest sections: a local (localStorage) agent-profile pick, a read-only preview of the org's
// real tool_policies matrix, and the live GET /api/v1/automations list with pause/resume. See
// components/mon-agent/agentConfig.ts for exactly which parts are real/fetched vs. local/derived.
import { useShell } from "@/components/shell/AppShell";
import { AgentProfileSection } from "@/components/mon-agent/AgentProfileSection";
import { ApprovalPoliciesSection } from "@/components/mon-agent/ApprovalPoliciesSection";
import { AutomationsSection } from "@/components/mon-agent/AutomationsSection";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { RotateCw } from "lucide-react";

export function MonAgentPage() {
  const { identityKey } = useShell();

  return (
    <ScrollArea className="h-full">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <span className="flex size-8 items-center justify-center rounded-md bg-amber/10 text-amber">
              <RotateCw className="size-4" aria-hidden />
            </span>
            <h1 className="font-heading text-xl font-bold tracking-tight text-foreground">Mon agent</h1>
          </div>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Le profil qui pilote votre agent, la politique d'approbation appliquée par votre
            organisation, et vos automatisations planifiées.
          </p>
        </header>

        <AgentProfileSection />
        <Separator />
        <ApprovalPoliciesSection />
        <Separator />
        <AutomationsSection refreshKey={identityKey} />
      </div>
    </ScrollArea>
  );
}
