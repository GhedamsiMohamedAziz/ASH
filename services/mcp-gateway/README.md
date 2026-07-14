# MCP Gateway

> **Status:** Phase 1 (AX-017, runnable + tested) · **Spec:** instructions.md §13.1, ADR 001

The single point of AuthZ, secret injection, DLP and audit in front of every MCP
server — a sandbox's only network egress. Every tool call goes through `call()`:

1. **Verify TASK JWT** (`shared-ts` HS256 dev / auth-service RS256 prod) — fail-closed.
2. **Re-check `allowed_tools`** from the token (defense in depth, §9.4) — the Prompt
   Layer already computed it; the Gateway re-verifies. Not allowed → `E_PERM_TOOL_DENIED`.
3. **Gate `approval_tools`** — returns `needs_approval`, never executes inline (§13.3).
4. **Inject the credential** from Vault (stubbed) — the sandbox never sees it (§13.2).
5. **Route** to the MCP server, **DLP-scrub** the result (§13.5, `dlp.ts`).
6. **Audit** every call: actor, `on_behalf_of` (team mode §3.2), tool, status, redactions (§16.1).

```
src/gateway.ts   core: verify → authz → approval → inject → route → scrub → audit
src/dlp.ts       secret redaction (scrub) + file scan (scanFile) + memory-write guard (AX-036)
src/vault.ts     AES-256-GCM token seal/open + CredentialResolver — decrypt at call time (AX-037)
src/server.ts    http surface: POST /v1/tool/call, GET /healthz, GET /audit
```

**Credential injection (AX-037):** OAuth tokens are stored **sealed** (AES-256-GCM,
Vault-held key) and decrypted ONLY here at call time, handed to the MCP server,
never returned toward the sandbox (§13.2). A missing connection → `E_CONN_NEEDS_CONNECTION`.
Tamper on the ciphertext/tag fails decryption (GCM auth). Verified: the handler
receives the real decrypted token while the stored value stays ciphertext.

**DLP (AX-036):** `scrub` masks secrets in tool results; `scanFile` reports secrets
by line in generated files (gitleaks-style, §9.3); `guardMemoryWrite` applies the
same DLP to agent memory writes (§9.1.3).

```bash
npm test                    # 9 tests (node --test)
npm start                   # :8443 — POST /v1/tool/call {tool,args,taskJwt}
```

Verified end-to-end: a TASK JWT signed by the Prompt Layer (Python/shared-py)
verifies here (TypeScript/shared-ts) — allowed→200, approval→202, unauthorized→403,
forged/expired→403, every call audited.

## Next
- Real MCP server routing (GitHub MCP AX-018) behind the handler registry.
- Vault credential resolver (AX-037) replacing the stub; mTLS ingress from sandboxes only (§17.4).
- Persist audit to the `audit_log` table (AX-039) instead of in-memory.
