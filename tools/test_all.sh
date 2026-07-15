#!/usr/bin/env bash
# Run every test suite in the repo (Python + TypeScript + Go) — the local mirror
# of CI (AX-008, instructions.md §22.3). Exits non-zero if any suite fails.
set -uo pipefail
cd "$(dirname "$0")/.."
export PATH="/opt/homebrew/bin:$PATH"

fail=0
pass_suites=0

run() {  # run <label> <command...>
  local label="$1"; shift
  if "$@" >/tmp/olma_test.out 2>&1; then
    echo "  ✓ $label"
    pass_suites=$((pass_suites + 1))
  else
    echo "  ✗ $label"
    tail -6 /tmp/olma_test.out | sed 's/^/      /'
    fail=1
  fi
}

echo "── Python (pytest) ──"
for d in packages/errors packages/schemas packages/shared-py \
         services/backend-core services/prompt-layer services/auth-service services/llm-proxy; do
  run "$d" bash -c "cd '$d' && python3 -m pytest -p no:cacheprovider -q"
done
run "tools/platctl" python3 -m pytest -p no:cacheprovider -q tools/test_platctl.py
run "tools/resync" python3 -m pytest -p no:cacheprovider -q tools/test_resync.py
run "tools/slo" python3 -m pytest -p no:cacheprovider -q tools/test_slo.py
run "evals" python3 -m pytest -p no:cacheprovider -q evals/test_evals.py
run "i18n" python3 -m pytest -p no:cacheprovider -q packages/schemas/test_i18n.py
run "eval-gate" python3 evals/runner.py

echo "── TypeScript (node --test) ──"
for f in packages/shared-ts/test/shared.test.ts \
         services/mcp-gateway/test/gateway.test.ts \
         services/mcp-gateway/test/vault.test.ts \
         services/mcp-gateway/test/server.test.ts \
         services/mcp-gateway/test/connect.test.ts \
         services/mcp-servers/github/test/github.test.ts \
         services/mcp-servers/github/test/rest.test.ts \
         services/mcp-servers/scheduler/test/scheduler.test.ts \
         services/mcp-servers/database/test/database.test.ts \
         services/mcp-servers/m365/test/m365.test.ts \
         services/mcp-servers/browser/test/browser.test.ts \
         services/mcp-servers/notion/test/notion.test.ts \
         services/mcp-servers/slack/test/slack.test.ts \
         apps/slack-adapter/test/adapter.test.ts \
         apps/teams-adapter/test/teams.test.ts \
         apps/slack-adapter/test/proactive.test.ts \
         apps/web/test/events.test.ts \
         apps/web/test/pages.test.ts \
         services/automation-service/test/jobs.test.ts \
         services/automation-service/test/delivery.test.ts; do
  run "$f" node --test "$f"
done

echo "── Go (go test) ──"
run "services/orchestrator" bash -c "cd services/orchestrator && go test ./..."

echo "── Contract codegen (must be up to date) ──"
run "errors codegen" python3 packages/errors/gen.py
run "schemas codegen" python3 packages/schemas/gen.py
run "migration lint" python3 tools/migrate_lint.py
if command -v gitleaks >/dev/null; then run "secret scan (gitleaks)" gitleaks dir . -c .gitleaks.toml --no-banner; fi
run "eval adversarial gate" python3 evals/runner.py

echo
if [ "$fail" -eq 0 ]; then
  echo "ALL GREEN — $pass_suites suites passed."
else
  echo "FAILURES above — CI would STOP." >&2
fi
exit $fail
