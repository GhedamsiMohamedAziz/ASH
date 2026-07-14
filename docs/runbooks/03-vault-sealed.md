# Runbook: Vault sealed

**Symptôme:** VaultSealed page; OAuth refresh + credential injection failing (E_CONN_*).
**Diagnostic:** `vault status` · `platctl connectors health` · check auto-unseal (KMS) health.
**Remédiation:** unseal (KMS auto or quorum keys); verify in-flight oauth-refresh-sweep re-runs.
**Vérification:** `vault_core_unsealed == 1`; a test tool call injects a credential.
**Post-mortem:** why did auto-unseal fail? KMS access? node restart?
