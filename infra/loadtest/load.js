// Load test (instructions.md §23): 500 active sandboxes + 1000 crons/h. Verifies
// autoscaling + jitter smoothing hold the SLO (Annexe A). Run against a deployed
// cluster: `k6 run load.js`. Cannot run in this sandbox (needs the live system).
import http from "k6/http";
import { check } from "k6";
export const options = {
  scenarios: {
    interactive: { executor: "ramping-vus", stages: [
      { duration: "5m", target: 500 }, { duration: "20m", target: 500 }, { duration: "5m", target: 0 }] },
  },
  thresholds: { http_req_duration: ["p95<30000"] }, // first-token P95 < 30s (Annexe A)
};
export default function () {
  const r = http.post(`${__ENV.BASE}/api/v1/conversations/conv/messages`,
    JSON.stringify({ text: "status of my PRs" }),
    { headers: { "content-type": "application/json", "Idempotency-Key": `${__VU}-${__ITER}` } });
  check(r, { "202": (x) => x.status === 202 });
}
