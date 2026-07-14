"""Proxy orchestration: route -> budget-admit -> call backend (with fallback) -> cost + log.

The one choke point every LLM call flows through (instructions.md §9.5, §12): resolves the
model, enforces the per-call budget (E_BUDGET_EXCEEDED), fails over to the tier's secondary
model on a backend error, computes cost from the price table and logs usage structurally.
"""

from __future__ import annotations

import json
import logging

from .backends import Backend, BackendError, StubBackend, _prompt_text
from .config import Config
from .models import CompleteRequest, CompleteResponse, Usage
from .pricing import compute_cost, estimate_cost, token_estimate
from . import routing

logger = logging.getLogger("llm_proxy.usage")

# Shared error taxonomy (packages/errors, §21). Hardcoded to avoid a cross-package import.
E_BUDGET_EXCEEDED = "E_BUDGET_EXCEEDED"


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
                 backends: dict[str, Backend] | None = None) -> None:
        self.cfg = cfg
        self.default_backend = default_backend or StubBackend()
        self.backends = backends or {}

    def _backend(self, model: str) -> Backend:
        return self.backends.get(model, self.default_backend)

    def complete(self, req: CompleteRequest) -> CompleteResponse:
        route = routing.resolve(self.cfg, tier=req.tier, model=req.model, org_id=req.org_id)

        # Budget admission control on the worst-case estimate before spending anything (§9.5).
        # Use the SAME serialization the backends use for their token count, so the budget
        # estimate can't silently diverge from actual spend if the format ever changes.
        prompt_tokens = token_estimate(_prompt_text(req.messages))
        if req.budget_usd is not None:
            est = estimate_cost(self.cfg, route.primary, prompt_tokens, req.max_tokens)
            if est > req.budget_usd:
                self._log(req, route.primary, prompt_tokens, 0, est, rejected=True)
                raise BudgetExceeded(
                    f"estimated cost ${est:.6f} exceeds budget ${req.budget_usd:.6f}",
                    model=route.primary, cost_usd=est, budget_usd=req.budget_usd,
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
                    model=model, messages=req.messages, max_tokens=req.max_tokens
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

        fell_back = used_model != route.primary
        self._log(req, used_model, result.tokens_in, result.tokens_out, cost,
                  rejected=False, fell_back=fell_back)
        return CompleteResponse(
            text=result.text,
            usage=Usage(tokens_in=result.tokens_in, tokens_out=result.tokens_out),
            cost_usd=cost,
            model=used_model,
            fell_back=fell_back,
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
