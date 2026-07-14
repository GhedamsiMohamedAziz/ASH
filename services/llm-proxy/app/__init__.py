"""llm-proxy — the single choke point for every LLM call (instructions.md §9.5, §26).

Centralizes model routing, per-call budgets, usage/cost accounting and multi-provider
failover so provider-swap (Anthropic direct / Bedrock / Foundry, §G.4) is a config change.
"""
