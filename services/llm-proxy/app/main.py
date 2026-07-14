"""llm-proxy — FastAPI app (instructions.md §9.5, §12, §26).

The single choke point for LLM calls: `POST /v1/complete` routes a tier/model, enforces the
per-call budget, tracks cost from the price table and fails over on backend errors. Ships
with StubBackend so it boots and serves offline; production swaps the backend via config
(§G.4) with no change to this surface.
"""

from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI
from fastapi.responses import JSONResponse

from .backends import build_backend
from .config import load_config
from .models import CompleteRequest, CompleteResponse, ErrorBody, ErrorEnvelope
from .proxy import BudgetExceeded, Proxy

logging.basicConfig(level=logging.INFO)

app = FastAPI(title="olma llm-proxy", version="0.1.0")

cfg = load_config()
# `provider: stub` (default) stays offline; `provider: anthropic` spends real money via
# ANTHROPIC_API_KEY. One config edit flips the money-spending edge — no code change (§G.4).
proxy = Proxy(cfg, default_backend=build_backend(cfg.provider))


def _error(status: int, code: str, message: str) -> JSONResponse:
    body = ErrorEnvelope(error=ErrorBody(code=code, message=message, trace_id=uuid.uuid4().hex))
    return JSONResponse(status_code=status, content=body.model_dump())


@app.get("/healthz")
def healthz() -> dict:
    return {"status": "ok", "provider": cfg.provider, "tiers": sorted(cfg.tiers)}


@app.post("/v1/complete", response_model=CompleteResponse)
def complete(req: CompleteRequest):
    try:
        return proxy.complete(req)
    except BudgetExceeded as exc:
        return _error(402, exc.code, str(exc))
    except (KeyError, ValueError) as exc:
        return _error(400, "E_VALIDATION", str(exc))
