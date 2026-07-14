# Orchestrator

> **Status:** Phase 1 (AX-014, compiled + tested Go) · **Spec:** instructions.md §10, ADR 008

Sandbox lifecycle + scheduling. Go for massive concurrency and low latency (ADR 008).
Tracks lifecycle and placement only — **zero secrets** live here (§11).

| File | Role |
|---|---|
| `sandbox.go` | §10.1 state machine (COLD→WARMING→ACTIVE→IDLE→HIBERNATED, ERROR/FAILED), guarded transitions, healthcheck (3-fail→ERROR), idle/hibernate sweep |
| `orchestrator.go` | warm pool (assign <500ms), per-org FIFO **priority** queues (interactive preempts scheduled — a cron never makes a human wait, §10.2), capacity quotas, stale-scheduled replanning (>15min), budget enforcement |
| `opencode.go` | **Real** OpenCode HTTP client (§12, ADR 009): `CreateSession` · `Prompt` (forwards the TASK JWT) · `StreamEvents` (SSE → AgentEvents, §10.2); maps Axone profiles → OpenCode agents. AX-016. |

```bash
cd services/orchestrator && go test ./...    # 15 tests (incl. TestRealOpenCodeServer)
go build ./...
```

`TestRealOpenCodeServer` boots the actual `opencode serve` binary and drives its
real API (create session → verify `ses_` id) — skips if opencode isn't installed.
Install: `npm i -g opencode-ai` or `brew install opencode`. The sandbox image
installs it via npm (`sandbox/Dockerfile`).

Covered + verified: legal/illegal transitions, healthcheck failure, idle→hibernate
timers, warm-pool fast assign, org capacity → queue overflow, **interactive preempts
scheduled**, stale-run replan, budget (time + cost) enforcement.

## Next
- gRPC surface (§10.3: SubmitTask streaming AgentEvent, CancelTask, GetSandboxStatus, Hibernate, AdminList).
- Real container driver (Docker/containerd API) + gVisor RuntimeClass (AX-016, §11.2, ADR 002).
- SSE relay from OpenCode → NATS `agent.events.{conversation_id}` (§10.2); leader election.
