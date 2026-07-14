// Trigger.dev v4 config (instructions.md §15, §22.1). DEV/STAGING/PROD are separate
// projects so a staging cron can never target prod (§22.1). `trigger deploy` syncs
// the declarative internal schedules; user crons are imperative (created at runtime).
import { defineConfig } from "@trigger.dev/sdk/v3";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "olma-automation",
  runtime: "node",
  logLevel: "info",
  maxDuration: 900, // 15 min per run ceiling (aligns with per_run_budget, §15)
  retries: { enabledInDev: false, default: { maxAttempts: 3, factor: 2, minTimeoutInMs: 1000 } },
  dirs: ["./trigger"],
});
