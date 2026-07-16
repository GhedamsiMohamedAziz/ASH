# Plan — per-turn identity for OpenCode (real multi-user)

Status: **proposed** · Owner: TBD · Risk: **high** (reworks shipped autolearn + write-approval)

## 1. Problem

The chat runs each turn through `opencode serve`. OpenCode reads its MCP `Authorization`
header **once at process startup** from its config (`sandbox/opencode.json` →
`mcp.mcp-gateway.headers.Authorization`), so it presents the **same static TASK JWT** to the
gateway on every request. Consequences:

1. **Identity is fixed.** Every chat resolves at the gateway as whatever `sub` that static JWT
   carries (today `usr_mehdi`). Two users cannot share one running OpenCode.
2. **Taint is sticky.** The gateway's taint ledger is keyed by the JWT's `task_id`. A static
   JWT reuses one `task_id`, so once any turn ingests untrusted content (a GitHub read), the
   `task_id` stays tainted for the whole process life — and every later public-egress tool
   (incl. auto-mounted mcpmarket skills, `SAFE_META` = public) then needs approval. This is the
   friction documented in the autolearn work; the mechanism is correct, the static `task_id`
   is the cause.
3. **The scheduled-taint egress gate isn't exercised** interactively (origin is always
   `interactive` on the static JWT).

The runner **already mints a correct per-turn JWT** (`runner._opencode_task_jwt` → prompt-layer
`POST /v1/plan`) and writes it to `OPENCODE_TASK_JWT_PATH` (`runner._write_task_jwt`). OpenCode
just never reads it — the header is resolved from config at startup, not per request.

## 2. Approach: a per-turn JWT-injecting proxy

Insert a tiny local reverse-proxy between OpenCode and the gateway:

```
OpenCode ──(static placeholder header)──▶  jwt-proxy  ──(per-turn TASK JWT)──▶  MCP Gateway /mcp
```

- OpenCode's config points its MCP server at the proxy (`http://127.0.0.1:<proxyPort>/mcp`).
- On each request, the proxy **replaces** the `Authorization` header with the **current
  per-turn JWT** and forwards to the real gateway `/mcp`, streaming the response back verbatim.
- The runner writes the per-turn JWT (already does) to a location the proxy reads.

This gives OpenCode per-turn identity **without** OpenCode needing to rotate its own header.

### Which JWT for which request?
The proxy must map an incoming OpenCode request to the right per-turn JWT.
- **v1 (single active turn, local):** the runner writes the current JWT to a file; the proxy
  reads the newest file content per request. Correct because the local runner serializes turns.
- **v2 (concurrent turns / multi-user):** key the JWT by OpenCode **session id**. The runner
  creates the OpenCode session, so it knows the `sessionID`; write a `{sessionID → jwt}` map
  (Redis in prod). The proxy reads OpenCode's `Mcp-Session-Id` (or the session in the JSON-RPC
  envelope) and selects the matching JWT. **Fail-closed:** no mapping → reject (no fallback to a
  shared identity).

Start with v1 to validate the mechanism; design the store interface so v2 is a swap.

## 3. The hard part: tool-authorization reconciliation

The per-turn JWT that prompt-layer mints today is **not** drop-in compatible with the two
features shipped against the static JWT. Both must be reconciled or they regress:

| Feature | Static-JWT model (today) | Per-turn JWT (prompt-layer) | Fix needed |
|---|---|---|---|
| **Autolearn** | JWT carries `mcpmarket_*` wildcard → learned tools authorized | prompt-layer emits only concrete tools, **no wildcard** | Have prompt-layer add `mcpmarket_*` to `allowed_tools` (a deliberate grant, gated the same way `mcpmarket.request_register` is `allow`) |
| **Interactive write approval** | `create_or_update_file` in **allowed_tools** + OpenCode permission `"ask"` is the gate | prompt-layer policy = `require_approval` → tool lands in **approval_tools** (gateway gate) | Decide ONE gate. Recommended: keep OpenCode-permission as the human gate → prompt-layer must emit the write tool in `allowed_tools` for the OpenCode path (or the proxy promotes it). Otherwise the gateway returns `needs_approval` and the OpenCode permission relay never fires. |

**Prerequisite:** prompt-layer (`:8010`) must be **running** — it is currently down, so the
per-turn path silently falls back to the static JWT. Add it to the run scripts + a health check.

## 4. Implementation steps (ordered, verify each)

1. **Stand up prompt-layer** (`:8010`) in the local run scripts; assert `/v1/plan` mints a JWT
   for a given `{sub, org_id}` and that its `sub`/`task_id`/`origin` are per-turn.
2. **prompt-layer tool set:** add `mcpmarket_*` to the computed `allowed_tools`; place
   `github.create_or_update_file` per the chosen write gate (§3). Add tests.
3. **jwt-proxy** (new small service, mirrors `demo-utils` style): forward `POST /mcp` to the
   gateway, swap `Authorization` for the current per-turn JWT; stream body + pass through
   `Mcp-Session-Id`. Reject when no JWT is available (fail-closed). Unit-test header swap +
   fail-closed.
4. **Runner wiring:** ensure `_opencode_turn` writes the per-turn JWT where the proxy reads it
   (extend `_write_task_jwt`); key by `sessionID` for v2.
5. **OpenCode config:** point `mcp.mcp-gateway.url` at the proxy; header becomes a static
   placeholder the proxy overwrites.
6. **Re-verify the shipped features under per-turn identity:**
   - Real GitHub as the *logged-in* user (not `usr_mehdi`) — dev-login as two different users,
     confirm each resolves to its own connector token.
   - Autolearn: search → connect → **same-session** use no longer sticky-tainted (fresh
     `task_id` per turn) — the sha256 proof, now autonomous even after a GitHub read.
   - Write approval: OpenCode `"ask"` still pauses; deny path still blocks; approve path lands.
7. **Scheduled-taint gate:** with real per-turn origin, add a webhook/scheduled turn test that a
   tainted scheduled turn hits `E_GUARD_TAINTED_EGRESS`.

## 5. Risks, mitigations, rollback

- **Regression of autolearn / write-approval** → gate the whole change behind
  `OPENCODE_MCP_URL` pointing at the proxy; unset → today's static-JWT path unchanged. Land
  incrementally; keep every existing test green.
- **Proxy is a new hop / SPOF** → tiny, dependency-free, same host; on proxy error fail-closed
  (turn errors, no unauth call). Add a health check.
- **Wrong-JWT selection (v2)** → session-keyed map + fail-closed; never fall back to a shared
  identity (that's the bug we're removing).
- **Rollback:** revert OpenCode's MCP url to the gateway; the static-JWT path is untouched.

## 6. Prod notes
Redis-backed `{sessionID → jwt}` store shared by runner + proxy; ES256/JWKS TASK JWTs (the
existing seam); the proxy co-located with the sandbox egress. The shared taint ledger
(`REDIS_URL` for gateway + prompt-layer) must be wired for the per-turn taint to be authoritative.

## 7. Definition of done
Two different dev-login users chat through one OpenCode and each resolves to their **own**
identity + connectors; autolearn is autonomous within a session (no sticky taint); write
approval still gates; all existing suites stay green; the scheduled-taint egress gate has a test.
