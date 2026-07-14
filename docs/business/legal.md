# Legal: ToS, DPA, liability (instructions.md §30)

- **ToS**: acceptable use, approval-before-sensitive-action model, no warranty on
  agent outputs beyond the approval gates.
- **DPA**: data processor role; sub-processor list (Anthropic/Bedrock/Foundry per
  §G, cloud, email); data residency (EU region for export, local for sovereign §E.5).
- **Liability**: bounded; the approval + audit model (§2.3) is the control evidence.
- **RGPD**: user-erasure job (§15.7, implemented `app/erasure.py`), data-subject
  rights, retention policy (audit 90d+, WORM export).
- **Sovereignty**: self-hosted option for regulated MENA buyers (the moat, §E.2).
