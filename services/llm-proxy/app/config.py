"""Load and expose the llm-proxy config (config.yaml): tiers, org overrides, price table.

The config is the provider-swap seam (§G.4): tier->model mappings and the price table live
here in data, so pointing a tier at a Bedrock/Foundry model is a config edit, not a code change.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

from .reference_prices import REFERENCE_PRICES

DEFAULT_CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.yaml"


class PriceDrift(ValueError):
    """config.yaml prices an Anthropic-managed model differently from the canonical reference.

    The price table drives budget admission and billing, so a stale number is a correctness
    bug, not a preference — refuse to boot rather than silently mis-reject/mis-bill (§9.5).
    """


@dataclass(frozen=True)
class Price:
    input: float   # USD per 1M input tokens
    output: float  # USD per 1M output tokens


@dataclass(frozen=True)
class TierRoute:
    model: str
    fallback: str | None


@dataclass(frozen=True)
class Config:
    provider: str
    tiers: dict[str, TierRoute]
    org_overrides: dict[str, dict[str, str]]
    prices: dict[str, Price]

    def price_for(self, model: str) -> Price:
        price = self.prices.get(model)
        if price is None:
            raise KeyError(f"no price table entry for model {model!r}")
        return price


def load_config(path: str | os.PathLike[str] | None = None) -> Config:
    """Parse config.yaml. Honors the LLM_PROXY_CONFIG env var, else the packaged default."""
    resolved = Path(path or os.environ.get("LLM_PROXY_CONFIG", DEFAULT_CONFIG_PATH))
    raw = yaml.safe_load(resolved.read_text())

    tiers = {
        name: TierRoute(model=spec["model"], fallback=spec.get("fallback"))
        for name, spec in (raw.get("tiers") or {}).items()
    }
    prices = {
        model: Price(input=float(p["input"]), output=float(p["output"]))
        for model, p in (raw.get("prices") or {}).items()
    }

    # Drift guard: any Anthropic-managed model in the table must match the canonical reference
    # (open-weights / org-override models aren't listed there and are skipped).
    for model, price in prices.items():
        ref = REFERENCE_PRICES.get(model)
        if ref is not None and (price.input, price.output) != ref:
            raise PriceDrift(
                f"config prices {model} at {price.input}/{price.output}; "
                f"canonical is {ref[0]}/{ref[1]} (update config.yaml or reference_prices.py)"
            )

    # LLM_PROXY_PROVIDER overrides the file: the committed default stays `stub` (offline, keyless
    # tests), and a live deploy sets the env to `anthropic` — the money edge is never committed.
    return Config(
        provider=os.environ.get("LLM_PROXY_PROVIDER") or raw.get("provider", "stub"),
        tiers=tiers,
        org_overrides=raw.get("org_overrides") or {},
        prices=prices,
    )
