# Runbook: Sandbox node saturated

**Symptôme:** `E_SANDBOX_UNAVAILABLE` (503) en file; `plat_sandbox_pool_available` bas; réveils (`plat_sandbox_wake_seconds`) qui montent.
**Diagnostic:** `platctl status` · `platctl sandbox list` · `plat_sandbox_pool_available` / `plat_sandboxes{state}`.
**Remédiation:** `platctl sandbox drain <node>` (cordon + migration); scale le pool de nœuds; le `pool-warmer` remonte la cible; `sandbox-reaper` hiberne/détruit les IDLE pour libérer.
**Vérification:** `plat_sandbox_pool_available` ≥ cible; taux `E_SANDBOX_UNAVAILABLE` → 0; réveil IDLE→ACTIVE P95 < 500 ms.
**Post-mortem:** modèle de capacité? pénalité d'étalement (bin-packing) mal réglée? rafale de 9h00 sous-provisionnée (jitter des crons)?
