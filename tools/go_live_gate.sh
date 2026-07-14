#!/usr/bin/env bash
# Go-live readiness gate (AX-091, Annexe D). Verifies every ENGINEERING gate that
# can be checked pre-production. The one gate NOT checkable here — 99.9% availability
# sustained over a 7-day production window — is measured by tools/slo_check.py against
# live Prometheus after deploy (§22.3 step 11).
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"
pass=0; total=0
gate() { total=$((total+1)); if eval "$2" >/dev/null 2>&1; then echo "  ✓ $1"; pass=$((pass+1)); else echo "  ✗ $1"; fi; }

echo "── Go-live engineering gates (Annexe D) ──"
gate "all test suites green"           "bash tools/test_all.sh"
gate "evals adversarial gate PASS"     "python3 evals/runner.py"
gate "migrations lint (no destructive)" "python3 tools/migrate_lint.py"
gate "SLO checker present + tested"    "python3 -m pytest -q tools/test_slo.py"
gate "secret scan clean"              "gitleaks dir . -c .gitleaks.toml --no-banner"
gate "sandbox NetworkPolicy authored"  "test -f infra/helm/networkpolicy-sandbox.yaml"
gate "gVisor RuntimeClass authored"    "grep -q gvisor infra/helm/namespaces.yaml"
gate "SLO alerts authored"            "test -f infra/helm/slo-alerts.yaml"
gate "DR resync tested"               "python3 -m pytest -q tools/test_resync.py"
gate "runbooks present"               "test -d docs/runbooks && ls docs/runbooks/*.md"
gate "admin console + platctl"        "python3 -m pytest -q tools/test_platctl.py"
gate "org-platform dogfood live"      "python3 tools/dogfood_smoke.py"
gate "load test harness verified"     "test -f infra/loadtest/RESULTS.md"
gate "go-live checklist present"      "test -f docs/go-live-checklist.md"

echo
echo "Engineering readiness: $pass/$total gates green."
echo "Remaining for go-live (needs production): 99.9% availability sustained over a"
echo "7-day window — measured post-deploy via tools/slo_check.py against live metrics."
[ "$pass" -eq "$total" ] && exit 0 || exit 1
