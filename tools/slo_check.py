#!/usr/bin/env python3
"""SLO compliance checker (AX-091, instructions.md Annexe A, §19). Given measured
metrics, verify each SLO threshold. Used by the go-live gate + post-deploy 30-min
SLO check (§22.3 step 11). Pure/testable; fed by Prometheus queries in prod."""
from __future__ import annotations
from dataclasses import dataclass

# Annexe A / §24.6 thresholds.
SLOS = {
    "availability":        (">=", 0.999),   # 99.9%
    "first_token_p95_s":   ("<=", 30.0),    # user-visible latency
    "cron_failure_rate_1h":("<=", 0.05),    # Annexe A
    "cron_fire_delay_p95_s":("<=", 120.0),  # Annexe A
    "cache_hit_ratio":     (">=", 0.60),    # §9.6 investigation floor
}

@dataclass
class SloResult:
    metric: str; value: float; op: str; threshold: float; ok: bool

def check(metrics: dict) -> dict:
    results = []
    for m, (op, thr) in SLOS.items():
        v = metrics.get(m)
        if v is None:
            results.append(SloResult(m, float("nan"), op, thr, False)); continue
        ok = (v >= thr) if op == ">=" else (v <= thr)
        results.append(SloResult(m, v, op, thr, ok))
    passed = all(r.ok for r in results)
    return {"met": passed, "results": [r.__dict__ for r in results],
            "failing": [r.metric for r in results if not r.ok]}

if __name__ == "__main__":
    import json, sys
    metrics = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    r = check(metrics)
    print(json.dumps(r, indent=1))
    sys.exit(0 if r["met"] else 1)
