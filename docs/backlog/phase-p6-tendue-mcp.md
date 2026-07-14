# P6 — Étendue MCP

> M365, Browser, Database, Notion, Slack connectors.  ·  _3 wk_  ·  7 tickets

## ✅ AX-068 — M365 MCP (Graph delegated)

Outlook/Teams/Calendar/SharePoint via MS Graph, delegated (OBO); read/search/summarize/send (approval).

- **Estimate:** L  ·  **Labels:** mcp-server, m365  ·  **Spec:** §14
- **Depends on:** AX-017, AX-038
- **Acceptance:**
  - [ ] Read + summarize mail
  - [ ] send behind approval
  - [ ] delegated scopes only

## ✅ AX-069 — Browser MCP (hardened Playwright pool)

Headless Playwright pool: read/click/fill/download/capture; sandboxed, resource-capped.

- **Estimate:** L  ·  **Labels:** mcp-server, browser  ·  **Spec:** §14
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Page read + structured extract
  - [ ] downloads to S3
  - [ ] pool autoscales, capped

## ✅ AX-070 — Database MCP (capped SELECT)

Schema introspection + capped read-only SELECTs + internal APIs; write behind deny/approval.

- **Estimate:** M  ·  **Labels:** mcp-server, database  ·  **Spec:** §14
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Schema listed
  - [ ] SELECT row/time capped
  - [ ] writes denied for member

## ✅ AX-071 — Notion MCP

Create/read minutes, specs, wikis in Notion.

- **Estimate:** M  ·  **Labels:** mcp-server, notion  ·  **Spec:** §14
- **Depends on:** AX-017, AX-038
- **Acceptance:**
  - [ ] Page create/read
  - [ ] search works
  - [ ] approval on writes where policy

## ✅ AX-072 — Slack MCP

Read channels and post recaps (distinct from the inbound Slack adapter).

- **Estimate:** M  ·  **Labels:** mcp-server, slack  ·  **Spec:** §14
- **Depends on:** AX-017
- **Acceptance:**
  - [ ] Read channel history
  - [ ] post recap
  - [ ] scoped to bot token

## ✅ AX-073 — Connector onboarding process

Industrialized checklist/template to add a connector (scopes, policies, tests, docs).

- **Estimate:** S  ·  **Labels:** mcp-server, dx  ·  **Spec:** §14.3
- **Depends on:** AX-068
- **Acceptance:**
  - [ ] Template + checklist
  - [ ] new connector in <X days
  - [ ] policy+eval coverage required

## ✅ AX-074 — P6 exit: 7 connectors in internal prod

GitHub+M365+Browser+DB+Notion+Slack+Scheduler live internally.

- **Estimate:** S  ·  **Labels:** milestone  ·  **Spec:** §29 P6
- **Depends on:** AX-068, AX-069, AX-070, AX-071, AX-072
- **Acceptance:**
  - [ ] 7 connectors operational
  - [ ] internal dogfood passing
  - [ ] P6 exit gate green
