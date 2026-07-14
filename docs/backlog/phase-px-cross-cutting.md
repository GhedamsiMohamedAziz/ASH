# PX — Cross-cutting

> Localization, business/GTM, compliance, security hardening.  ·  _ongoing_  ·  11 tickets

## ✅ AX-092 — Localization fr/en/ar

Localize agent replies, approval cards, notifications, error taxonomy; RTL for Arabic.

- **Estimate:** M  ·  **Labels:** i18n, product  ·  **Spec:** §7, §7.4
- **Depends on:** AX-003
- **Acceptance:**
  - [ ] 3 locales at launch
  - [ ] cards/errors localized
  - [ ] RTL rendering correct

## ✅ AX-093 — Pricing & packaging

Define plans/seats/quotas, TND billing with local VAT, usage split interactive vs scheduled.

- **Estimate:** M  ·  **Labels:** business, billing  ·  **Spec:** §30, §4.4
- **Depends on:** —
- **Acceptance:**
  - [ ] Plans defined
  - [ ] billing page (TND/VAT)
  - [ ] usage_daily.origin drives invoices

## ✅ AX-094 — Legal: ToS, DPA, liability

Terms, data processing agreement, liability model, sub-processor list.

- **Estimate:** M  ·  **Labels:** business, legal  ·  **Spec:** §30
- **Depends on:** —
- **Acceptance:**
  - [ ] ToS + DPA published
  - [ ] sub-processors listed
  - [ ] liability reviewed by counsel

## ✅ AX-095 — Support & SLA

Contractual support tiers and SLAs; escalation paths.

- **Estimate:** S  ·  **Labels:** business, support  ·  **Spec:** §30
- **Depends on:** —
- **Acceptance:**
  - [ ] SLA tiers documented
  - [ ] support workflow live
  - [ ] status page

## ✅ AX-096 — Org onboarding flow

Self-serve/assisted org onboarding: identity linking, connectors, policies, budgets.

- **Estimate:** M  ·  **Labels:** product, onboarding  ·  **Spec:** §3.5, §30
- **Depends on:** AX-040
- **Acceptance:**
  - [ ] Org can be onboarded in a day
  - [ ] admin connectors page
  - [ ] policy defaults seeded

## ✅ AX-097 — RGPD user-erasure

Erasure job purging memories/entities/entity_facts/workspace notes; UI trigger.

- **Estimate:** M  ·  **Labels:** privacy, compliance  ·  **Spec:** §4.4, §15.7
- **Depends on:** AX-065, AX-053
- **Acceptance:**
  - [ ] Erasure job complete + audited
  - [ ] UI zone wired
  - [ ] verifiable purge

## ✅ AX-098 — At-rest volume encryption

Encrypt sandbox volumes at rest.

- **Estimate:** S  ·  **Labels:** security  ·  **Spec:** §17
- **Depends on:** AX-021
- **Acceptance:**
  - [ ] Volumes encrypted
  - [ ] keys managed (KMS/Vault)
  - [ ] verified on new volume

## ✅ AX-099 — Attachment antivirus

Scan inbound attachments before storage/use.

- **Estimate:** S  ·  **Labels:** security  ·  **Spec:** §17
- **Depends on:** AX-011
- **Acceptance:**
  - [ ] AV scan on upload
  - [ ] infected rejected + logged
  - [ ] scan latency acceptable

## ✅ AX-100 — Breach response plan

Documented breach detection→containment→notification with regulatory timelines.

- **Estimate:** S  ·  **Labels:** security, compliance  ·  **Spec:** §17.5
- **Depends on:** AX-088
- **Acceptance:**
  - [ ] Plan documented + owned
  - [ ] tabletop exercised
  - [ ] notification templates ready

## ✅ AX-101 — Prompt registry + feedback→evals loop

Registry of system prompts + a feedback loop feeding the eval corpus.

- **Estimate:** M  ·  **Labels:** quality, prompt-layer  ·  **Spec:** §20
- **Depends on:** AX-083
- **Acceptance:**
  - [ ] Prompts versioned in registry
  - [ ] thumbs feed evals
  - [ ] regressions caught

## ✅ AX-102 — Team mode (Mode B) configuration ⭐M0

Shared org-agent: GitHub App token, service DB, on_behalf_of authz, org memory, no personal connectors.

- **Estimate:** L  ·  **Labels:** product, security  ·  **Spec:** §3
- **Depends on:** AX-032, AX-037
- **Acceptance:**
  - [ ] on_behalf_of enforced in authz
  - [ ] org-scoped Vault entry
  - [ ] personal connectors disabled
