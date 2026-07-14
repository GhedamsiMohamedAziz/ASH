# Go-live checklist (instructions.md Annexe D, §29 P7 exit)

- [ ] All SLOs green over a 7-day window (Annexe A): first-token P95, cron failure
      rate < 5%, cron delay P95 < 120s, error-budget burn.
- [ ] 99.9% availability demonstrated.
- [ ] gVisor + sandbox NetworkPolicy verified (external egress blocked).
- [ ] Pentest criticals closed (`docs/security/pentest-scope.md`).
- [ ] DR drill meets RPO 15m / RTO 1h; `resync_schedules` rebuilds crons.
- [ ] Load test sustained (500 sandboxes + 1000 crons/h).
- [ ] Evals gate green in CI; migrations lint clean.
- [ ] Admin console + platctl + runbooks published.
- [ ] org-platform dogfooding active.
- [ ] Break-glass account sealed; audit WORM export verified.
