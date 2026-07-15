// Route: /connecteurs (§2.5, §4.4). Two sections: the user's own connectable providers (GitHub,
// Microsoft 365, Slack, Notion — each with a "Connecter" PAT flow, ADR-019) and the org-included
// infrastructure connectors (Browser, Database, Scheduler) the platform already provisions
// (§13.2/§14 — personal vs platform connectors made explicit). Real data only: GET /api/v1/me,
// tolerant-degraded to the static provider list, all disconnected, when the backend/gateway is
// unreachable (ADR-017 §2.8) — never a fabricated "connected".
import { useCallback, useEffect, useState } from "react";
import { Plug } from "lucide-react";
import { useShell } from "@/components/shell/AppShell";
import { tryGet } from "@/lib/api";
import { ConnectorCard } from "@/components/connecteurs/ConnectorCard";
import { OrgConnectorCard } from "@/components/connecteurs/OrgConnectorCard";
import {
  ORG_PROVIDER_IDS,
  USER_PROVIDER_IDS,
  resolveConnectors,
  type Connection,
} from "@/components/connecteurs/connectorMeta";

export function ConnecteursPage() {
  const { identityKey } = useShell();
  const [live, setLive] = useState<Connection[]>([]);
  const [degraded, setDegraded] = useState(false);

  const load = useCallback(async () => {
    const me = await tryGet<{ connections: Connection[] }>("/me", { connections: [] });
    setLive(me.connections);
    // /me always returns the full known provider list (backend-core's _PROVIDERS) when reachable,
    // so an empty array only happens via tryGet's degrade fallback — a reliable signal that the
    // backend/gateway was unreachable, not that the user genuinely has zero connectors.
    setDegraded(me.connections.length === 0);
  }, []);

  useEffect(() => {
    load();
  }, [load, identityKey]);

  const userConnectors = resolveConnectors(USER_PROVIDER_IDS, live);
  const orgConnectors = resolveConnectors(ORG_PROVIDER_IDS, live);

  return (
    <div className="h-full overflow-y-auto p-6">
      <div className="mx-auto flex max-w-4xl flex-col gap-8">
        <div className="flex flex-col gap-1.5">
          <h1 className="flex items-center gap-2 font-heading text-lg font-semibold tracking-tight text-foreground">
            <Plug className="size-5 text-cyan" aria-hidden /> Connecteurs
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Statut par connecteur, type d'identité utilisé, et connecteurs fournis par votre organisation.
          </p>
          {degraded && (
            <p
              className="mt-1 w-fit rounded-md border border-rose/30 bg-rose/10 px-3 py-1.5 text-xs text-rose"
              role="status"
            >
              Service de connecteurs injoignable — affichage hors-ligne, tous les statuts sont à « non connecté ».
            </p>
          )}
        </div>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Vos connecteurs
            </h2>
            <p className="text-xs text-muted-foreground">
              Connectez vos comptes personnels pour que l'agent agisse avec vos autorisations.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {userConnectors.map((c) => (
              <ConnectorCard key={c.provider} connection={c} onConnected={load} />
            ))}
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Inclus par votre organisation
            </h2>
            <p className="text-xs text-muted-foreground">
              Infrastructure fournie et gérée par votre organisation — rien à connecter ici.
            </p>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {orgConnectors.map((c) => (
              <OrgConnectorCard key={c.provider} connection={c} alwaysOn={c.provider !== "database"} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
