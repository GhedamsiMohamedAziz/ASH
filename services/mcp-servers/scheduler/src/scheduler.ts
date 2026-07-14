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

// The MCP tool surface (names match tool_policies + allowed_tools).
export class SchedulerMcp {
  private backend: AutomationBackend;
  constructor(backend: AutomationBackend) {
    this.backend = backend;
  }

  tools(userId: string, orgId: string): Record<string, (args: any) => Promise<unknown>> {
    return {
      "scheduler.create_cron": async (a: CronSpec) => {
        const bad = validateCron(a.cron);
        if (bad) return { error: { code: "E_SCHED_INVALID_CRON", message: bad } };
        const ref = await this.backend.create(userId, orgId, a);
        return { ...ref, humanSchedule: humanize(a.cron, a.timezone) };
      },
      "scheduler.list_crons": () => this.backend.list(userId),
      "scheduler.pause_cron": (a: { jobId: string }) => this.backend.pause(a.jobId),
      "scheduler.resume_cron": (a: { jobId: string }) => this.backend.resume(a.jobId),
      "scheduler.run_now": (a: { jobId: string }) => this.backend.runNow(a.jobId),
    };
  }
}
