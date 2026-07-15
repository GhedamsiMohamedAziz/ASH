# Runbook: NATS partition / JetStream unavailable

**Symptôme:** publish/consume qui échouent; `plat_nats_dlq_depth` en hausse; reprise WebSocket (`last_seq` replay JetStream) qui échoue.
**Diagnostic:** `nats stream report` · `platctl status` · `plat_nats_dlq_depth{subject}`.
**Remédiation:** restaurer le quorum (raft R3); les consommateurs **dédupliquent par `message_id`/`idempotency_key`** (livraison at-least-once) → le replay est sûr; `dlq-redrive` rejoue avec backoff. **Les tours en vol survivent** (ils streament via NATS, pas via le process orchestrator).
**Vérification:** stream sain; `plat_nats_dlq_depth` se draine; **aucun effet de bord dupliqué** (consommateurs idempotents).
**Post-mortem:** dimensionnement du quorum? cross-AZ? les streams JetStream sont-ils bien re-provisionnés (`infra/nats/streams.json`)?
