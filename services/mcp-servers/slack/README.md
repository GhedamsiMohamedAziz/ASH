# Slack MCP

> **Status:** Phase 1 (runnable + tested) · **Spec:** instructions.md §14 ("Slack | Slack Web API |
> `send_message`, `search_messages`, `read_channel`, `upload_file` | User token OAuth Slack")

Read channels/threads, search, post messages, upload files. Distinct from the inbound
slack-adapter (`apps/slack-adapter`), which handles Slack's webhook events INTO the platform —
this is the outbound tool surface an agent calls. The MCP Gateway (§13) injects the user's Slack
OAuth token and enforces AuthZ, so this layer never sees a raw token except via `ctx.credential`.

## Tools

| Tool | Args | Read/Write | Notes |
| --- | --- | --- | --- |
| `slack.read_channel` | `channel` (required), `pageSize?`, `cursor?` | read | Recent messages, paginated. |
| `slack.read_thread` | `channel`, `threadTs` (required), `pageSize?`, `cursor?` | read | Replies in a thread. |
| `slack.search_messages` | `query` (required), `pageSize?`, `cursor?` | read | Workspace search; needs a **user token** (see below). |
| `slack.send_message` | `channel`, `text` (required), `threadTs?` | **write** | Post a message; `threadTs` replies in-thread. |
| `slack.post_recap` | `channel`, `text` (required) | **write** | Pre-existing tool, kept for back-compat — top-level-only post, returns just `{ ts }`. |
| `slack.upload_file` | `channel`, `filename`, `content` (required), `title?` | **write** | Upload a UTF-8 text file. |

Every tool declares a strict JSON Schema (`TOOL_SCHEMAS` in `src/slack.ts`, `additionalProperties:
false`) enforced at runtime before the backend is ever called — a missing required field, a
wrong-typed field, an over-long string, or an unknown field returns `{ error: { code:
"E_VALIDATION", message } }` without a network/token round trip.

Writes (`send_message`, `post_recap`, `upload_file`) are kept as distinct, separately named tools
from reads so a later gateway registration pass can set `egressClass`/`ingestsUntrusted` per tool
(§17.6.2) without touching this connector again — that registration is a **separate follow-up**,
out of scope here.

## Pagination + 256 KB truncation

`slack.read_channel` / `slack.read_thread` / `slack.search_messages` are paginated
(`pageSize`/`cursor`, default 20, capped at 200) and every response is truncated to 256 KB via
`services/mcp-servers/_template/src/pagination.ts` (`paginate`, `truncateJson` — the same §14
"règles communes" helper `database.ts` and `browser.ts` use). Unlike `database.ts`'s `DbBackend`
(which returns a full row set the MCP layer slices client-side), `SlackBackend`'s read methods take
their own `{cursor, pageSize}` — a Slack channel/search result set can be arbitrarily large, so
pagination has to be native to the backend call, not layered on top of an already-fetched array.

## Stub-vs-real seam

- **`StubSlack`** (`src/slack.ts`, default backend) — offline, deterministic, no token/network.
  Every test in `test/slack.test.ts` runs against it.
- **`WebApiBackend`** (`src/webapi.ts`) — the real Slack Web API, called with the native `fetch`
  directly (no `@slack/web-api` dependency — Slack's Web API is a plain HTTPS/JSON REST surface,
  same shape as GitHub's, needing no SDK; mirrors `services/mcp-servers/github/src/rest.ts`'s
  precedent). This keeps the real backend **injectable and not a hard dependency** — stronger than
  an optional lazy import, since there is no package to import at all on the offline/keyless
  default path. `search.messages` in particular requires a **user token**, not a bot token, which
  is why the identity in §14 is "User token OAuth Slack".

## Error mapping (§21)

Slack's Web API is unusual: almost every failure still returns **HTTP 200** with `{ ok: false,
error: "<code>" }` in the body — a real rate limit is the one case that surfaces as an actual
**HTTP 429**. `src/webapi.ts` maps both shapes to the same named taxonomy code:

| Slack signal | §21 code |
| --- | --- |
| `invalid_auth` / `token_expired` / `token_revoked` / `account_inactive` | `E_CONN_TOKEN_EXPIRED` |
| `not_authed` / `no_permission` / `org_login_required` | `E_CONN_NEEDS_CONNECTION` |
| `missing_scope` / `restricted_action` / `ekm_access_denied` | `E_PERM_TOOL_DENIED` |
| `channel_not_found` / `thread_not_found` / `user_not_found` / ... | `E_CONN_NEEDS_CONNECTION` (not found or no access — same ambiguity as GitHub's 404) |
| `ratelimited` (body) or HTTP 429 | `E_RATE_LIMITED` |
| HTTP 5xx / any other `ok:false` error | `E_TOOL_UPSTREAM_ERROR` |
| a missing credential | `E_CONN_NEEDS_CONNECTION` (fails closed, never falls back to a shared token) |

```bash
cd services/mcp-servers/slack && npm test
# tool surface, schema validation, pagination, 256 KB truncation, StubSlack (slack.test.ts)
# + real-backend request wiring and the full §21 failure map (webapi.test.ts)
```

## Known limitations

- `slack.upload_file` uses the classic `files.upload` JSON endpoint (text content only). Slack's
  newer 3-step external-upload flow (`files.getUploadURLExternal` → PUT the bytes →
  `files.completeUploadExternal`) is the production path for large/binary files — out of scope
  here.
- No idempotency-key handling on writes yet (§14 "règles communes" lists this as a common rule;
  `github.create_pr`/`merge_pr` don't implement it either — tracked as a cross-connector gap, not
  reintroduced ad hoc here).

## Next

- Register these tools with the running gateway (`mcp-gateway/src/mcp.ts`'s `MCP_TOOLS`, the way
  `github.*` is) and set `ingestsUntrusted`/`egressClass` per tool (§17.6.2) — out of scope for
  this connector (owned by `mcp-gateway`, a separate follow-up).
- `files.upload`'s external-upload flow for binary/large files.
