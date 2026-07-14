"""Price-drift guard tests (§9.5) — the packaged config must match the canonical reference,
and a config that prices an Anthropic-managed model wrong must refuse to load (a stale price
mis-rejects budgets and mis-bills, so it's a boot-time error not a silent approximation)."""
from __future__ import annotations

import textwrap

import pytest

from app.config import PriceDrift, load_config
from app.reference_prices import REFERENCE_PRICES


def test_packaged_config_matches_reference():
    cfg = load_config()  # the real config.yaml — must not drift
    for model, (i, o) in REFERENCE_PRICES.items():
        if model in cfg.prices:
            assert (cfg.prices[model].input, cfg.prices[model].output) == (i, o)


def test_opus_is_5_25_not_15_75():
    cfg = load_config()
    assert (cfg.prices["claude-opus-4-8"].input, cfg.prices["claude-opus-4-8"].output) == (5.0, 25.0)


def test_drift_refuses_to_load(tmp_path):
    bad = tmp_path / "config.yaml"
    bad.write_text(textwrap.dedent("""
        provider: stub
        tiers:
          frontier: { model: claude-opus-4-8, fallback: claude-sonnet-4-6 }
        prices:
          claude-opus-4-8:   { input: 15.0, output: 75.0 }
          claude-sonnet-4-6: { input: 3.0,  output: 15.0 }
    """))
    with pytest.raises(PriceDrift):
        load_config(bad)


def test_non_anthropic_model_not_checked(tmp_path):
    ok = tmp_path / "config.yaml"
    ok.write_text(textwrap.dedent("""
        provider: stub
        tiers:
          eco: { model: qwen-3-coder, fallback: null }
        prices:
          qwen-3-coder: { input: 0.99, output: 9.99 }
    """))
    cfg = load_config(ok)  # qwen isn't in the reference — arbitrary price is allowed
    assert cfg.prices["qwen-3-coder"].input == 0.99
