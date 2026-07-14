"""Tests for llm-proxy (AX-020): routing, budgets, fallback, cost."""

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.backends import FailingBackend, StubBackend  # noqa: E402
from app.config import load_config  # noqa: E402
from app.main import app  # noqa: E402
from app.models import ChatMessage, CompleteRequest  # noqa: E402
from app.proxy import BudgetExceeded, Proxy  # noqa: E402
from app import routing  # noqa: E402


@pytest.fixture
def cfg():
    return load_config()


@pytest.fixture
def proxy(cfg):
    return Proxy(cfg)


def _msgs(text="hello"):
    return [ChatMessage(role="user", content=text)]


# ------------------------------------------------------------------ routing
def test_eco_and_frontier_resolve_different_models(cfg):
    eco = routing.resolve(cfg, tier="eco", model=None, org_id=None)
    frontier = routing.resolve(cfg, tier="frontier", model=None, org_id=None)
    assert eco.primary == "claude-haiku-4-5"
    assert frontier.primary == "claude-opus-4-8"
    assert eco.primary != frontier.primary


def test_org_override_wins(cfg):
    r = routing.resolve(cfg, tier="frontier", model=None, org_id="org_sovereign")
    assert r.primary == "qwen-3-coder"


def test_explicit_model_bypasses_routing(cfg):
    r = routing.resolve(cfg, tier=None, model="claude-sonnet-4-6", org_id=None)
    assert r.primary == "claude-sonnet-4-6" and r.fallback is None


# ------------------------------------------------------------------ completion + cost
def test_stub_returns_usage_and_cost(proxy):
    resp = proxy.complete(CompleteRequest(tier="eco", messages=_msgs()))
    assert resp.model == "claude-haiku-4-5"
    assert resp.usage.tokens_in > 0 and resp.usage.tokens_out > 0
    assert resp.cost_usd > 0


def test_cost_matches_price_table(cfg, proxy):
    resp = proxy.complete(CompleteRequest(tier="frontier", messages=_msgs("x" * 400)))
    price = cfg.price_for(resp.model)
    expected = round(
        resp.usage.tokens_in / 1_000_000 * price.input
        + resp.usage.tokens_out / 1_000_000 * price.output,
        8,
    )
    assert resp.cost_usd == expected


# ------------------------------------------------------------------ budget
def test_budget_exceeded_raises(proxy):
    with pytest.raises(BudgetExceeded) as ei:
        proxy.complete(CompleteRequest(tier="frontier", messages=_msgs("x" * 4000),
                                       max_tokens=4000, budget_usd=0.0000001))
    assert ei.value.code == "E_BUDGET_EXCEEDED"


def test_budget_ok_when_within_limit(proxy):
    resp = proxy.complete(CompleteRequest(tier="eco", messages=_msgs(), budget_usd=1.0))
    assert resp.cost_usd <= 1.0


# ------------------------------------------------------------------ fallback
def test_fallback_on_primary_failure(cfg):
    # Point the primary model at a FailingBackend; the tier fallback (stub) must serve it.
    route = routing.resolve(cfg, tier="frontier", model=None, org_id=None)
    proxy = Proxy(cfg, default_backend=StubBackend(),
                  backends={route.primary: FailingBackend()})
    resp = proxy.complete(CompleteRequest(tier="frontier", messages=_msgs()))
    assert resp.fell_back is True
    assert resp.model == route.fallback  # served by the fallback model


def test_all_backends_failing_raises(cfg):
    route = routing.resolve(cfg, tier="frontier", model=None, org_id=None)
    proxy = Proxy(cfg, default_backend=FailingBackend())
    with pytest.raises(Exception):
        proxy.complete(CompleteRequest(tier="frontier", messages=_msgs()))


# ------------------------------------------------------------------ HTTP surface
def test_http_healthz():
    c = TestClient(app)
    body = c.get("/healthz").json()
    assert body["status"] == "ok" and "eco" in body["tiers"]


def test_http_complete_and_budget_402():
    c = TestClient(app)
    ok = c.post("/v1/complete", json={"tier": "eco", "messages": [{"role": "user", "content": "hi"}]})
    assert ok.status_code == 200 and ok.json()["model"] == "claude-haiku-4-5"

    denied = c.post("/v1/complete", json={
        "tier": "frontier", "messages": [{"role": "user", "content": "x" * 4000}],
        "max_tokens": 4000, "budget_usd": 0.0000001})
    assert denied.status_code == 402
    assert denied.json()["error"]["code"] == "E_BUDGET_EXCEEDED"


def test_http_requires_exactly_one_target():
    c = TestClient(app)
    # neither tier nor model → validation error
    r = c.post("/v1/complete", json={"messages": [{"role": "user", "content": "hi"}]})
    assert r.status_code in (400, 422)
