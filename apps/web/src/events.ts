// AgentEvent → UI view-model mapping (instructions.md §4.3, §7.4). Pure + testable:
// the React chat renders whatever this returns. Colour semantics are strict (§4.5):
// cyan = action/flow, amber = automations, rose = security/danger, green = success.

export type AgentEventType =
  | "agent.thinking" | "agent.text.delta" | "agent.tool.call" | "agent.tool.result"
  | "agent.approval.needed" | "agent.file.created" | "agent.cron.created"
  | "agent.escalated" | "agent.done" | "agent.error";

export interface AgentEvent { type: AgentEventType; seq: number; data?: Record<string, any>; }

export type Color = "cyan" | "amber" | "rose" | "green" | "muted";

export interface ViewModel {
  kind: "delta" | "tool" | "approval" | "cron" | "escalation" | "done" | "error" | "thinking" | "file";
  color: Color;
  text: string;
  interactive?: boolean; // renders Approve/Deny buttons
  monospace?: boolean;   // tool lines are IBM Plex Mono (§4.5)
  approvalId?: string;   // carried on approval rows so the card doesn't index back into events
}

// Map one AgentEvent to a view-model row (§4.3).
export function toViewModel(ev: AgentEvent, locale = "fr"): ViewModel {
  const d = ev.data ?? {};
  switch (ev.type) {
    case "agent.thinking":
      return { kind: "thinking", color: "muted", text: locale === "fr" ? "…réflexion" : "…thinking" };
    case "agent.text.delta":
      return { kind: "delta", color: "muted", text: String(d.text ?? "") };
    case "agent.tool.call":
      return { kind: "tool", color: "cyan", monospace: true,
        text: `→ ${d.tool}${d.args_summary ? " — " + d.args_summary : ""}` };
    case "agent.tool.result":
      return { kind: "tool", color: d.status === "error" ? "rose" : "green", monospace: true,
        text: `✓ ${d.tool} — ${d.result_summary ?? d.status ?? ""}` };
    case "agent.approval.needed":
      return { kind: "approval", color: "amber", interactive: true,
        approvalId: d.approval_id ? String(d.approval_id) : undefined,
        text: `${d.tool}${d.args_summary ? " — " + d.args_summary : ""}` };
    case "agent.cron.created":
      return { kind: "cron", color: "amber",
        text: `⟳ ${d.human_schedule ?? d.schedule ?? ""}${d.next_run_at ? " · " + d.next_run_at : ""}` };
    case "agent.escalated":
      return { kind: "escalation", color: "cyan",
        text: locale === "fr" ? "je regarde dans l'outil, un instant ⏳" : "checking a tool, one moment ⏳" };
    case "agent.file.created":
      return { kind: "file", color: "cyan", text: `📎 ${d.name ?? "fichier"}` };
    case "agent.done":
      return { kind: "done", color: "muted",
        text: `${(d.cost_usd ?? 0).toFixed ? "$" + Number(d.cost_usd ?? 0).toFixed(4) : ""}` };
    case "agent.error":
      return { kind: "error", color: "rose", text: String(d.message ?? d.code ?? "erreur") };
  }
}

// Stream resume (§2.3): each event carries a monotone `seq` per conversation. On
// reconnect the client resends its tracked `last_seq`; events with seq <= last_seq
// have already been applied and must be ignored (dedup of replayed/out-of-order
// events). Pure so it's testable without a live socket — the caller persists
// `lastSeq` (e.g. in a ref) across reconnects.
export function applyIncomingEvent(
  ev: AgentEvent,
  lastSeq: number,
): { accepted: AgentEvent | null; lastSeq: number } {
  if (ev.seq <= lastSeq) return { accepted: null, lastSeq };
  return { accepted: ev, lastSeq: ev.seq };
}

// Reduce a stream into ordered rows, coalescing text deltas into one bubble (§4.3).
export function reduceStream(events: AgentEvent[], locale = "fr"): ViewModel[] {
  const rows: ViewModel[] = [];
  for (const ev of [...events].sort((a, b) => a.seq - b.seq)) {
    const vm = toViewModel(ev, locale);
    const last = rows[rows.length - 1];
    if (vm.kind === "delta" && last && last.kind === "delta") {
      last.text += vm.text; // coalesce streaming tokens
    } else if (vm.kind === "thinking" && last) {
      continue; // thinking is transient once content arrives
    } else {
      rows.push(vm);
    }
  }
  return rows;
}
