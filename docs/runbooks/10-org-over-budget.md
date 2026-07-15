# Runbook: Org blowing its budget

**Symptôme:** page `BudgetOrg` (ticket à 80 % / blocage à 100 %); `E_BUDGET_EXCEEDED` (402) en hausse pour l'org.
**Diagnostic:** `platctl status` · `platctl audit tail --filter org=<org>` · rollup `usage_daily` de l'org (ventilé `interactive`/`scheduled`).
**Remédiation:** **jamais de coupure sèche en cours de tour** (on finit le tour puis blocage doux + notification); `platctl budget set --org <org> --monthly <n>` si légitime; en cas d'automatisation emballée, `platctl jobs pause --org <org>`; vérifier `plat_llm_cache_hit_ratio` (< 0,60 → presque toujours un adaptateur qui injecte un timestamp et casse le cache).
**Vérification:** la courbe de dépense de l'org s'aplatit; `E_BUDGET_EXCEEDED` seulement au plafond voulu; aucune coupure en cours de tâche.
**Post-mortem:** quelle automatisation/utilisateur a tiré le coût? hit rate de cache? quota **par demandeur** (Mode B) à instaurer pour que l'enthousiaste ne consomme pas le budget de l'équipe?
