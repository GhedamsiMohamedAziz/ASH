// Run delivery & notifications (instructions.md §15.5).
//
// Each scheduled run produces a recap; delivery routes it to the user's channel
// (Teams/Slack DM, email, or a signed webhook). Anti-noise: a success run that
// declares `no_op` (nothing to report) is suppressed or folded into a daily digest
// per the job's preference. Exfiltration guard: the target must be one of the
// user's own targets (§15.6) — a webhook must be on the org allow-list.
import { createHmac } from "node:crypto";

export type Channel = "teams" | "slack" | "email" | "webhook";
export type NoiseMode = "always" | "digest" | "on_change"; // per-job preference

export interface RunRecap {
  jobId: string;
  status: "success" | "failed";
  summary: string;
  noOp: boolean; // agent declared "nothing to report"
  costUsd: number;
  links: string[];
}

export interface DeliveryTarget {
  channel: Channel;
  target: string; // slack channel id / email / webhook url
}

export interface DeliveryDecision {
  action: "send" | "suppress" | "digest";
  reason: string;
}

// Decide whether to deliver now, suppress, or defer to the daily digest (§15.5).
export function decide(recap: RunRecap, mode: NoiseMode): DeliveryDecision {
  // Failures always notify immediately (§15.5).
  if (recap.status === "failed") return { action: "send", reason: "failure" };
  if (recap.noOp) {
    if (mode === "digest") return { action: "digest", reason: "no-op → daily digest" };
    if (mode === "on_change") return { action: "suppress", reason: "no-op, nothing changed" };
  }
  return { action: "send", reason: "recap ready" };
}

// Validate a delivery target against the user's allowed targets + org webhook
// allow-list (§15.6 exfiltration guard). Returns null if allowed, else a reason.
export function validateTarget(
  t: DeliveryTarget,
  userTargets: Set<string>,
  orgWebhookDomains: Set<string>,
): string | null {
  if (t.channel === "webhook") {
    let host: string;
    try {
      host = new URL(t.target).hostname;
    } catch {
      return "invalid webhook url";
    }
    if (!orgWebhookDomains.has(host)) return `webhook domain ${host} not on org allow-list`;
    return null;
  }
  if (!userTargets.has(t.target)) return "target is not one of the user's own targets";
  return null;
}

// Sign an outbound webhook body (HMAC-SHA256, §15.5). The receiver verifies it.
export function signWebhook(body: string, secret: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// Batch no-op/digest recaps into one daily message (§15.5 anti-noise).
export function buildDigest(recaps: RunRecap[]): string {
  if (recaps.length === 0) return "";
  const lines = recaps.map((r) => `• ${r.jobId}: ${r.summary} ($${r.costUsd.toFixed(4)})`);
  return `Daily automations digest (${recaps.length}):\n` + lines.join("\n");
}
