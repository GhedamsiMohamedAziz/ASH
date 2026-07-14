# Runbook: LLM provider down

**Symptôme:** `agent.error(E_TOOL_UPSTREAM_ERROR)` spike; ApiDown/latency page.
**Diagnostic (≤3):** `platctl status` · `platctl connectors health` · PromQL `up{job="llm-proxy"}`.
**Remédiation:** LiteLLM auto-fails over (§9.5); if stuck, force the channel in llm-proxy config (Anthropic direct ↔ Bedrock ↔ Foundry, §G.4) and redeploy via commit (GitOps).
**Vérification:** first-token P95 back < 5s; error rate to 0.
**Post-mortem (5 pourquoi):** why did failover not trigger automatically?
