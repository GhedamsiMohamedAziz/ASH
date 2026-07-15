// Scheduler MCP façade (instructions.md §14.1, §15). The agent creates and manages
// its automations through these MCP tools; the Gateway (§13) applies tool_policies
// (scheduler.create_cron → require_approval by default, scheduler.list_crons → allow)
// and audits every call. This façade forwards to the automation-service, which owns
// scheduled_jobs (§16.2). Pure logic here; the HTTP client to automation-service is injected.

export interface CronSpec {
  name: string;
  prompt: string;
  cron: string; // 5-field, no seconds
  timezone?: string;
  delivery: { channel: string; target: string };
  perRunBudget: { maxCostUsd: number; maxSeconds: number };
}

export interface JobRef {
  jobId: string;
  status: string;
  humanSchedule: string;
  nextRunAt?: string;
}

// Backend the façade calls (the automation-service). Injected so tests need no HTTP.
export interface AutomationBackend {
  create(userId: string, orgId: string, spec: CronSpec): Promise<JobRef>;
  list(userId: string): Promise<JobRef[]>;
  pause(jobId: string): Promise<JobRef>;
  resume(jobId: string): Promise<JobRef>;
  runNow(jobId: string): Promise<{ runId: string }>;
}

// Validate a cron expression: 5 space-separated fields, and reject sub-15-min
// intervals (§21 E_SCHED_INVALID_CRON, §15.6 no runaway crons).
export function validateCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return "cron must have 5 fields (min hour dom mon dow)";
  const minute = fields[0];
  // "*/n" minute step under 15 is too frequent
  const step = minute.match(/^\*\/(\d+)$/);
  if (step && Number(step[1]) < 15) return "interval < 15 min not allowed";
  if (minute === "*") return "every-minute schedule not allowed (< 15 min)";
  return null;
}

// Turn a cron into a human-readable schedule for the agent.cron.created chip (§4.3).
export function humanize(cron: string, tz = "UTC"): string {
  const [min, hour, dom, mon, dow] = cron.trim().split(/\s+/);
  const days = ["dim", "lun", "mar", "mer", "jeu", "ven", "sam"];
  if (dom === "*" && mon === "*" && dow !== "*") {
    return `chaque ${days[Number(dow)] ?? dow} à ${hour}h${min.padStart(2, "0")} (${tz})`;
  }
  if (dom === "*" && mon === "*" && dow === "*") {
    return `chaque jour à ${hour}h${min.padStart(2, "0")} (${tz})`;
  }
  return `cron ${cron} (${tz})`;
}

// Strict JSON Schema per tool (parity with the other MCP connectors §14). Structural
// validation runs at the tool boundary BEFORE any backend call — a malformed arg is a
// fail-closed E_VALIDATION, never forwarded to the automation-service.
export const TOOL_SCHEMAS: Record<string, Record<string, unknown>> = {
  "scheduler.create_cron": {
    type: "object", additionalProperties: false,
    properties: {
      name: { type: "string" }, prompt: { type: "string" }, cron: { type: "string" },
      timezone: { type: "string" },
      delivery: {
        type: "object", required: ["channel", "target"],
        properties: { channel: { type: "string" }, target: { type: "string" } },
      },
      perRunBudget: {
        type: "object", required: ["maxCostUsd", "maxSeconds"],
        properties: { maxCostUsd: { type: "number" }, maxSeconds: { type: "number" } },
      },
    },
    required: ["name", "prompt", "cron", "delivery", "perRunBudget"],
  },
  "scheduler.list_crons": { type: "object", additionalProperties: false, properties: {} },
  "scheduler.pause_cron": { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  "scheduler.resume_cron": { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
  "scheduler.run_now": { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"] },
};

// Minimal fail-closed validator against a tool's schema: required keys present with the
// declared primitive/object type; nested `required` on object props enforced one level deep.
export function validateArgs(tool: string, args: any): string | null {
  const schema = TOOL_SCHEMAS[tool];
  if (!schema) return `unknown tool: ${tool}`;
  const a = args ?? {};
  if (typeof a !== "object" || Array.isArray(a)) return "args must be an object";
  const check = (obj: any, sch: any, path: string): string | null => {
    for (const key of (sch.required ?? []) as string[]) {
      if (obj[key] === undefined || obj[key] === null) return `missing required field: ${path}${key}`;
    }
    for (const [key, spc] of Object.entries((sch.properties ?? {}) as Record<string, any>)) {
      if (obj[key] === undefined) continue;
      if (spc.type === "object") {
        if (typeof obj[key] !== "object" || Array.isArray(obj[key])) return `${path}${key} must be an object`;
        const nested = check(obj[key], spc, `${path}${key}.`);
        if (nested) return nested;
      } else if (spc.type === "number" && typeof obj[key] !== "number") {
        return `${path}${key} must be a number`;
      } else if (spc.type === "string" && typeof obj[key] !== "string") {
        return `${path}${key} must be a string`;
      }
    }
    return null;
  };
  return check(a, schema, "");
}

// The MCP tool surface (names match tool_policies + allowed_tools).
export class SchedulerMcp {
  private backend: AutomationBackend;
  constructor(backend: AutomationBackend) {
    this.backend = backend;
  }

  tools(userId: string, orgId: string): Record<string, (args: any) => Promise<unknown>> {
    // Wrap each handler so structural validation runs first, fail-closed (§14 common rules).
    const guard = (tool: string, fn: (a: any) => Promise<unknown>) => async (a: any) => {
      const bad = validateArgs(tool, a);
      if (bad) return { error: { code: "E_VALIDATION", message: bad } };
      return fn(a);
    };
    return {
      "scheduler.create_cron": guard("scheduler.create_cron", async (a: CronSpec) => {
        const bad = validateCron(a.cron);
        if (bad) return { error: { code: "E_SCHED_INVALID_CRON", message: bad } };
        const ref = await this.backend.create(userId, orgId, a);
        return { ...ref, humanSchedule: humanize(a.cron, a.timezone) };
      }),
      "scheduler.list_crons": guard("scheduler.list_crons", () => this.backend.list(userId)),
      "scheduler.pause_cron": guard("scheduler.pause_cron", (a: { jobId: string }) => this.backend.pause(a.jobId)),
      "scheduler.resume_cron": guard("scheduler.resume_cron", (a: { jobId: string }) => this.backend.resume(a.jobId)),
      "scheduler.run_now": guard("scheduler.run_now", (a: { jobId: string }) => this.backend.runNow(a.jobId)),
    };
  }
}
