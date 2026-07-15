# Notion MCP

> **Status:** Phase 1 (runnable + tested) · **Spec:** instructions.md §14 ("Notion | Notion API |
> `search`, `read_page`, `create_page`, `update_page` | Token OAuth utilisateur")

Minutes, specs, wikis. The MCP Gateway (§13) injects the user's Notion integration token and
enforces AuthZ, so this layer never sees a raw token except via `ctx.credential`.

## Tools

| Tool | Args | Read/Write | Notes |
| --- | --- | --- | --- |
| `notion.search` | `query` (required), `pageSize?`, `cursor?` | read | Title/content search, paginated. |
| `notion.read_page` | `id` (required) | read | Title + flattened content (capped at 256 KB) + url. |
| `notion.create_page` | `parentId`, `title` (required), `content?` | **write** | New page under a parent page. |
| `notion.update_page` | `id` (required), `title?`, `appendContent?` | **write** | Rename and/or append content — at least one of `title`/`appendContent` is required. |

Every tool declares a strict JSON Schema (`TOOL_SCHEMAS` in `src/notion.ts`, `additionalProperties:
false`) enforced at runtime before the backend is ever called — a missing required field, a
wrong-typed field, an over-long string, or an unknown field returns `{ error: { code:
"E_VALIDATION", message } }` without a network/token round trip.

Writes (`create_page`, `update_page`) are kept as distinct, separately named tools from reads so a
later gateway registration pass can set `egressClass`/`ingestsUntrusted` per tool (§17.6.2) without
touching this connector again — that registration is a **separate follow-up**, out of scope here.

## Pagination + 256 KB truncation

`notion.search` is paginated (`pageSize`/`cursor`, default 20, capped at 100) and its response
truncated to 256 KB via `services/mcp-servers/_template/src/pagination.ts` (`paginate`,
`truncateJson` — the same §14 "règles communes" helper `database.ts` and `browser.ts` use).
`notion.read_page`'s `content` isn't an `items` array (a page has one body, not a list), so it's
capped at 256 KB with a dedicated `capContent()` helper — the same "one big field, not a list"
shape `browser.ts`'s `cap()` handles for raw page bodies.

## Stub-vs-real seam

- **`StubNotion`** (`src/notion.ts`, default backend) — offline, deterministic, no token/network,
  with a real (if tiny) in-memory page store: `create_page`/`update_page` mutate it, so a page
  created via the stub is immediately `read_page`-able and reflects renames/appends. Every test in
  `test/notion.test.ts` runs against it.
- **`NotionRestBackend`** (`src/api.ts`) — the real Notion API, called with the native `fetch`
  directly (no `@notionhq/client` dependency — Notion's API is a plain HTTPS/JSON REST surface,
  same shape as GitHub's, needing no SDK; mirrors `services/mcp-servers/github/src/rest.ts`'s
  precedent). This keeps the real backend **injectable and not a hard dependency** — stronger than
  an optional lazy import, since there is no package to import at all on the offline/keyless
  default path.

Notion models a page's body as a block tree, not a single field: `readPage()` fetches the page (for
title/url) plus its top-level block children (for a flattened text body, one line per paragraph
block); `createPage()`/`updatePage()` write through the matching `POST /pages` / `PATCH
/pages/{id}` / `PATCH /blocks/{id}/children` endpoints.

## Error mapping (§21)

| Notion signal | §21 code |
| --- | --- |
| HTTP 401 (`unauthorized`) | `E_CONN_TOKEN_EXPIRED` |
| HTTP 403 (`restricted_resource`) | `E_PERM_TOOL_DENIED` |
| HTTP 404 (`object_not_found`) | `E_CONN_NEEDS_CONNECTION` (not found or not shared with this integration — same ambiguity as GitHub's 404) |
| HTTP 400 (`validation_error`) | `E_VALIDATION` |
| HTTP 429 (`rate_limited`) | `E_RATE_LIMITED` |
| HTTP 5xx / any other status | `E_TOOL_UPSTREAM_ERROR` |
| a missing credential | `E_CONN_NEEDS_CONNECTION` (fails closed, never falls back to a shared token) |

A 404 on `readPage`/`updatePage` specifically is translated to `null` at the backend layer, which
the MCP tool surface then reports as `{ error: { code: "E_NOT_FOUND", ... } }` — distinct from a
true connection/auth failure elsewhere, matching `database.ts`'s `describe()` convention for "the
identifier you asked about doesn't exist" vs. a taxonomy-level connection error.

```bash
cd services/mcp-servers/notion && npm test
# tool surface, schema validation, pagination, 256 KB truncation, StubNotion (notion.test.ts)
# + real-backend request wiring (block-tree read/write) and the full §21 failure map (api.test.ts)
```

## Known limitations

- `read_page`/`create_page`/`update_page` handle plain-text `paragraph` blocks only — no rich
  formatting, headings, lists, tables, or nested blocks. A real editor surface would need the full
  Notion block-type union; out of scope here.
- No idempotency-key handling on writes yet (§14 "règles communes" lists this as a common rule;
  `github.create_pr`/`merge_pr` don't implement it either — tracked as a cross-connector gap, not
  reintroduced ad hoc here).

## Next

- Register these tools with the running gateway (`mcp-gateway/src/mcp.ts`'s `MCP_TOOLS`, the way
  `github.*` is) and set `ingestsUntrusted`/`egressClass` per tool (§17.6.2) — out of scope for
  this connector (owned by `mcp-gateway`, a separate follow-up).
- Rich block-type support (headings, lists, tables) if agents need more than flat paragraphs.
