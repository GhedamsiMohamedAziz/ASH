// Static connector metadata for the /connecteurs page (§2.5, §14). Icons + fallback labels are
// fixed platform facts (which providers exist, what they're called) — not fabricated connection
// status. Real connected/disconnected state always comes from GET /api/v1/me; this file only
// fills in what /me doesn't carry (icon, and a label to render before the first response lands,
// or if the backend is unreachable — ADR-017 tolerant-degrade).
import type { ComponentType } from "react";
import { GitBranch, MessageSquare, FileText, Building2, Database, Globe, Clock } from "lucide-react";

export interface Connection {
  provider: string;
  connected: boolean;
  label: string;
}

// Render order for each section (§2.5: personal connectors vs org-included infra).
export const USER_PROVIDER_IDS = ["github", "m365", "slack", "notion"] as const;
export const ORG_PROVIDER_IDS = ["database", "browser", "scheduler"] as const;

// Matches backend-core's _PROVIDERS labels where one exists; Browser/Scheduler never come back
// from /me (they aren't in _PROVIDERS) so they're always rendered from here.
const STATIC_LABEL: Record<string, string> = {
  github: "GitHub",
  m365: "Microsoft 365",
  slack: "Slack",
  notion: "Notion",
  database: "Base de données",
  browser: "Browser",
  scheduler: "Scheduler",
};

export const PROVIDER_ICON: Record<string, ComponentType<{ className?: string }>> = {
  github: GitBranch,
  m365: Building2,
  slack: MessageSquare,
  notion: FileText,
  database: Database,
  browser: Globe,
  scheduler: Clock,
};

// Merge the real /me connections (source of truth) with the static id/label list so a section
// always renders every known provider, even when /me is degraded (tryGet's empty-array fallback).
// Anything /me didn't return renders connected:false — never a guessed true (ADR-017 §2.8).
export function resolveConnectors(ids: readonly string[], live: Connection[]): Connection[] {
  const byProvider = new Map(live.map((c) => [c.provider, c]));
  return ids.map(
    (id) => byProvider.get(id) ?? { provider: id, connected: false, label: STATIC_LABEL[id] ?? id }
  );
}
