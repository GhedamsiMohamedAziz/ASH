"""Canonical Anthropic price reference — the drift guard for config.yaml (§9.5).

config.yaml stays the provider-swap seam (§G.4): tiers, org overrides, and the price table
live there as data so pointing a tier at Bedrock/Foundry is a config edit. But the price table
feeds budget admission (E_BUDGET_EXCEEDED) and cost accounting, so a stale number silently
mis-rejects and mis-bills. This module is the single source of truth for the real per-1M-token
prices of Anthropic-managed models; `load_config` checks the config against it and refuses to
boot on drift. Non-Anthropic models (open-weights, org overrides) are not listed and not checked.

Update this table when Anthropic pricing changes — one place, verified against the price sheet.
"""

from __future__ import annotations

# USD per 1M tokens (input, output). Mid-2026 Anthropic list prices.
REFERENCE_PRICES: dict[str, tuple[float, float]] = {
    "claude-opus-4-8": (5.0, 25.0),
    "claude-opus-4-7": (5.0, 25.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-sonnet-4-6": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}
