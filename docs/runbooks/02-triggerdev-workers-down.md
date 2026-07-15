# Runbook: Trigger.dev workers down during a cron window

**Symptôme:** `plat_cron_fire_delay_seconds` P95 en hausse; `scheduled_runs` qui ne démarrent pas; workers offline sur le dashboard Trigger.dev.
**Diagnostic:** `platctl status` · état des workers Trigger.dev · `plat_cron_fire_delay_seconds` P95.
**Remédiation:** relancer les workers; à la reprise Trigger.dev **rejoue** les schedules manqués (`deduplicationKey = job_id+timestamp`, ADR-016 dedup-on-success → **zéro doublon**); si l'état a divergé, `platctl schedules resync` (idempotent, reconstruit depuis `scheduled_jobs`).
**Vérification:** `plat_scheduled_runs_total` remonte; **aucun run perdu** (retries/replay) **et aucun doublon** (idempotence); `plat_cron_fire_delay_seconds` P95 < 120 s.
**Post-mortem:** pourquoi les workers sont tombés (autoscaling? OOM?)? confirmer 0 perte / 0 doublon sur la fenêtre.
