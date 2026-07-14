"""Usage/cost computation from the per-model price table (instructions.md §9.5).

Cost is derived, never trusted from a backend: `cost = in/1M*in_price + out/1M*out_price`.
`estimate_cost` gives the pre-call worst case (assume max_tokens are all generated) used
for budget admission control.
"""

from __future__ import annotations

from .config import Config


def token_estimate(text: str) -> int:
    """Deterministic offline token estimate (~4 chars/token). Good enough for stub + budgets."""
    return max(1, len(text) // 4)


def compute_cost(cfg: Config, model: str, tokens_in: int, tokens_out: int) -> float:
    price = cfg.price_for(model)
    cost = (tokens_in / 1_000_000) * price.input + (tokens_out / 1_000_000) * price.output
    return round(cost, 8)


def estimate_cost(cfg: Config, model: str, tokens_in: int, max_tokens: int) -> float:
    """Worst-case pre-call cost: known input + a full `max_tokens` of output."""
    return compute_cost(cfg, model, tokens_in, max_tokens)
