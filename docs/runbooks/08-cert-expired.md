# Runbook: Certificate / secret expiry

**Symptôme:** échecs de handshake TLS / page `cert-expiry`; mTLS sandbox↔gateway ou gateway↔serveurs MCP qui échoue.
**Diagnostic:** `platctl status` · état cert-manager · dernier rapport `cert-expiry-check` (alertes < 30 j).
**Remédiation:** renouveler via cert-manager (Let's Encrypt / CA interne); si un `kid` de clé TASK JWT est affecté, rotation des clés — **le JWKS se recharge tout seul toutes les 5 min (`TASK_JWT_JWKS_RELOAD_SECONDS`), zéro redéploiement**, l'ancienne clé reste vérifiable 24 h.
**Vérification:** cert `notAfter` > 30 j; un appel d'outil sur mTLS réussit; la Gateway a pris le nouveau `kid` (reload JWKS, fail-safe : dernier keyset valide conservé sinon).
**Post-mortem:** pourquoi `cert-expiry-check` (0 7 * * *) n'a pas déclenché le renouvellement? trou d'automatisation à combler (auto-remédiation avant alerte)?
