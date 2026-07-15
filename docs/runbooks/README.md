# Runbooks (instructions.md §24.7)

Format: **Symptôme → Diagnostic (≤3 cmds) → Remédiation → Vérification → Post-mortem.**

Les 10 prioritaires (§24.7), tous rédigés :

| # | Runbook | Fichier |
|---|---|---|
| 01 | Fournisseur LLM en panne | `01-llm-provider-down.md` |
| 02 | Workers Trigger.dev down (fenêtre de crons) | `02-triggerdev-workers-down.md` |
| 03 | Vault sealed | `03-vault-sealed.md` |
| 04 | Nœud sandbox saturé | `04-sandbox-node-saturated.md` |
| 05 | Secret / token OAuth expiré | `05-oauth-secret-expired.md` |
| 06 | Partition NATS / JetStream | `06-nats-partition.md` |
| 07 | Failover Postgres | `07-postgres-failover.md` |
| 08 | Certificat / secret expiré | `08-cert-expired.md` |
| 09 | DLQ qui gonfle malgré redrive | `09-dlq-growing.md` |
| 10 | Org qui explose son budget | `10-org-over-budget.md` |

Les commandes citées consomment le CLI `platctl` (§24.4, API admin, même audit). Chaque runbook est ancré sur des métriques `plat_*` réelles et les invariants d'idempotence/dedup (ADR-016) et de fail-closed. À **jouer à blanc au moins une fois** avant l'ouverture commerciale (checklist go-live, Annexe 3).
