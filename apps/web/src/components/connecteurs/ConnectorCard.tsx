// User-connectable connector card (§2.5): personal connectors the user links themselves — GitHub,
// Microsoft 365, Slack, Notion. Shows real status from /me and the static identity-type chip
// (§14, via pages.ts identityTypeLabel), and — when not connected — an inline "Connecter" form
// that POSTs a pasted token to /api/v1/connect and re-fetches /me on success so the badge only
// ever flips off real data (never optimistic, mirrors the real dev-connect path per ADR-019).
import { useState } from "react";
import { Check, Loader2, Plug, XCircle } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { identityTypeLabel } from "@/pages";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { PROVIDER_ICON, type Connection } from "./connectorMeta";

export function ConnectorCard({
  connection,
  onConnected,
}: {
  connection: Connection;
  onConnected: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const Icon = PROVIDER_ICON[connection.provider] ?? Plug;

  const start = () => {
    setOpen(true);
    setToken("");
    setError(null);
  };
  const cancel = () => {
    setOpen(false);
    setToken("");
    setError(null);
  };

  // POST the PAT to the backend proxy (§13.4/ADR-019). backend-core's /connect never throws — it
  // returns 200 {connected:false} when the gateway/token is bad — so both the "soft" failure
  // shape and a hard ApiError/network failure need a message here (§21 style).
  const confirm = async () => {
    const pat = token.trim();
    if (!pat || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<{ connected: boolean; provider: string }>("/connect", {
        provider: connection.provider,
        token: pat,
      });
      if (!res.connected) {
        setError("Échec de la connexion — vérifiez le jeton.");
        return;
      }
      setToken("");
      setOpen(false);
      onConnected(); // re-fetch /me — the badge flips to "connecté" from real data
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Serveur injoignable.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="border-border bg-card transition-colors hover:border-cyan/40 focus-within:border-cyan/40">
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border bg-panel-2 text-muted-foreground">
            <Icon className="size-4" aria-hidden />
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="font-heading text-sm font-semibold text-foreground">{connection.label}</span>
            <span className="w-fit rounded border border-border bg-panel-2 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
              {identityTypeLabel(connection.provider)}
            </span>
          </div>
          {connection.connected ? (
            <Badge variant="secondary" className="shrink-0 text-green">
              connecté
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 text-muted-foreground">
              non connecté
            </Badge>
          )}
        </div>

        {!connection.connected && !open && (
          <Button size="sm" variant="outline" className="w-fit" onClick={start}>
            <Plug className="size-3.5" aria-hidden /> Connecter
          </Button>
        )}

        {!connection.connected && open && (
          <div className="flex flex-col gap-2 border-t border-border pt-3">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`connecteur-token-${connection.provider}`}
            >
              Jeton d'accès personnel (PAT)
            </label>
            <div className="flex items-center gap-2">
              <Input
                id={`connecteur-token-${connection.provider}`}
                type="password"
                autoFocus
                placeholder="ghp_… / xoxb-… / secret_…"
                value={token}
                disabled={busy}
                onChange={(e) => setToken(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") confirm();
                  if (e.key === "Escape") cancel();
                }}
                className="flex-1"
              />
              <Button size="sm" onClick={confirm} disabled={busy || !token.trim()}>
                {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Check className="size-3.5" aria-hidden />}
                Valider
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>
                Annuler
              </Button>
            </div>
            {error && (
              <p className="flex items-center gap-1.5 text-xs text-rose" role="alert">
                <XCircle className="size-3.5 shrink-0" aria-hidden /> {error}
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
