// Web chat (§4.3, §7.3) — shadcn/ui. Subscribes to /stream over WebSocket, maps AgentEvents via
// the tested reducer, renders with the §4.5 colour semantics. Approval cards POST /approve.
import React, { useEffect, useRef, useState } from "react";
import { reduceStream, applyIncomingEvent, type AgentEvent, type ViewModel } from "./events.ts";
import { authHeaders } from "./auth.ts";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  ShieldAlert, SendHorizontal, Wrench, CheckCircle2, XCircle, Clock,
  Loader2, Plus, Repeat, Coins,
} from "lucide-react";

const DEMO_EVENTS: AgentEvent[] = [
  { type: "agent.thinking", seq: 1 },
  { type: "agent.text.delta", seq: 2, data: { text: "Je m'occupe du déploiement de " } },
  { type: "agent.text.delta", seq: 3, data: { text: "fix/login sur staging." } },
  { type: "agent.tool.call", seq: 4, data: { tool: "github.create_pr", args_summary: "fix/login → main" } },
  { type: "agent.tool.result", seq: 5, data: { tool: "github.create_pr", status: "ok", result_summary: "PR #42 ouverte" } },
  { type: "agent.approval.needed", seq: 6, data: { approval_id: "appr_1", tool: "github.merge_pr", args_summary: "PR #42" } },
  { type: "agent.cron.created", seq: 7, data: { human_schedule: "chaque lundi 9h", next_run_at: "2026-07-20 09:00" } },
  { type: "agent.done", seq: 8, data: { cost_usd: 0.0184 } },
];

// One rendered row, styled by its kind (agent answer = bubble; tool = compact icon line; etc.).
function Row({ r, latencyMs }: { r: ViewModel; latencyMs?: number }) {
  switch (r.kind) {
    case "delta":
      return (
        <div className="max-w-[90%] whitespace-pre-wrap rounded-lg border bg-card px-3 py-2 text-sm leading-relaxed text-card-foreground">
          {r.text}
        </div>
      );
    case "tool": {
      const ok = r.color === "green";
      const bad = r.color === "rose";
      const Icon = ok ? CheckCircle2 : bad ? XCircle : Wrench;
      const tone = ok ? "text-green" : bad ? "text-rose" : "text-cyan";
      return (
        <div className={`flex items-center gap-2 font-mono text-xs ${tone}`}>
          <Icon className="size-3.5 shrink-0" /> {r.text}
        </div>
      );
    }
    case "cron":
      return (
        <div className="flex items-center gap-2 text-xs text-amber">
          <Repeat className="size-3.5 shrink-0" /> {r.text}
        </div>
      );
    case "escalation":
      return <div className="text-xs italic text-cyan">{r.text}</div>;
    case "done":
      return (r.text || latencyMs != null) ? (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
          <Coins className="size-3.5" /> <span className="font-mono">{r.text}</span>
          {latencyMs != null && <span className="font-mono">· {Math.round(latencyMs)} ms</span>}
        </div>
      ) : null;
    case "error":
      return (
        <div className="flex items-center gap-2 text-sm text-rose">
          <XCircle className="size-4 shrink-0" /> {r.text}
        </div>
      );
    default:
      return <div className="text-xs text-muted-foreground">{r.text}</div>;
  }
}

export function Chat({ conversationId, locale = "fr", demo = false, onNew }:
  { conversationId: string; locale?: string; demo?: boolean; onNew?: () => void }) {
  const [events, setEvents] = useState<AgentEvent[]>(demo ? DEMO_EVENTS : []);
  const [userMsgs, setUserMsgs] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);
  const [running, setRunning] = useState(false);
  const [input, setInput] = useState("");
  const [latencies, setLatencies] = useState<Record<number, number>>({});
  const bottomRef = useRef<HTMLDivElement>(null);
  const sentAtRef = useRef<number[]>([]); // wall-clock start per turn index
  const doneCountRef = useRef(0);         // how many agent.done have completed → turn index
  const lastSeqRef = useRef(0);           // highest seq applied so far, persists across reconnects (§2.3)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [events.length, userMsgs.length, running]);

  // Segment agent events into turns (each ends with agent.done) so each user message renders
  // above the response it triggered — an in-flight turn is the trailing, not-yet-done segment.
  const turns: AgentEvent[][] = [];
  let cur: AgentEvent[] = [];
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    cur.push(ev);
    if (ev.type === "agent.done") { turns.push(cur); cur = []; }
  }
  if (cur.length) turns.push(cur);
  const turnCount = Math.max(turns.length, userMsgs.length);

  useEffect(() => {
    if (demo) return;
    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/v1/conversations/${conversationId}/stream`);
      ws.onopen = () => {
        setConnected(true);
        // Resume from where we left off (§2.3): server skips/replays are deduped below.
        ws.send(JSON.stringify({ type: "subscribe", last_seq: lastSeqRef.current }));
      };
      ws.onmessage = (m) => {
        const ev = JSON.parse(m.data) as AgentEvent;
        const { accepted, lastSeq } = applyIncomingEvent(ev, lastSeqRef.current);
        lastSeqRef.current = lastSeq;
        if (!accepted) return; // seq <= last_seq: duplicate/stale replay, ignore
        setEvents((prev) => [...prev, accepted]);
        if (accepted.type === "agent.done") {
          setRunning(false);
          const idx = doneCountRef.current++;      // this done closes turn `idx`
          const start = sentAtRef.current[idx];
          if (start !== undefined)
            setLatencies((prev) => ({ ...prev, [idx]: performance.now() - start }));
        }
      };
      ws.onclose = () => setConnected(false);
      ws.onerror = () => setConnected(false);
      return () => ws.close();
    } catch { /* backend not up */ }
  }, [conversationId, demo]);

  const approve = (approvalId: string, decision: "approve" | "deny") =>
    fetch(`/api/v1/conversations/${conversationId}/approve`, {
      method: "POST", headers: authHeaders({ "content-type": "application/json" }),
      body: JSON.stringify({ approval_id: approvalId, decision }),
    });

  const send = () => {
    const text = input.trim();
    if (!text || demo) return;
    setInput("");
    sentAtRef.current[userMsgs.length] = performance.now(); // start the clock for this turn
    setUserMsgs((m) => [...m, text]);
    setRunning(true);
    fetch(`/api/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: authHeaders({ "content-type": "application/json", "Idempotency-Key": crypto.randomUUID() }),
      body: JSON.stringify({ text }),
    }).catch(() => setRunning(false));
  };

  const statusBadge = demo
    ? <Badge variant="secondary" className="text-amber">démo</Badge>
    : connected
      ? <Badge variant="secondary" className="text-green">connecté</Badge>
      : <Badge variant="outline" className="text-muted-foreground">hors ligne</Badge>;

  return (
    <div className="flex h-full min-w-0 flex-col border-r border-border bg-background">
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span className="font-mono text-xs text-muted-foreground">{conversationId}</span>
        <div className="ml-auto flex items-center gap-2">
          {statusBadge}
          {onNew && !demo && (
            <Button size="sm" variant="outline" onClick={onNew} title="Nouvelle conversation">
              <Plus className="size-4" /> Nouveau
            </Button>
          )}
        </div>
      </header>

      <ScrollArea className="flex-1">
        <div className="flex flex-col gap-2 p-4">
          {turnCount === 0 && !running && (
            <div className="mt-8 flex flex-col items-center gap-2 text-center text-muted-foreground">
              <ShieldAlert className="size-6 opacity-50" />
              <p className="italic">
                {demo ? "Mode démo — tour d'exemple."
                  : connected ? "Écris un message pour lancer un tour."
                  : "Backend hors ligne."}
              </p>
              {connected && !demo && (
                <p className="text-xs opacity-70">essaie : « merge la PR 42 » pour voir la boucle d'approbation</p>
              )}
            </div>
          )}
          {Array.from({ length: turnCount }).map((_, ti) => (
            <React.Fragment key={ti}>
              {userMsgs[ti] !== undefined && (
                <div className="max-w-[85%] self-end rounded-lg bg-primary px-3 py-2 text-sm text-primary-foreground">
                  {userMsgs[ti]}
                </div>
              )}
              {(turns[ti] ? reduceStream(turns[ti], locale) : []).map((r: ViewModel, ri: number) => (
                r.interactive ? (
                  <Card key={`${ti}-${ri}`} className="border-amber/40 bg-amber/5">
                    <CardContent className="flex flex-col gap-3 p-3">
                      <div className="flex items-center gap-2 font-medium text-amber">
                        <ShieldAlert className="size-4" /> Approbation requise
                      </div>
                      <p className="font-mono text-sm">{r.text}</p>
                      <div className="flex gap-2">
                        <Button size="sm" className="bg-green text-ink hover:bg-green/90"
                          disabled={!r.approvalId}
                          onClick={() => r.approvalId && approve(r.approvalId, "approve")}>Approuver</Button>
                        <Button size="sm" variant="destructive"
                          disabled={!r.approvalId}
                          onClick={() => r.approvalId && approve(r.approvalId, "deny")}>Refuser</Button>
                      </div>
                    </CardContent>
                  </Card>
                ) : (
                  <Row key={`${ti}-${ri}`} r={r} latencyMs={r.kind === "done" ? latencies[ti] : undefined} />
                )
              ))}
            </React.Fragment>
          ))}
          {running && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> l'agent travaille…
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      <footer className="flex flex-wrap items-center gap-2 border-t p-3">
        <Input
          placeholder={demo ? "Mode démo" : "Écris un message… (Entrée pour envoyer)"}
          value={input} disabled={demo}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") send(); }}
          className="flex-1"
        />
        <Button onClick={send} disabled={demo || !input.trim() || running}>
          {running ? <Loader2 className="size-4 animate-spin" /> : <SendHorizontal className="size-4" />} Envoyer
        </Button>
        <p className="basis-full text-xs text-muted-foreground">
          budget du tour · approbation avant toute action sensible
        </p>
      </footer>
    </div>
  );
}
