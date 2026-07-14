# Security test coverage (AX-088 — maps pentest scope → runnable tests)

Each attack surface in `pentest-scope.md` has automated adversarial coverage:

| Attack surface | Verified by |
|---|---|
| TASK JWT forgery/replay | `mcp-gateway/test/gateway.test.ts` (forged/expired → denied); `packages/shared-py` alg:none |
| Tool authz bypass (defense in depth) | `gateway.test.ts` (tool not in allowed_tools → E_PERM_TOOL_DENIED) |
| Confused-deputy (Mode B on_behalf_of) | `prompt-layer/tests/test_team_mode.py` (member can't merge with org rights) |
| Prompt-injection → escalation | `test_guardrails.py`, `evals/runner.py` adversarial corpus |
| SSRF via Browser MCP | `mcp-servers/browser/test/browser.test.ts` (localhost/169.254/non-http blocked) |
| SQLi / write via Database MCP | `mcp-servers/database/test/database.test.ts` (writes + multi-statement denied) |
| Credential exfiltration | `vault.test.ts` (AES-GCM tamper fails; sandbox never sees plaintext) |
| Secret in memory / third-party facts | `test_memory_mcp.py` hygiene guards |
| Secrets in repo | `gitleaks dir . -c .gitleaks.toml` → no leaks |

**Run:** `make test-all` (adversarial tests included) + `gitleaks dir . -c .gitleaks.toml`.
A full external pentest (professional, against the deployed cluster) closes the
remaining scope — sandbox escape (gVisor), network egress lockdown — before go-live.
