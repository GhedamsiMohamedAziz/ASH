"""Proxy orchestration: route -> budget-admit -> call backend (with fallback) -> cost + log.

The one choke point every LLM call flows through (instructions.md §9.5, §12): resolves the
model, enforces the per-call budget (E_BUDGET_EXCEEDED), fails over to the tier's secondary
model on a backend error, computes cost from the price table and logs usage structurally.
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Callable

from .backends import Backend, BackendError, StubBackend, _prompt_text
from .config import Config
from .models import CompleteRequest, CompleteResponse, Usage
from .pricing import compute_cost, estimate_cost, token_estimate
from . import routing

logger = logging.getLogger("llm_proxy.usage")

# Shared error taxonomy (packages/errors, §21). Hardcoded to avoid a cross-package import.
E_BUDGET_EXCEEDED = "E_BUDGET_EXCEEDED"

# Deterministic monthly bucket. Callers that want real calendar months inject a clock
# (Proxy(clock=...)) returning a month key; tests rely on this fixed key so spend accumulates
# without depending on datetime.now (mirrors prompt-layer's Ledger month keying, §25/§16.1).
LEDGER_MONTH = "current"


def _default_org_cap() -> float | None:
    """Optional process-wide org monthly cap from LLM_PROXY_ORG_CAP_USD (unset => no cap)."""
    raw = os.environ.get("LLM_PROXY_ORG_CAP_USD")
    if raw is None or raw.strip() == "":
        return None
    return float(raw)


@dataclass
class Ledger:
    """Per-(org, month) cumulative spend. In-memory here; usage_daily in prod (§16.1).

    A minimal copy of prompt-layer's Ledger (services/prompt-layer/app/budget.py) so the
    proxy stays self-contained and offline — no cross-package import.
    """

    _org: dict[tuple[str, str], float] = field(default_factory=dict)

    def org_spent(self, org_id: str, month: str) -> float:
        return self._org.get((org_id, month), 0.0)

    def record(self, org_id: str, month: str, cost: float) -> None:
        self._org[(org_id, month)] = self.org_spent(org_id, month) + cost


class BudgetExceeded(Exception):
    """Estimated or actual cost exceeds the per-call budget (E_BUDGET_EXCEEDED, HTTP 402)."""

    code = E_BUDGET_EXCEEDED

    def __init__(self, message: str, *, model: str, cost_usd: float, budget_usd: float) -> None:
        super().__init__(message)
        self.model = model
        self.cost_usd = cost_usd
        self.budget_usd = budget_usd


class Proxy:
    """Routes and executes completions across pluggable backends.

    `default_backend` serves every model unless a model is registered in `backends` (used in
    tests to point a specific model at a FailingBackend and prove fallback).
    """

    def __init__(self, cfg: Config, *, default_backend: Backend | None = None,
                 backends: dict[str, Backend] | None = None,
                 clock: Callable[[], str] | None = None) -> None:
        self.cfg = cfg
        self.default_backend = default_backend or StubBackend()
        self.backends = backends or {}
        # Process-wide per-org monthly ledger + optional per-org monthly cap. Default cap
        # comes from LLM_PROXY_ORG_CAP_USD (None => unlimited so live turns never block);
        # per-org caps set via set_org_cap win over it.
        self._ledger = Ledger()
        self._default_org_cap = _default_org_cap()
        self._org_caps: dict[str, float] = {}
        self._clock = clock

    def _backend(self, model: str) -> Backend:
        return self.backends.get(model, self.default_backend)

    def _month(self) -> str:
        return self._clock() if self._clock is not None else LEDGER_MONTH

    def set_org_cap(self, org_id: str, usd: float | None) -> None:
        """Set (or clear, with None) an org's monthly USD cap. Test/admin hook."""
        if usd is None:
            self._org_caps.pop(org_id, None)
        else:
            self._org_caps[org_id] = usd

    def _org_cap_for(self, org_id: str) -> float | None:
        return self._org_caps.get(org_id, self._default_org_cap)

    def org_spent(self, org_id: str) -> float:
        """Cumulative recorded spend for an org this month (observability/tests)."""
        return self._ledger.org_spent(org_id, self._month())

    def complete(self, req: CompleteRequest) -> CompleteResponse:
        route = routing.resolve(self.cfg, tier=req.tier, model=req.model, org_id=req.org_id)

        # Budget admission control on the worst-case estimate before spending anything (§9.5).
        # Use the SAME serialization the backends use for their token count, so the budget
        # estimate can't silently diverge from actual spend if the format ever changes.
        prompt_tokens = token_estimate(_prompt_text(req.messages))
        est = estimate_cost(self.cfg, route.primary, prompt_tokens, req.max_tokens)
        if req.budget_usd is not None:
            if est > req.budget_usd:
                self._log(req, route.primary, prompt_tokens, 0, est, rejected=True)
                raise BudgetExceeded(
                    f"estimated cost ${est:.6f} exceeds budget ${req.budget_usd:.6f}",
                    model=route.primary, cost_usd=est, budget_usd=req.budget_usd,
                )

        # Per-org monthly cap (§25): reject BEFORE spending if cumulative spend + this call's
        # estimate would cross the org's ceiling. No cap set => unlimited (live path unaffected).
        cap = self._org_cap_for(req.org_id) if req.org_id is not None else None
        if cap is not None:
            would = self._ledger.org_spent(req.org_id, self._month()) + est
            if would > cap:
                self._log(req, route.primary, prompt_tokens, 0, est, rejected=True)
                raise BudgetExceeded(
                    f"org monthly spend ${would:.6f} would exceed cap ${cap:.6f}",
                    model=route.primary, cost_usd=would, budget_usd=cap,
                )

        # Try primary, then the tier fallback on any backend error (§9.5 auto-fallback).
        candidates = [route.primary] + ([route.fallback] if route.fallback else [])
        last_err: BackendError | None = None
        result = None
        used_model = route.primary
        for i, model in enumerate(candidates):
            try:
                if i == 0 and req.simulate_primary_failure:
                    raise BackendError("simulated primary failure (debug flag)")
                result = self._backend(model).complete(
                    model=model, messages=req.messages, max_tokens=req.max_tokens,
                    tools=req.tools,
                )
                used_model = model
                break
            except BackendError as err:
                last_err = err
                logger.warning("backend failed for model=%s: %s", model, err)
                continue
        if result is None:
            raise last_err or BackendError("all backends failed")

        cost = compute_cost(self.cfg, used_model, result.tokens_in, result.tokens_out)

        # Re-check against the actual cost (a fallback model may be pricier than the estimate).
        if req.budget_usd is not None and cost > req.budget_usd:
            self._log(req, used_model, result.tokens_in, result.tokens_out, cost, rejected=True)
            raise BudgetExceeded(
                f"actual cost ${cost:.6f} exceeds budget ${req.budget_usd:.6f}",
                model=used_model, cost_usd=cost, budget_usd=req.budget_usd,
            )

        # Success: record actual spend to the per-org monthly ledger (billing/enforcement, §25).
        if req.org_id is not None:
            self._ledger.record(req.org_id, self._month(), cost)

        fell_back = used_model != route.primary
        self._log(req, used_model, result.tokens_in, result.tokens_out, cost,
                  rejected=False, fell_back=fell_back)
        return CompleteResponse(
            text=result.text,
            usage=Usage(tokens_in=result.tokens_in, tokens_out=result.tokens_out),
            cost_usd=cost,
            model=used_model,
            fell_back=fell_back,
            stop_reason=result.stop_reason,
            content_blocks=result.blocks,
        )

    def _log(self, req: CompleteRequest, model: str, tokens_in: int, tokens_out: int,
             cost: float, *, rejected: bool, fell_back: bool = False) -> None:
        # Structured usage line keyed by org (billing/observability, §9.5, §12).
        logger.info(json.dumps({
            "event": "llm_usage",
            "org_id": req.org_id,
            "tier": req.tier,
            "model": model,
            "tokens_in": tokens_in,
            "tokens_out": tokens_out,
            "cost_usd": cost,
            "budget_usd": req.budget_usd,
            "rejected": rejected,
            "fell_back": fell_back,
        }))
