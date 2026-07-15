// Right-hand control-room panel (§4.4): a tabbed surface exposing the three governance views —
// the live audit trail, the agent's persisted memories, and the connector inventory. shadcn/ui
// Tabs over @radix-ui/react-tabs; dark control-room aesthetic (§4.5). Pure mapping for memories
// reuses groupMemories from pages.ts (tested).
import React, { useEffect, useState } from "react";
import { AuditPanel } from "./AuditPanel.tsx";
import { groupMemories, identityTypeLabel, type MemoryItem } from "./pages.ts";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { authHeaders } from "./auth.ts";
import {
  Brain, Plug, GitBranch, MessageSquare, FileText, Database, Building2, Link2,
  Check, XCircle, Loader2,
} from "lucide-react";

// ---- Mémoires -------------------------------------------------------------------------------
interface Memory extends MemoryItem { source_trust?: string }

function TrustBadge({ trust }: { trust?: string }) {
  if (trust === "untrusted")
    return <Badge variant="secondary" className="text-amber-400">non fiable</Badge>;
  return <Badge variant="outline" className="text-muted-foreground">fiable</Badge>;
}

function MemoriesTab() {
  const [memories, setMemories] = useState<Memory[] | null>(null);

  useEffect(() => {
    let stop = false;
    const pull = () =>
      fetch("/api/v1/memories")
        .then((r) => r.json())
        .then((j) => { if (!stop) setMemories((j.memories as Memory[]) ?? []); })
        .catch(() => { if (!stop) setMemories((prev) => prev ?? []); });
    pull();
    const iv = setInterval(pull, 3000);
    return () => { stop = true; clearInterval(iv); };
  }, []);

  const list = memories ?? [];
  // groupMemories only reads {id,content,kind}; carry source_trust in a side lookup.
  const trustById = new Map(list.map((m) => [m.id, m.source_trust]));
  const groups = groupMemories(list.map((m) => ({ id: m.id, content: m.content, kind: m.kind })));

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-4 p-3">
        {list.length === 0 && (
          <p className="italic text-muted-foreground">Aucune mémoire enregistrée pour l'instant.</p>
        )}
        {groups.map((g) => (
          <div key={g.kind} className="flex flex-col gap-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {g.label}
            </div>
            {g.items.map((m) => (
              <div key={m.id} className="flex items-start justify-between gap-2 rounded-md border bg-card px-3 py-2">
                <span className="text-sm leading-relaxed text-card-foreground">{m.content}</span>
                <TrustBadge trust={trustById.get(m.id)} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

// ---- Connecteurs ----------------------------------------------------------------------------
interface Connection { provider: string; connected: boolean; label: string }

const PROVIDER_ICON: Record<string, React.ComponentType<{ className?: string }>> = {
  github: GitBranch, slack: MessageSquare, notion: FileText, database: Database, m365: Building2,
};

function ConnectorsTab() {
  const [connections, setConnections] = useState<Connection[] | null>(null);
  const [openProvider, setOpenProvider] = useState<string | null>(null); // which inline editor is open
  const [token, setToken] = useState("");        // held only while the editor is open; cleared on send
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Fetch the current identity's connections. authHeaders() adds a Bearer token when one exists in
  // localStorage; absent → the request is identical to before and the backend falls back to usr_dev.
  const load = (assign: (list: Connection[]) => void) =>
    fetch("/api/v1/me", { headers: authHeaders() })
      .then((r) => r.json())
      .then((j) => assign((j.connections as Connection[]) ?? []));

  useEffect(() => {
    let stop = false;
    load((l) => { if (!stop) setConnections(l); }).catch(() => { if (!stop) setConnections([]); });
    return () => { stop = true; };
  }, []);

  const startConnect = (provider: string) => { setOpenProvider(provider); setToken(""); setError(null); };
  const cancel = () => { setOpenProvider(null); setToken(""); setError(null); };

  // POST the PAT to the backend proxy, then re-fetch /api/v1/me so the badge flips to "connecté".
  // The token never leaves local scope beyond this request and is dropped from state on success.
  const confirm = async (provider: string) => {
    const pat = token.trim();
    if (!pat || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/v1/connect", {
        method: "POST",
        headers: authHeaders({ "content-type": "application/json" }),
        body: JSON.stringify({ provider, token: pat }),
      });
      if (!res.ok) { setError("Échec de la connexion — vérifie le jeton."); return; }
      setToken("");            // drop the PAT as soon as it has been sent
      setOpenProvider(null);
      await load(setConnections); // re-fetch → badge flips to "connecté"
    } catch {
      setError("Serveur injoignable.");
    } finally {
      setBusy(false);
    }
  };

  const list = connections ?? [];

  return (
    <ScrollArea className="h-full">
      <div className="flex flex-col gap-3 p-3">
        {list.length === 0 && (
          <p className="italic text-muted-foreground">Aucun connecteur disponible.</p>
        )}
        {list.map((c) => {
          const Icon = PROVIDER_ICON[c.provider] ?? Plug;
          const open = openProvider === c.provider;
          return (
            <div key={c.provider} className="flex flex-col gap-2 rounded-md border bg-card px-3 py-2">
              <div className="flex items-center gap-2">
                <Icon className="size-4 text-muted-foreground" />
                <span className="text-sm text-card-foreground">{c.label}</span>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {identityTypeLabel(c.provider)}
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {c.connected ? (
                    <Badge variant="secondary" className="text-emerald-400">connecté</Badge>
                  ) : (
                    <>
                      <Badge variant="outline" className="text-muted-foreground">non connecté</Badge>
                      {!open && (
                        <Button size="sm" variant="outline" onClick={() => startConnect(c.provider)}>
                          <Plug className="size-3.5" /> Connecter
                        </Button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {open && !c.connected && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      autoFocus
                      placeholder="Jeton d'accès (PAT)"
                      value={token}
                      disabled={busy}
                      onChange={(e) => setToken(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") confirm(c.provider);
                        if (e.key === "Escape") cancel();
                      }}
                      className="flex-1"
                    />
                    <Button size="sm" onClick={() => confirm(c.provider)} disabled={busy || !token.trim()}>
                      {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Valider
                    </Button>
                    <Button size="sm" variant="ghost" onClick={cancel} disabled={busy}>Annuler</Button>
                  </div>
                  {error && (
                    <p className="flex items-center gap-1.5 text-xs text-rose-400">
                      <XCircle className="size-3.5 shrink-0" /> {error}
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <Link2 className="size-3.5 shrink-0" /> Connexion par jeton (PAT) disponible dès maintenant ; l'OAuth arrivera plus tard.
        </p>
      </div>
    </ScrollArea>
  );
}

// ---- Shell ----------------------------------------------------------------------------------
export function RightPanel({ conversationId, live = true }:
  { conversationId?: string; live?: boolean }) {
  return (
    <div className="flex h-full min-w-0 flex-col bg-background">
      <Tabs defaultValue="audit" className="flex h-full min-h-0 flex-col">
        <div className="border-b px-3 py-2">
          <TabsList className="w-full">
            <TabsTrigger value="audit" className="flex-1">Audit</TabsTrigger>
            <TabsTrigger value="memories" className="flex-1"><Brain className="size-3.5" /> Mémoires</TabsTrigger>
            <TabsTrigger value="connectors" className="flex-1"><Plug className="size-3.5" /> Connecteurs</TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="audit" className="min-h-0 flex-1">
          <AuditPanel conversationId={conversationId} live={live} />
        </TabsContent>
        <TabsContent value="memories" className="min-h-0 flex-1">
          <MemoriesTab />
        </TabsContent>
        <TabsContent value="connectors" className="min-h-0 flex-1">
          <ConnectorsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
