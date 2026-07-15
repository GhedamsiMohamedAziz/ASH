"""Tests for per-org monthly quota-by-consumption in the llm-proxy.

Proves the meter->enforce loop at the Proxy.complete choke point:
  • NO cap  -> N calls all succeed (live path is never blocked);
  • low cap -> calls accumulate on the org ledger and the call that would cross the cap is
    rejected with 402 E_BUDGET_EXCEEDED, while the ledger reflects only the admitted spend.
"""

import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.backends import _prompt_text  # noqa: E402
from app.config import load_config  # noqa: E402
from app.models import ChatMessage, CompleteRequest  # noqa: E402
from app.pricing import estimate_cost, token_estimate  # noqa: E402
from app.proxy import BudgetExceeded, Proxy  # noqa: E402
from app import routing  # noqa: E402


@pytest.fixture
def cfg():
    return load_config()


@pytest.fixture
def proxy(cfg):
    return Proxy(cfg)


def _req(org_id, text="hello", **kw):
    return CompleteRequest(tier="eco", messages=[ChatMessage(role="user", content=text)],
                           org_id=org_id, **kw)


def _estimate(cfg, req):
    """The worst-case pre-call estimate the proxy admits against (§9.5)."""
    route = routing.resolve(cfg, tier=req.tier, model=req.model, org_id=req.org_id)
    return estimate_cost(cfg, route.primary, token_estimate(_prompt_text(req.messages)),
                         req.max_tokens)


# ------------------------------------------------------------------ no cap => unlimited
def test_no_cap_never_blocks(proxy):
    # Default: no org cap configured. Many calls all succeed and spend accumulates untouched.
    for _ in range(25):
        resp = proxy.complete(_req("org_free"))
        assert resp.cost_usd > 0
    assert proxy.org_spent("org_free") > 0
    assert proxy._org_cap_for("org_free") is None  # no cap in force


def test_other_orgs_cap_does_not_leak(proxy):
    # A cap on one org must not affect a different org (per-org keying).
    proxy.set_org_cap("org_capped", 0.0)
    for _ in range(10):
        assert proxy.complete(_req("org_other")).cost_usd > 0


# ------------------------------------------------------------------ low cap => enforced
def test_low_cap_blocks_after_crossing(cfg, proxy):
    org = "org_low"
    # Admission is on the worst-case estimate (full max_tokens of output), so size the cap
    # relative to that estimate. cap = 2.5*est admits at least 2 calls, then must reject.
    est = _estimate(cfg, _req(org))
    cap = est * 2.5
    proxy.set_org_cap(org, cap)

    admitted = 0
    per_call = None
    with pytest.raises(BudgetExceeded) as ei:
        for _ in range(100):
            resp = proxy.complete(_req(org))
            per_call = resp.cost_usd  # actual recorded cost (<= est)
            admitted += 1
    assert ei.value.code == "E_BUDGET_EXCEEDED"
    # At least two calls were admitted before the cap bit; the ledger reflects only them.
    assert admitted >= 2
    spent = proxy.org_spent(org)
    assert spent <= cap
    assert spent == pytest.approx(per_call * admitted)
    # A rejected call recorded nothing: driving once more leaves the ledger unchanged.
    with pytest.raises(BudgetExceeded):
        proxy.complete(_req(org))
    assert proxy.org_spent(org) == pytest.approx(spent)


def test_rejected_call_does_not_record_spend(proxy):
    org = "org_norec"
    proxy.set_org_cap(org, 0.0)  # cap so low every call is rejected
    with pytest.raises(BudgetExceeded):
        proxy.complete(_req(org))
    assert proxy.org_spent(org) == 0.0  # nothing recorded for a rejected call


def test_clear_cap_restores_unlimited(proxy):
    org = "org_clear"
    proxy.set_org_cap(org, 0.0)
    with pytest.raises(BudgetExceeded):
        proxy.complete(_req(org))
    proxy.set_org_cap(org, None)  # clear
    assert proxy.complete(_req(org)).cost_usd > 0


# ------------------------------------------------------------------ HTTP surface -> 402
def test_http_org_cap_returns_402():
    from app import main

    org = "org_http_cap"
    client = TestClient(main.app)
    body = {"tier": "eco", "messages": [{"role": "user", "content": "hi"}], "org_id": org}

    # No cap: first call succeeds and seeds the ledger.
    ok = client.post("/v1/complete", json=body)
    assert ok.status_code == 200
    per_call = ok.json()["cost_usd"]

    # Set a cap just below the current spend + one more call so the next call is rejected.
    main.proxy.set_org_cap(org, per_call * 1.5)
    denied = client.post("/v1/complete", json=body)
    assert denied.status_code == 402
    assert denied.json()["error"]["code"] == "E_BUDGET_EXCEEDED"

    # Cleanup so the shared process-wide proxy isn't left capped for other tests.
    main.proxy.set_org_cap(org, None)
