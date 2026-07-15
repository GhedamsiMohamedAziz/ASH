// Canaux liés (§2.6): the `identities` table (db/migrations/0001_init.sql, §16.1) maps
// provider ∈ {entra, slack, web} + external_id → a canonical user_id. There is no HTTP route that
// lists this table today (auth-service's linking.py implements the OIDC-linking token machinery
// but main.py never exposes it), so this renders REAL, currently-knowable state rather than a
// guess: the web channel is definitionally linked (you're using it right now, on this session's
// user_id), Slack/Teams are honestly "non lié" with a disabled linking affordance until the
// backend cutover lands.
import { Globe, MessageSquare, Building2, Link2, Check } from "lucide-react";
import type { ComponentType } from "react";
import { SectionCard } from "./SectionCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { channelRows, type ChannelProvider } from "./identity";

const PROVIDER_ICON: Record<ChannelProvider, ComponentType<{ className?: string }>> = {
  web: Globe,
  slack: MessageSquare,
  entra: Building2,
};

export function ChannelsSection({ userId }: { userId: string | null }) {
  const rows = channelRows();

  return (
    <SectionCard
      icon={Link2}
      title="Canaux liés"
      description="Association canal → identité (table identities, §16.1)."
    >
      <div className="flex flex-col gap-2">
        {rows.map((row) => {
          const Icon = PROVIDER_ICON[row.provider];
          return (
            <div
              key={row.provider}
              className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 text-sm text-card-foreground">{row.label}</span>
              </div>
              <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
                {row.linked ? (
                  <Badge variant="secondary" className="flex items-center gap-1 text-green">
                    <Check className="size-3" /> lié{userId ? ` · ${userId}` : ""}
                  </Badge>
                ) : (
                  <>
                    <Badge variant="outline" className="text-muted-foreground">non lié</Badge>
                    <Button size="sm" variant="outline" disabled title="Bientôt disponible">
                      Lier via OIDC
                    </Button>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Seul le canal Web est réellement branché aujourd'hui (c'est la session en cours). Le
        branchement OIDC réel Slack / Entra ID → utilisateur canonique n'est pas encore exposé
        côté backend — le bouton « Lier » reste désactivé jusqu'à ce cutover.
      </p>
    </SectionCard>
  );
}
