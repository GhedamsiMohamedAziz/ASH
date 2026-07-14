// Audit view (§16.1, §4.4) — the governance moat made visible. Renders the gateway's audit
// trail with the §4.5 colour semantics: who acted, on whose behalf (Mode B), the tool, the
// allow/deny/approval verdict, and any DLP-redacted secret categories. Pure mapping lives in
// pages.ts (tested); this is presentation only.
import React from "react";
import { auditRow, auditSummary, type AuditEntry } from "./pages.ts";
import "./tokens.css";

// A sample trail so the panel renders without a backend — mirrors the governance demo:
// search (ok) → create_pr on-behalf-of (Mode B) → a read whose output DLP scrubbed →
// merge_pr gated (needs_approval) then allowed after re-mint → a denied tool.
const DEMO_AUDIT: AuditEntry[] = [
  { ts: 1784283901, actor: "usr_dev", on_behalf_of: null, action: "tool.call", tool: "github.search", status: "ok", redacted: [] },
  { ts: 1784283903, actor: "agent-org@org_1", on_behalf_of: "usr_mehdi", action: "tool.call", tool: "github.create_pr", status: "ok", redacted: [] },
  { ts: 1784283905, actor: "usr_dev", on_behalf_of: null, action: "tool.call", tool: "github.read", status: "ok", redacted: ["github_token"] },
  { ts: 1784283907, actor: "usr_dev", on_behalf_of: null, action: "tool.call", tool: "github.merge_pr", status: "needs_approval", redacted: [] },
  { ts: 1784283911, actor: "usr_dev", on_behalf_of: null, action: "tool.call", tool: "github.merge_pr", status: "ok", redacted: [] },
  { ts: 1784283913, actor: "usr_dev", on_behalf_of: null, action: "tool.call", tool: "database.write", status: "denied", redacted: [], reason: "tool not in allowed_tools" },
];

export function AuditPanel({ entries = DEMO_AUDIT }: { entries?: AuditEntry[] }) {
  const rows = entries.map(auditRow);
  const s = auditSummary(entries);
  return (
    <aside className="audit">
      <header className="audit-head">
        <span className="audit-title">Journal d'audit</span>
        <span className="audit-summary">
          <span className="green">{s.ok} autorisés</span>
          {s.needs_approval > 0 && <> · <span className="amber">{s.needs_approval} en attente</span></>}
          {s.denied > 0 && <> · <span className="rose">{s.denied} refusés</span></>}
          {s.redactedCalls > 0 && <> · <span className="cyan">{s.redactedCalls} caviardés</span></>}
        </span>
      </header>
      <div className="audit-rows">
        {rows.length === 0 && <div className="row muted empty">Aucune action encore.</div>}
        {rows.map((r) => (
          <div key={r.id} className="audit-row">
            <span className="audit-time mono muted">{r.time}</span>
            <span className={`audit-status ${r.color}`}>{r.statusLabel}</span>
            <span className="audit-tool mono">{r.tool}</span>
            <span className="audit-who muted">{r.who}</span>
            {r.redactions.length > 0 && (
              <span className="audit-redactions cyan" title="DLP a masqué ces secrets (§13.5)">
                🛡 {r.redactions.join(", ")}
              </span>
            )}
            {r.reason && <span className="audit-reason muted">{r.reason}</span>}
          </div>
        ))}
      </div>
    </aside>
  );
}
