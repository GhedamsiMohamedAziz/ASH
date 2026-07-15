# Runbook: DLQ growing despite redrive

**Symptôme:** `plat_nats_dlq_depth` continue de monter **après** `dlq-redrive`; messages poison.
**Diagnostic:** `platctl dlq list` · inspecter un payload échantillon · `plat_nats_dlq_depth{subject}`.
**Remédiation:** identifier le poison (violation de schéma / outil en échec permanent); corriger la cause racine **ou** parquer vers un subject de quarantaine; `platctl dlq redrive` **uniquement** les récupérables — **jamais de boucle infinie sur le poison**.
**Vérification:** la profondeur DLQ se draine et reste plate; les messages rejoués sont traités **exactement une fois** (dédup par `idempotency_key`).
**Post-mortem:** origine du poison (tolerant-reader / évolution de schéma non-additive violée)? ajouter un cas au golden set / corpus de contrats.
