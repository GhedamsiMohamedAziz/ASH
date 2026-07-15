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
// 2) Approval policy preview — a read-only reflection of the REAL org tool_policies seed
//    (db/migrations/0003_seed_policies.sql, role 'member', org_1: github.merge_pr →
//    require_approval/tech-leads, database.write → deny, scheduler.create_cron →
//    require_approval). Those three are rendered LOCKED — the org, not the user, controls them,
//    and there is no endpoint to change that from here. m365.send_mail is NOT in the seed (no
//    org rule governs it yet), so it is the one entry with a real, local, user-editable
//    preference — clearly labelled as such, never presented as a synced server value.

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

// ---- Approval policy preview -----------------------------------------------------------------

export type PolicyEffect = "require_approval" | "deny";

export interface ApprovalPolicy {
  tool: string;
  label: string;
  effect: PolicyEffect;
  locked: boolean;          // true = enforced by db/migrations/0003_seed_policies.sql, real & fixed
  approverGroup?: string;
}

// The 3 locked rows are the real `member`-role rules from 0003_seed_policies.sql (org_1). Only
// the unlocked row is a client-side preference toggle (see PREF_KEY below) — nothing here
// pretends to be a fetched per-user policy.
export const APPROVAL_POLICIES: ApprovalPolicy[] = [
  {
    tool: "github.merge_pr",
    label: "Fusionner une pull request",
    effect: "require_approval",
    locked: true,
    approverGroup: "tech-leads",
  },
  {
    tool: "scheduler.create_cron",
    label: "Créer une automatisation planifiée",
    effect: "require_approval",
    locked: true,
  },
  {
    tool: "database.write",
    label: "Écrire dans la base de données",
    effect: "deny",
    locked: true,
  },
  {
    tool: "m365.send_mail",
    label: "Envoyer un e-mail (Microsoft 365)",
    effect: "require_approval",
    locked: false,
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
