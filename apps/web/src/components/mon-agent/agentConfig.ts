// Local (client-only) config for the "Mon agent" page (§2.6, §4.4).
//
// Two honest categories of data live here, deliberately kept apart:
//
// 1) Agent profile (dev / généraliste / data / ops) — the 4 real OpenCode profiles shipped at
//    sandbox/profiles/*.json (name, description, tools, default_model are copied verbatim from
//    those files, not invented) and referenced by scheduled_jobs.agent_profile /
//    system_context (instructions.md §7, DB default 'generalist'). There is no
//    `GET/PATCH /api/v1/me/agent-profile` endpoint yet, so the *choice* is a real local
//    selection persisted to localStorage — never sent to the backend, never rendered as if it
//    came from a server (ADR-017 spirit).
//
// 2) Approval matrix — GET /api/v1/tool_policies (services/backend-core/app/main.py) now returns
//    the caller's REAL org+role rows from the `tool_policies` table, so ApprovalPoliciesSection
//    fetches and renders those directly (per-org, per-role — not a fixed literal here anymore).
//    LOCAL_APPROVAL_CANDIDATES below is the small, fixed list of tools we offer a genuine LOCAL
//    (client-only) preference for WHEN the org has no server rule for them — m365.send_mail is
//    the one example today. If the org ever adds a server rule for one of these, the fetched
//    matrix takes over and the local-pref row disappears (ApprovalPoliciesSection filters by
//    tool_pattern already present in the fetched rows) — never presented as org policy.

// ---- Agent profile ---------------------------------------------------------------------------

export interface AgentProfile {
  id: string;
  label: string;
  description: string;
  tools: string[];
  defaultModel: "frontier" | "eco";
}

// Verbatim from sandbox/profiles/{dev,generalist,data-analyst,ops}.json — translated descriptions,
// same ids/tools/models as the real OpenCode profile files the sandbox loads.
export const AGENT_PROFILES: AgentProfile[] = [
  {
    id: "dev",
    label: "Développeur",
    description: "Ingénierie logicielle : code, pull requests, issues.",
    tools: ["github", "browser", "database"],
    defaultModel: "frontier",
  },
  {
    id: "generalist",
    label: "Généraliste",
    description: "Profil par défaut : bureautique et communication.",
    tools: ["m365", "slack", "notion", "browser"],
    defaultModel: "eco",
  },
  {
    id: "data-analyst",
    label: "Data",
    description: "Analyse de données : requêtes, graphiques.",
    tools: ["database", "browser"],
    defaultModel: "frontier",
  },
  {
    id: "ops",
    label: "Ops",
    description: "Tâches d'exploitation : supervision, triage d'incidents.",
    tools: ["github", "browser"],
    defaultModel: "eco",
  },
];

const PROFILE_KEY = "olma_agent_profile";
const DEFAULT_PROFILE = "generalist"; // matches scheduled_jobs.agent_profile DB default

// try/catch mirrors auth.ts — localStorage can throw in private mode / SSR, never crash the page.
export function getStoredProfile(): string {
  try {
    return localStorage.getItem(PROFILE_KEY) ?? DEFAULT_PROFILE;
  } catch {
    return DEFAULT_PROFILE;
  }
}

export function setStoredProfile(id: string): void {
  try {
    localStorage.setItem(PROFILE_KEY, id);
  } catch {
    // no-op — selection just won't persist this session
  }
}

// ---- Local approval preference candidates --------------------------------------------------

export interface LocalApprovalCandidate {
  tool: string;
  label: string;
}

// Tools the UI offers a local preference for WHEN the org's fetched matrix has no rule covering
// them yet (ApprovalPoliciesSection filters this list against the live /tool_policies response).
export const LOCAL_APPROVAL_CANDIDATES: LocalApprovalCandidate[] = [
  {
    tool: "m365.send_mail",
    label: "Envoyer un e-mail (Microsoft 365)",
  },
];

const PREF_PREFIX = "olma_approval_pref:"; // + tool name

// Local-only preference for the one unlocked policy row. Defaults to "on" (require approval) —
// the safer default — but is purely advisory until the platform ships a real tool_policies write
// path; never persisted server-side, never rendered as if it were.
export function getLocalApprovalPref(tool: string): boolean {
  try {
    const v = localStorage.getItem(PREF_PREFIX + tool);
    return v === null ? true : v === "1";
  } catch {
    return true;
  }
}

export function setLocalApprovalPref(tool: string, value: boolean): void {
  try {
    localStorage.setItem(PREF_PREFIX + tool, value ? "1" : "0");
  } catch {
    // no-op
  }
}
