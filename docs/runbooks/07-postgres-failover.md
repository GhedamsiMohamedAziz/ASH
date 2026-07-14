# Runbook: Postgres failover

**Symptôme:** PostgresPrimaryDown page; writes failing.
**Diagnostic:** CloudNativePG status · replica lag · RPO check (WAL archive age).
**Remédiation:** promote replica (auto via operator); confirm no split-brain; resync old primary.
**Vérification:** writes succeed; replica lag < 15min (RPO §23).
**Post-mortem:** cause of primary loss; was RPO met?
