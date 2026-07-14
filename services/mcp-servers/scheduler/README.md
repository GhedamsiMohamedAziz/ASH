# Scheduler MCP

> **Status:** Phase 5 (AX-058, tested) · **Spec:** instructions.md §14.1, §15

MCP façade the agent uses to manage its automations. Tools (`scheduler.create_cron`,
`list_crons`, `pause_cron`, `resume_cron`, `run_now`) forward to the automation-service
(source of truth); the Gateway applies `tool_policies` (create → require_approval) and
audits each call. `create_cron` validates the expression (5 fields, no sub-15-min) and
returns a human-readable schedule for the `agent.cron.created` chip (§4.3).

```bash
npm test   # 8 tests: cron validation, humanize, tool forwarding, invalid-cron rejection
```
