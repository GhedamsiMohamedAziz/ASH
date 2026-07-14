#!/usr/bin/env bash
# Seed GitHub issues/labels/milestones from docs/backlog/tickets.json.
# Prereqs: `gh auth login`, run inside the target repo (a git remote must exist).
set -euo pipefail
cd "$(dirname "$0")/.."
JSON=docs/backlog/tickets.json
command -v gh >/dev/null || { echo "gh CLI required"; exit 1; }
command -v jq >/dev/null || { echo "jq required"; exit 1; }

echo "Creating labels..."
jq -r '.[].labels[]' "$JSON" | sort -u | while read -r l; do
  gh label create "$l" --force >/dev/null 2>&1 || true
done
for s in "phase:P0" "phase:P1" "phase:P2" "phase:P3" "phase:P4" "phase:P5" "phase:P6" "phase:P7" "phase:PX"; do
  gh label create "$s" --force >/dev/null 2>&1 || true
done

echo "Creating milestones (idempotent)..."
REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
for p in P0 P1 P2 P3 P4 P5 P6 P7 PX; do
  gh api "repos/$REPO/milestones" -f title="$p" >/dev/null 2>&1 || true
done

echo "Creating issues..."
jq -c '.[]' "$JSON" | while read -r t; do
  id=$(echo "$t" | jq -r .id)
  title=$(echo "$t" | jq -r .title)
  phase=$(echo "$t" | jq -r .phase)
  body=$(echo "$t" | jq -r '
    "**" + .id + "** — " + .description + "\n\n" +
    "**Spec:** " + .spec + "  ·  **Estimate:** " + .estimate + "  ·  **Depends on:** " +
    (if (.deps|length)>0 then (.deps|join(", ")) else "—" end) + "\n\n" +
    "**Acceptance:**\n" + ([.acceptance[] | "- [ ] " + .] | join("\n"))')
  labels=$(echo "$t" | jq -r '.labels + ["phase:" + .phase] | join(",")')
  gh issue create --title "$id — $title" --body "$body" --label "$labels" --milestone "$phase" >/dev/null     && echo "  + $id"
done
echo "Done."
