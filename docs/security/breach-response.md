# Security breach response plan (instructions.md §17.5)

**Detection → Containment → Eradication → Notification → Post-mortem.**

1. **Detect**: SLO/security alerts, anomalous audit_log patterns (E_PERM spikes,
   unusual on_behalf_of), Vault/secret access anomalies.
2. **Contain** (minutes): org kill-switch (`platctl jobs pause --all`), rotate the
   affected Vault credentials, revoke sessions (short JWTs limit blast radius, ADR 010),
   isolate the sandbox node pool if compromise suspected.
3. **Eradicate**: identify root cause via audit trail (every tool call logged §16.1);
   patch + redeploy via GitOps (auditable).
4. **Notify**: regulatory timelines (GDPR 72h); templated customer comms; status page.
5. **Post-mortem**: 5-whys; feed findings into evals + runbooks.

**Owner**: platform_admin. **Break-glass** account for emergency access (§24.1),
sealed, usage = alert + enhanced audit.
