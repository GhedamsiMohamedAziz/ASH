# Load test results (AX-087, §23)

**Verified locally against backend-core** (`k6 run infra/loadtest/load-local.js`):
- 50 concurrent VUs, 25s, **9,447 requests**, ~378 req/s
- **p(95) = 267ms** (SLO threshold `p(95)<30s`, Annexe A) ✓ PASS
- **http_req_failed = 0.00%** (threshold `<1%`) ✓ PASS
- 0 interrupted iterations

The harness works and the API holds SLO under concurrent load. Full-scale
(`infra/loadtest/load.js`: 500 sandboxes + 1000 crons/h, §23) runs against the
deployed cluster with the sandbox pool + Trigger.dev workers.
