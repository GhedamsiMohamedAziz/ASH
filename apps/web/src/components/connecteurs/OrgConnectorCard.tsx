// Org-included connector card (§2.5): infrastructure the organization provisions for every
// member — Browser, Database, Scheduler — not something a user connects themselves (§13.2/§14,
// personal-vs-platform connector distinction made explicit in the UI). `connection` carries real
// status when /me returns one (currently only "database"); `alwaysOn` connectors (Browser,
// Scheduler) have no per-user connect state at all — /me never lists them — so they render a
// static "inclus" badge instead of a fabricated connected/disconnected pair. That badge uses a
// neutral/outline style (not green) so it's never visually confused with the live "connecté"
// badge below — "inclus" is a static provisioning fact, not a fetched connection status.
import { Building2 } from "lucide-react";
import { identityTypeLabel } from "@/pages";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { PROVIDER_ICON, type Connection } from "./connectorMeta";

export function OrgConnectorCard({
  connection,
  alwaysOn = false,
}: {
  connection: Connection;
  alwaysOn?: boolean;
}) {
  const Icon = PROVIDER_ICON[connection.provider] ?? Building2;

  return (
    <Card className="border-border bg-card">
      <CardContent className="flex items-start gap-3 p-4">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-2 text-muted-foreground">
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="font-heading text-sm font-semibold text-foreground">{connection.label}</span>
          <span className="w-fit rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
            {identityTypeLabel(connection.provider)}
          </span>
          <span className="text-xs text-muted-foreground">Géré par votre organisation</span>
        </div>
        {alwaysOn ? (
          <Badge variant="outline" className="shrink-0 border-border text-muted-foreground">
            inclus
          </Badge>
        ) : connection.connected ? (
          <Badge variant="secondary" className="shrink-0 text-green">
            connecté
          </Badge>
        ) : (
          <Badge variant="outline" className="shrink-0 text-muted-foreground">
            non connecté
          </Badge>
        )}
      </CardContent>
    </Card>
  );
}
