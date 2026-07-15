# mcpmarket auto-register bridge — design

**Goal:** the platform can pull an MCP server from a marketplace (mcpmarket) and
**auto-register its tools in the Gateway**, so the agent stops hitting "I don't
have a tool for X". "Autolearn" = *discover → register (gated) → approve once →
first-class tool*. Never silent execution of arbitrary marketplace code.

This is the strategic answer to capability gaps (chosen over hand-writing each
connector). It must not weaken the security model (§13, §17.6, invariant #8).

---

## The non-negotiable security guardrail

Invariant #8: *every tool declares its taint metadata mechanically at
registration; the Gateway only runs vetted tools with policies + audit.* An
auto-pulled tool has none of that by default — so:

1. **Most-restrictive taint by default.** Any auto-registered tool gets
   `ingests_untrusted = true` and `egress_class = "public"` — so it taints the
   turn on any result and is reclassified/gated on a tainted turn. A server MAY
   *declare* looser metadata, but a declaration is a **claim**, not proof:
   accept a declared `egress_class` only after human approval; until then the
   safe default stands. (Detection is not a boundary — §17.6.1.)
2. **`require_approval` policy by default.** Auto-registered tools land in
   `tool_policies` as `require_approval` for every role until a human/admin
   promotes them. The agent can *see* and *propose* them; it cannot freely
   *run* them.
3. **Full existing chain still applies** — JWT auth, per-user `allowed_tools`,
   DLP scrub, append-only audit, per-call credential injection. Nothing about
   auto-registration bypasses `gw.call()`.
4. **No arbitrary local code execution.** The bridge speaks MCP (JSON-RPC over
   HTTP/streamable) to a *remote* server. It never `npm install`s or `exec`s a
   marketplace package into the gateway process. Remote tool call → the remote
   server runs it → result flows back through the DLP/audit path.
5. **Provenance recorded.** Every auto-registered tool's audit rows carry
   `source = mcpmarket:<server-id>` so a compromised marketplace server is
   traceable and revocable (`platctl mcpmarket revoke <server>`).

---

## Architecture

```
  agent ("I lack tool X")
    │  mcpmarket.search "list github repos"           (meta-tool, allow)
    ▼
  Gateway  ──catalog lookup──►  mcpmarket catalog (config-driven; real API = seam)
    │                             {id, name, desc, mcp_url, category}
    │  proposes: register <server>?  → agent.approval.needed (admin approver)
    ▼  (on approval)
  RemoteMcpProxy.register(server)
    │  MCP tools/list  ─────►  remote MCP server (HTTP)
    │  for each tool: gw.register(name, remoteDispatch, {ingestsUntrusted:true,
    │                            egressClass:"public"})           ← safe default
    │  seed tool_policies(effect=require_approval) for the org
    ▼
  tools now visible; a human promotes (platctl / Mon agent) → first-class
```

**RemoteMcpProxy** (new gateway module): given `{id, mcp_url}`, connects, does
`tools/list`, and for each tool registers a dispatcher that forwards
`tools/call` to the remote server (Bearer/creds from the vault if the server
needs auth). Timeout, circuit breaker, 256 KB truncation, retries — reuse the
`_template` `ResilientHttpClient` pattern.

**Catalog** (`services/mcp-gateway/mcpmarket-catalog.json` or backend config):
a list of known MCP servers `{id, name, description, mcp_url, category, needs_auth}`.
The real mcpmarket registry API is a **swap-in** behind `mcpmarketSource()`
(ADR-012 seam) — config-driven default, real API when configured. (We have no
verified offline access to mcpmarket's API, so the catalog is seeded from known
servers; wiring the live API is a config change, not a rearchitecture.)

**Agent-facing meta-tool** `mcpmarket.search {query}` (allow, read-only): searches
the catalog, returns candidates. `mcpmarket.request_register {server_id}` →
raises `agent.approval.needed` (admin approver group). Approval → register.

**Admin / platctl:**
```
platctl mcpmarket search <query>
platctl mcpmarket register <server_id>        # register with safe defaults
platctl mcpmarket promote <tool_pattern>      # require_approval -> allow (+ set real taint)
platctl mcpmarket list | revoke <server_id>
```

---

## Data / policy

- `mcp_servers` table (new): `{id, name, mcp_url, status(pending|active|revoked),
  registered_by, registered_at, declared_meta jsonb}`.
- Registering seeds `tool_policies(effect='require_approval')` per org for each
  tool; `promote` flips a specific tool to `allow` and (optionally) relaxes its
  taint from the safe default to the human-reviewed value.

---

## Build phases

1. **RemoteMcpProxy** — connect to a remote MCP server, `tools/list`, register
   each tool with safe-default taint + a forwarding dispatcher, in `gw.call`'s
   chain. Tests: register a mock remote server → its tools appear + a call
   forwards + is audited + tainted; a not-promoted tool is `require_approval`.
2. **Catalog + meta-tools** — `mcpmarket.search` / `request_register`, catalog
   config + `mcpmarketSource()` seam. Approval → register flow.
3. **platctl + `mcp_servers` table + promote/revoke.**
4. **Security review** — the new attack surface: a marketplace server that
   lies about taint (must not be trusted pre-approval), a tool that smuggles
   egress, SSRF via `mcp_url`, an unbounded remote response, auth-token leakage
   to a remote server. Adversarial pass before shipping.

## Out of scope (flag, don't fake)
- Live mcpmarket registry API (config-driven catalog until their API is wired).
- Auto-*promotion* (staying `require_approval` until a human acts is the point).
- Sandboxed local MCP servers (remote-only; local `exec` is a separate,
  harder isolation problem — the sandbox/gVisor story, Annexe 4).
