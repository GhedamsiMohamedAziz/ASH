import http from "k6/http";
import { check } from "k6";
export const options = {
  scenarios: { load: { executor: "ramping-vus", stages: [
    { duration: "5s", target: 50 }, { duration: "15s", target: 50 }, { duration: "5s", target: 0 }] } },
  thresholds: { http_req_duration: ["p(95)<30000"], http_req_failed: ["rate<0.01"] },
};
const BASE = "http://127.0.0.1:8200";
export default function () {
  const r = http.post(`${BASE}/api/v1/conversations/conv_00000001/messages`,
    JSON.stringify({ text: "status of my PRs" }),
    { headers: { "content-type": "application/json", "Idempotency-Key": `${__VU}-${__ITER}-${Date.now()}` } });
  check(r, { "202": (x) => x.status === 202 });
}
