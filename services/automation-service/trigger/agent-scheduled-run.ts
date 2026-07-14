// The pivot task (instructions.md §15.3, ADR 005): the ONE durable task that fires
// a cron and re-injects an InboundMessage into backend-core /internal/scheduled-runs
// — the same security path as a human message. Trigger.dev owns retries/durability;
// scheduled_jobs stays OUR source of truth (§16.2).
import { schedules, logger } from "@trigger.dev/sdk/v3";

// Imperative schedule: created per user cron via the SDK's schedules.create()
// (deduplicationKey = job_id → idempotent, resync-safe, §23).
export const agentScheduledRun = schedules.task({
  id: "agent-scheduled-run",
  run: async (payload) => {
    const jobId = payload.externalId!;            // = scheduled_jobs.id
    const scheduledFor = payload.timestamp.toISOString();
    logger.info("cron fire", { jobId, scheduledFor });

    // Preflight (creator active, kill-switch, budget) happens server-side; then
    // re-inject with an idempotency key so a retry never double-runs (§15.6).
    const res = await fetch(`${process.env.BACKEND_INTERNAL_URL}/internal/scheduled-runs`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `${jobId}:${scheduledFor}`,
        "authorization": `Bearer ${process.env.INTERNAL_SERVICE_TOKEN}`, // mTLS + service token
      },
      body: JSON.stringify({ job_id: jobId, scheduled_for: scheduledFor }),
    });
    if (!res.ok && res.status !== 409 /* dedup */) {
      throw new Error(`scheduled-run failed: HTTP ${res.status}`); // → Trigger.dev retry
    }
    return { jobId, scheduledFor, status: res.status };
  },
});
