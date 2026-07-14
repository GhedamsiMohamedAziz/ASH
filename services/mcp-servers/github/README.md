# GitHub MCP

> **Status:** Phase 1 (AX-018, runnable + tested) · **Spec:** instructions.md §14

Wave-1 connector. Tools: `github.search`, `github.read`, `github.create_pr`,
`github.merge_pr`, `github.list_issues`. The MCP Gateway (§13) injects the
credential and enforces AuthZ, so this layer never sees a raw user token.

- **Pluggable backend** (`github.ts`): `StubBackend` is offline + deterministic so
  the whole chain runs with no token/network; a real backend using the GitHub REST
  API / Octokit drops in behind `GithubBackend` with no change to the tool surface.
- **Team-mode trailer** (§3.2): `create_pr` attaches `Requested-by: <user>` +
  `Co-authored-by:` so the Git history names who asked, not just the bot.

```bash
npm test    # 7 tests: unit + 3 integration THROUGH the gateway (allowed/denied/approval-gated)
```

Verified: registered behind `mcp-gateway`, a TASK JWT drives a real tool call —
`create_pr` (allowed) → ok, `merge_pr` (not in JWT) → denied, `merge_pr`
(approval tool) → needs_approval. Full moat chain: TASK JWT → gateway → connector.

## Next
- Real Octokit backend behind `GithubBackend` (GitHub App installation token in team mode, §3.1).
- Register these tools with the running gateway server (currently wired in tests).
