# Runbook: OAuth secret / token expired

**Symptôme:** `E_CONN_TOKEN_EXPIRED` / `E_CONN_NEEDS_CONNECTION` sur un fournisseur; santé connecteur dégradée.
**Diagnostic:** `platctl connectors health` · `platctl connectors probe <id>` · dernier run de `oauth-refresh-sweep`.
**Remédiation:** rotation du secret d'app fournisseur dans Vault; déclencher `oauth-refresh-sweep`; pour un token utilisateur, présenter la carte de reconnexion (`E_CONN_NEEDS_CONNECTION` + deep-link). `cert-expiry-check` aurait dû alerter à < 30 j.
**Vérification:** `platctl connectors probe <id>` OK; un appel d'outil de test injecte un credential frais (jamais exposé au sandbox).
**Post-mortem:** pourquoi `oauth-refresh-sweep` (0 */6) n'a pas rattrapé (refresh < 24 h)? granularité des scopes / rotation rotative du fournisseur (Atlassian, OBO Microsoft)?
