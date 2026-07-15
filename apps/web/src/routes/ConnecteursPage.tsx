// Route: /connecteurs (§2.5, §4.4). Two sections: the user's own connectable providers (GitHub,
// Microsoft 365, Slack, Notion — each with a "Connecter" PAT flow, ADR-019) and the org-included
// infrastructure connectors (Browser, Database, Scheduler) the platform already provisions
// (§13.2/§14 — personal vs platform connectors made explicit). Real data only: GET /api/v1/me,
// tolerant-degraded to the static provider list, all disconnected, when the backend/gateway is
// unreachable (ADR-017 §2.8) — never a fabricated "connected".
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Check, Plug, XCircle } from "lucide-react";
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

// Human-readable copy for the ?error=<code> the OAuth callback bounces back on failure (oauth.py).
const OAUTH_ERROR_LABEL: Record<string, string> = {
  bad_state: "Session de connexion expirée ou invalide — réessayez.",
  provider_error: "Le fournisseur a refusé l'autorisation.",
  exchange_failed: "Échec de l'échange du code d'autorisation.",
  no_token: "Le fournisseur n'a renvoyé aucun jeton.",
  store_failed: "Jeton reçu mais impossible à enregistrer — réessayez.",
};

export function ConnecteursPage() {
  const { identityKey } = useShell();
  const [live, setLive] = useState<Connection[]>([]);
  const [degraded, setDegraded] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  // OAuth return state (§13.4): the callback bounces to /connecteurs?connected=<p> | ?error=<code>.
  const [oauthResult, setOauthResult] = useState<
    { ok: true; provider: string } | { ok: false; message: string } | null
  >(null);

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

  // On return from an OAuth handshake, surface the outcome, re-fetch /me so the badge flips off
  // real data, then strip the query params so a refresh doesn't re-show the toast.
  useEffect(() => {
    const connected = searchParams.get("connected");
    const error = searchParams.get("error");
    if (!connected && !error) return;
    if (connected) {
      setOauthResult({ ok: true, provider: connected });
      load();
    } else if (error) {
      setOauthResult({ ok: false, message: OAUTH_ERROR_LABEL[error] ?? "Échec de la connexion." });
    }
    setSearchParams({}, { replace: true });
  }, [searchParams, setSearchParams, load]);

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
          {oauthResult?.ok && (
            <p
              className="mt-1 flex w-fit items-center gap-1.5 rounded-md border border-green/30 bg-green/10 px-3 py-1.5 text-xs text-green"
              role="status"
            >
              <Check className="size-3.5 shrink-0" aria-hidden /> Connecté à {oauthResult.provider} avec succès.
            </p>
          )}
          {oauthResult && !oauthResult.ok && (
            <p
              className="mt-1 flex w-fit items-center gap-1.5 rounded-md border border-rose/30 bg-rose/10 px-3 py-1.5 text-xs text-rose"
              role="alert"
            >
              <XCircle className="size-3.5 shrink-0" aria-hidden /> {oauthResult.message}
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
