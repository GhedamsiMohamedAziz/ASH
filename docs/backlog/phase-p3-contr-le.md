# P3 — Contrôle

> Permissions, approvals, guardrails, Vault/OAuth, audit, admin v1.  ·  _3 wk_  ·  10 tickets

## ✅ AX-032 — Permissions engine (RBAC+ABAC) ⭐M0

tool_policies matrix (org,role,tool_pattern)→allow/deny/require_approval; compute allowed_tools per turn.

- **Estimate:** L  ·  **Labels:** permissions, security  ·  **Spec:** §9.4
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Policy lookup fail-closed
  - [ ] allowed_tools signed into TASK JWT
  - [ ] gateway re-verifies (defense in depth)

## ✅ AX-033 — Human approval flow (HITL) ⭐M0

require_approval suspends the tool call, emits approval.needed, resolves via approve endpoint/card.

- **Estimate:** L  ·  **Labels:** approvals  ·  **Spec:** §13.3
- **Depends on:** AX-032
- **Acceptance:**
  - [ ] Approve/deny resolves call
  - [ ] pending stored in Redis with timeout
  - [ ] decision audited

## ✅ AX-034 — Designated approvers (team mode)

approver_group routing: card goes to the group, not the requester; both parties logged.

- **Estimate:** M  ·  **Labels:** approvals  ·  **Spec:** §3.3
- **Depends on:** AX-033
- **Acceptance:**
  - [ ] Group receives card
  - [ ] requester≠approver enforced where set
  - [ ] audit records both

## ✅ AX-035 — Input guardrails

Prompt-injection classifier + attachment heuristics, PII scope filter, org content policy; fail-closed.

- **Estimate:** L  ·  **Labels:** guardrails, security  ·  **Spec:** §9.3
- **Depends on:** AX-013
- **Acceptance:**
  - [ ] Injection corpus blocked
  - [ ] PII policy enforced
  - [ ] blocked → E_GUARD_INPUT_BLOCKED

## ✅ AX-036 — Output guardrails / DLP ⭐M0

Scan responses + generated files for secrets (regex + gitleaks lib); mask/refuse on policy violation.

- **Estimate:** M  ·  **Labels:** guardrails, dlp, security  ·  **Spec:** §9.3, §13.5
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Secret patterns masked
  - [ ] gitleaks on generated files
  - [ ] memory.save honors DLP

## ✅ AX-037 — Vault + encrypted OAuth token store ⭐M0

Vault integration; oauth_tokens encrypted AES-256-GCM with Vault key; injection only at gateway.

- **Estimate:** L  ·  **Labels:** security, vault  ·  **Spec:** §13.2, §16.1, ADR 001
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Tokens never leave gateway
  - [ ] at-rest encryption
  - [ ] zero secrets in sandbox verified

## ✅ AX-038 — OAuth connect flows + refresh sweep

GitHub/Notion OAuth start/callback; Trigger.dev oauth-refresh-sweep job with Redis locks.

- **Estimate:** M  ·  **Labels:** oauth  ·  **Spec:** §13.2, §8.2
- **Depends on:** AX-037
- **Acceptance:**
  - [ ] Connect + callback stores token
  - [ ] refresh before expiry
  - [ ] revocation handled

## ✅ AX-039 — Audit log (append-only, partitioned) ⭐M0

Write audit rows for every tool call/cron/admin action; monthly partitions; WORM export to S3.

- **Estimate:** M  ·  **Labels:** audit, compliance  ·  **Spec:** §16.1, §16.3
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Every sensitive action logged (who/what/when/result)
  - [ ] monthly partition job
  - [ ] export produces WORM file

## ✅ AX-040 — Admin console v1

Backoffice: orgs, users, tool_policies editor, budgets, audit viewer; SSO+MFA, view-as (read-only).

- **Estimate:** L  ·  **Labels:** admin, web  ·  **Spec:** §24.1, §24.2
- **Depends on:** AX-039, AX-032
- **Acceptance:**
  - [ ] CRUD orgs/policies/budgets
  - [ ] audit searchable/exportable
  - [ ] every admin action audited

## ✅ AX-041 — P3 exit: approvals + audit demonstrated

Show a require_approval decision and export the audit trail.

- **Estimate:** S  ·  **Labels:** milestone  ·  **Spec:** §29 P3
- **Depends on:** AX-033, AX-039, AX-040
- **Acceptance:**
  - [ ] require_approval demoed
  - [ ] audit exportable
  - [ ] P3 exit gate green
