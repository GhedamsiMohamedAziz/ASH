"""Model routing: resolve a logical tier (+ optional org override) to a concrete model.

instructions.md §9.5 — "configurable par org avec fallback automatique". An explicit
`model` bypasses routing; a `tier` is mapped through the config, with per-org overrides
winning over the tier default.
"""

from __future__ import annotations

from dataclasses import dataclass

from .config import Config


@dataclass(frozen=True)
class Route:
    primary: str
    fallback: str | None


def resolve(cfg: Config, *, tier: str | None, model: str | None, org_id: str | None) -> Route:
    """Return the (primary, fallback) models for a request.

    - explicit `model`: used as-is, no fallback (caller asked for a specific model);
    - `tier`: org override wins over the tier default; tier's configured fallback applies.
    """
    if model:
        return Route(primary=model, fallback=None)

    if tier is None:
        raise ValueError("either tier or model is required")

    route = cfg.tiers.get(tier)
    if route is None:
        raise KeyError(f"unknown tier {tier!r}")

    override = (cfg.org_overrides.get(org_id or "") or {}).get(tier)
    primary = override or route.model
    fallback = route.fallback if route.fallback != primary else None
    return Route(primary=primary, fallback=fallback)
