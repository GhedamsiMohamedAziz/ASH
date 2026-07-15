# M365 MCP

> **Status:** Phase 1 (runnable + tested) · **Spec:** instructions.md §14 ("Bureautique &
> communication: Outlook: lire, chercher, résumer, envoyer (sous approbation). Calendrier: créer
> des événements... SharePoint/OneDrive: chercher, lire, livrer") and §997's Graph tool table.

Outlook, Calendar, SharePoint/OneDrive via Microsoft Graph (delegated OBO). The MCP Gateway (§13)
injects the user's delegated Graph token and enforces AuthZ, so this layer never sees a raw token
except via `ctx.credential`.

## Tools

The gateway (`services/mcp-gateway/src/server.ts`'s `M365_META` + `src/mcp.ts`'s `m365_*` schemas)
already registered these **five** tool names — kept unchanged by name and by `(args, ctx)` handler
shape so that registration keeps working untouched by this connector.

| Tool | Args | Read/Write | Notes |
| --- | --- | --- | --- |
| `m365.list_mail` | `folder?` (default `inbox`), `pageSize?`, `cursor?` | read | Messages in a mail folder, paginated. |
| `m365.read_mail` | `id` (required) | read | Subject + sender + body (body capped at 256 KB). |
| `m365.send_mail` | `to`, `subject`, `body` (required) | **write** | Public egress — approval-gated on a tainted turn (§17.6.2). |
| `m365.search_files` | `query` (required), `pageSize?`, `cursor?` | read | SharePoint/OneDrive files, paginated. |
| `m365.create_event` | `title`, `start` (required, ISO 8601) | **write** | Creates a 30-minute event on the user's OWN calendar — no external-attendee parameter. |

Every tool declares a strict JSON Schema (`TOOL_SCHEMAS` in `src/m365.ts`, `additionalProperties:
false`) enforced at runtime before the backend is ever called — a missing required field, a
wrong-typed field, an over-long string, or an unknown field returns `{ error: { code:
"E_VALIDATION", message } }` without a network/token round trip. Field names match the gateway's
own outer MCP schemas (`folder`, `id`, `to`/`subject`/`body`, `query`, `title`/`start`) —
`pageSize`/`cursor` are additive, optional pagination controls not yet surfaced by the gateway's
outer schema.

Reads (`list_mail`/`read_mail`/`search_files`) ingest mail/file content authored by arbitrary
senders — untrusted content that taints the task (§17.6). `send_mail` composes and delivers a
message OUTSIDE the trust boundary, so it is public egress and reclassified to
approval/`E_GUARD_TAINTED_EGRESS` on a tainted turn; `create_event` stays within the user's own
calendar (internal egress, never taint-gated) — both classifications live in the gateway's
`M365_META`, not in this connector.

## Pagination + 256 KB truncation

`m365.list_mail` / `m365.search_files` are paginated (`pageSize`/`cursor`, default 20, capped at
100) and every response is truncated to 256 KB via
`services/mcp-servers/_template/src/pagination.ts` (`paginate`, `truncateJson` — the same §14
"règles communes" helper `slack.ts`/`notion.ts`/`database.ts` use). `m365.read_mail`'s `body` isn't
an `items` array (a message has one body, not a list), so it's capped at 256 KB with a dedicated
`capBody()` helper — the same "one big field, not a list" shape `notion.ts`'s `capContent()`
handles for page content.

## Stub-vs-real seam

- **`StubM365`** (`src/m365.ts`, default backend) — offline, deterministic, no token/network. Every
  test in `test/m365.test.ts` runs against it. Its `m1` seed keeps mentioning **"Q3 review"** —
  `services/mcp-gateway/test/connectors.test.ts` asserts on that exact stub content through the
  gateway, so it must not be renamed/removed here.
- **`GraphBackend`** (`src/graph.ts`) — the real Microsoft Graph v1.0 REST API, called with the
  native `fetch` directly (no `@microsoft/microsoft-graph-client` dependency — Graph's REST surface
  is plain HTTPS/JSON, same shape as GitHub's/Slack's/Notion's, needing no SDK; mirrors
  `services/mcp-servers/github/src/rest.ts`'s precedent). This keeps the real backend **injectable
  and not a hard dependency** — there is no package to import at all on the offline/keyless default
  path.

Graph exposes two native pagination shapes, and this connector uses both (instructions.md §14
"Graph uses `@odata.nextLink` / `$top` / `$skip`"):

- `list_mail` follows the opaque `@odata.nextLink` (a full URL with an embedded `$skiptoken`)
  verbatim — the cursor IS that URL, never re-derived locally.
- `search_files` uses the OneDrive/SharePoint search endpoint's `$top`/`$skip`, so its cursor is
  the next numeric offset (mirrors `services/mcp-servers/slack/src/webapi.ts`'s `search.messages`
  page-number cursor).

`send_mail` composes a draft (`POST /me/messages`, which returns an id) and then sends that same
draft (`POST /me/messages/{id}/send`) — Graph's direct `/me/sendMail` is fire-and-forget (202, no
body) and never returns an id, so this two-step path is what gives callers a real, referenceable
message id.

## Error mapping (§21)

| Graph signal | §21 code |
| --- | --- |
| HTTP 401 | `E_CONN_TOKEN_EXPIRED` |
| HTTP 403 | `E_PERM_TOOL_DENIED` |
| HTTP 404 | `E_CONN_NEEDS_CONNECTION` (not found or not shared with this delegation — same ambiguity as GitHub's/Notion's 404) |
| HTTP 400 | `E_VALIDATION` |
| HTTP 429 | `E_RATE_LIMITED` |
| HTTP 5xx / any other status | `E_TOOL_UPSTREAM_ERROR` |
| a missing credential | `E_CONN_NEEDS_CONNECTION` (fails closed, never falls back to a shared token) |
| an invalid `create_event` start date | `E_VALIDATION` (checked before any request is sent) |

A 404 on `read_mail` specifically is translated to `null` at the backend layer, which the MCP tool
surface then reports as `{ error: { code: "E_NOT_FOUND", ... } }` — distinct from a true
connection/auth failure elsewhere, matching `notion.ts`'s `readPage` convention.

```bash
cd services/mcp-servers/m365 && npm test
# tool surface, schema validation, pagination, 256 KB truncation, StubM365 (m365.test.ts)
# + real-backend request wiring (both Graph pagination shapes) and the full §21 failure map (graph.test.ts)
```

## Known limitations

- `send_mail`'s body is plain text (`contentType: "Text"`) — no HTML composition.
- `create_event` always creates a 30-minute event with no attendees/location; the backend
  interface's `createEvent(title, startIso, ctx)` has no parameter for either yet.
- No idempotency-key handling on writes yet (§14 "règles communes" lists this as a common rule;
  `github.create_pr`/`merge_pr` don't implement it either — tracked as a cross-connector gap, not
  reintroduced ad hoc here).

## Next

- Gateway registration already exists (`services/mcp-gateway/src/server.ts`'s `M365_META` +
  `src/mcp.ts`) — out of scope for this connector, owned by `mcp-gateway`.
- HTML mail composition, event attendees/location, richer SharePoint/OneDrive search (site/library
  scoping) if agents need more than the current flat surface.
