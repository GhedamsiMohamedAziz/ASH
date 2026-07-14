// Web chat (instructions.md §4.3, §7.3) — the only true token-by-token channel.
// Subscribes to /stream over WebSocket, maps AgentEvents via the tested reducer,
// renders with the strict colour semantics (§4.5). Approval cards POST /approve.
import React, { useEffect, useState } from "react";
import { reduceStream, type AgentEvent, type ViewModel } from "./events.ts";
import "./tokens.css";

// A sample turn so the UI renders without a backend (dev/demo). Shows the §4.3
// mapping: streamed text, a cyan tool line, an amber approval card, a done row.
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

export function Chat({ conversationId, locale = "fr", demo = false }:
  { conversationId: string; locale?: string; demo?: boolean }) {
  const [events, setEvents] = useState<AgentEvent[]>(demo ? DEMO_EVENTS : []);
  const [connected, setConnected] = useState(false);
  const rows: ViewModel[] = reduceStream(events, locale);

  useEffect(() => {
    if (demo) return; // demo mode: no backend
    try {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/api/v1/conversations/${conversationId}/stream`);
      ws.onopen = () => { setConnected(true); ws.send(JSON.stringify({ type: "subscribe", last_seq: 0 })); };
      ws.onmessage = (m) => setEvents((prev) => [...prev, JSON.parse(m.data) as AgentEvent]);
      ws.onclose = () => setConnected(false);
      ws.onerror = () => setConnected(false);
      return () => ws.close();
    } catch { /* backend not up — stays empty */ }
  }, [conversationId, demo]);

  const approve = (approvalId: string, decision: "approve" | "deny") =>
    fetch(`/api/v1/conversations/${conversationId}/approve`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ approval_id: approvalId, decision }),
    });

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Axone</span>
        <span className="conv">{conversationId}</span>
        <span className={`status ${demo ? "amber" : connected ? "green" : "muted"}`}>
          {demo ? "démo" : connected ? "connecté" : "hors ligne"}
        </span>
      </header>
      <div className="chat">
        {rows.length === 0 && (
          <div className="row muted empty">Aucun message. Le backend n'est pas connecté.</div>
        )}
        {rows.map((r, i) => (
          <div key={i} className={`row ${r.color} ${r.monospace ? "mono" : ""}`}>
            {r.interactive ? (
              <div className="approval-card">
                <span className="approval-title">⚠ Approbation requise</span>
                <span className="approval-body">{r.text}</span>
                <div className="approval-actions">
                  <button className="btn approve" onClick={() => approve((events[i].data as any)?.approval_id, "approve")}>Approuver</button>
                  <button className="btn deny" onClick={() => approve((events[i].data as any)?.approval_id, "deny")}>Refuser</button>
                </div>
              </div>
            ) : (r.text)}
          </div>
        ))}
      </div>
      <footer className="composer">
        <input placeholder="Écris un message…" />
        <span className="hint">budget du tour · approbation avant toute action sensible</span>
      </footer>
    </div>
  );
}
