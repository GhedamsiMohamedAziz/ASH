# Org onboarding (instructions.md §3.5, §30)

**Mode B (recommended MVP) — a day, not weeks:**
1. Create org + admin (admin API / `platctl`).
2. Connect org service credentials (GitHub App install token, service DB read-only,
   M365 app permissions) — one Vault entry per connector (§3.1), no per-user OAuth.
3. Seed `tool_policies` defaults (`db/migrations/0003_seed_policies.sql`) + budgets.
4. Link team identities (Slack/Teams) — the only per-user step (§3.5, account
   linking `app/linking.py`).
5. Verify: run the governance demo (approval + audit + fire-time revocation).

**Mode A (personal, grands comptes)**: adds per-user OAuth flows (`app/oauth.py`).
Migration B→A is an enrichment, not a rebuild — identities + audit already in place.
