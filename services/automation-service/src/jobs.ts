// Job store + API (instructions.md §15.2-15.4, §8.2). scheduled_jobs is the business
// source of truth (§16.2); Trigger.dev is the execution engine. This is the TS
// automation-service store that the Trigger.dev worker + the Scheduler MCP drive.
// Mirrors the Python services/prompt-layer/app/scheduler.py lifecycle.

export type JobStatus = "draft" | "pending_approval" | "active" | "paused" | "deleted";

export interface Job {
  id: string;
  userId: string;
  orgId: string;
  name: string;
  prompt: string;
  promptVersion: number;
  cron: string;
  timezone: string;
  status: JobStatus;
  consecutiveFailures: number;
  createdBy: "agent" | "user";
  pauseReason?: string;
}

export class JobError extends Error {}

const MAX_FAILURES = 3;

// Legal §15.4 lifecycle transitions.
const LIFECYCLE: Record<JobStatus, JobStatus[]> = {
  draft: ["pending_approval"],
  pending_approval: ["active", "deleted"], // approve | refuse
  active: ["paused", "deleted"],
  paused: ["active", "deleted"], // resume | delete
  deleted: [],
};

export class JobStore {
  private jobs = new Map<string, Job>();
  private seq = 0;

  create(input: Omit<Job, "id" | "status" | "promptVersion" | "consecutiveFailures">): Job {
    const id = `job_${(++this.seq).toString().padStart(8, "0")}`;
    // Agent-created crons require approval before running (§15.4, §15.6).
    const status: JobStatus = input.createdBy === "agent" ? "pending_approval" : "draft";
    const job: Job = { ...input, id, status, promptVersion: 1, consecutiveFailures: 0 };
    this.jobs.set(id, job);
    return job;
  }

  private transition(id: string, to: JobStatus): Job {
    const job = this.require(id);
    if (!LIFECYCLE[job.status].includes(to)) {
      throw new JobError(`illegal transition ${job.status} -> ${to}`);
    }
    job.status = to;
    if (to === "active") job.pauseReason = undefined;
    return job;
  }

  approve(id: string): Job {
    const job = this.require(id);
    if (job.status !== "pending_approval") throw new JobError("job is not pending approval");
    return this.transition(id, "active");
  }

  pause(id: string, reason = "user"): Job {
    const job = this.transition(id, "paused");
    job.pauseReason = reason;
    return job;
  }

  resume(id: string): Job {
    // Resume is specifically paused→active (approve handles pending_approval→active).
    if (this.require(id).status !== "paused") throw new JobError("job is not paused");
    return this.transition(id, "active");
  }

  delete(id: string): void {
    this.transition(id, "deleted");
  }

  // Editing the prompt bumps the version and re-requires approval (§15.6 immutable prompt).
  editPrompt(id: string, prompt: string): Job {
    const job = this.require(id);
    job.prompt = prompt;
    job.promptVersion += 1;
    job.status = "pending_approval";
    return job;
  }

  // Record a run result; 3 consecutive failures auto-pause (§15.6 circuit breaker).
  recordResult(id: string, ok: boolean): Job {
    const job = this.require(id);
    if (ok) {
      job.consecutiveFailures = 0;
    } else {
      job.consecutiveFailures += 1;
      if (job.consecutiveFailures >= MAX_FAILURES && job.status === "active") {
        job.status = "paused";
        job.pauseReason = "3 consecutive failures";
      }
    }
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(userId?: string): Job[] {
    return [...this.jobs.values()].filter(
      (j) => j.status !== "deleted" && (!userId || j.userId === userId),
    );
  }

  private require(id: string): Job {
    const job = this.jobs.get(id);
    if (!job) throw new JobError(`no such job ${id}`);
    return job;
  }
}
