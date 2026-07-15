"""Webhook ingress — the event-driven complement to crons (instructions.md §15.8).

A public webhook (GitHub/Sentry/Slack/…) hits backend-core's `POST /webhooks/{source}`.
This module is the self-contained security envelope + fan-out matcher the endpoint uses:

  • HMAC-SHA256 signature verify over the RAW body, fail-closed (a bad/missing signature
    is dropped, never processed);
  • ±5 min anti-replay window on the source's timestamp header (a source with no timestamp
    relies on delivery-id dedup instead);
  • delivery-id dedup so an at-least-once webhook redelivery is acked but reprocessed at
    most once — in-memory by default, Redis-backed when REDIS_URL is set (the same
    in-memory-default seam as the scheduler's RunsStore / gateway taint, ADR-012);
  • fan-out storm control: beyond a per-source threshold, stop fanning out and record a
    digest/pause signal ("contrôle de tempête", §15.8);
  • matching + fan-out to InboundMessages, each stamped channel="webhook" + untrusted=True
    (a PR title is an injection surface — the turn must be tainted, §17.6.3).

Self-contained by design: this MIRRORS prompt-layer's `event_triggers.py`, which backend-core
cannot import (the monorepo keeps services import-isolated — only olma_shared/olma_errors are
shared). The emitted InboundMessage shape is the contract both sides produce identically.
"""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import time
from dataclasses import dataclass, field
from typing import Protocol


# Reject an oversized body BEFORE doing auth work (§15.8 #3, OOM DoS). 1 MiB is generous for
# a webhook JSON payload; the endpoint checks both Content-Length and the actual read length.
MAX_WEBHOOK_BODY = 1024 * 1024  # 1 MiB


# --------------------------------------------------------------- signature (§15.8 #1)
# Two real-world schemes, dispatched per source (see the table on `_SOURCE_HEADERS`):
#
#   • v0 (Slack v0 style, the generic/_default scheme) — the timestamp is bound INTO the
#     signed base so a captured (body, signature) replayed with X-Timestamp stripped/changed
#     cannot verify. `base = b"v0:" + ts + b":" + body`, `expected = "v0=" + hmac(...)`. A
#     non-empty ts is REQUIRED; an empty ts fails closed (never accepted).
#   • github — GitHub's ACTUAL spec signs the RAW body only (X-Hub-Signature-256,
#     `sha256=<hex>`) and sends no timestamp. Body-only HMAC is safe here ONLY because
#     GitHub always stamps a unique X-GitHub-Delivery id, so replay defence is the REQUIRED,
#     non-empty delivery-id dedup (enforced at the ingress).
def verify_signature(secret: str, ts: str | None, body: bytes, signature: str) -> bool:
    """v0 signed-timestamp HMAC-SHA256 (Slack v0 style). Fail-closed: an empty ts or an
    empty/missing signature never matches, so a replay with the timestamp header omitted is
    rejected. The HMAC is over the exact bytes the sender signed (raw body), timestamp-bound."""
    if not ts:
        return False
    base = b"v0:" + ts.encode() + b":" + body
    expected = "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


def verify_github_signature(secret: str, body: bytes, signature: str) -> bool:
    """GitHub's real scheme: HMAC-SHA256 over the RAW body → `sha256=<hex>`. Fail-closed:
    an empty/missing signature never matches. Body-only (GitHub sends no timestamp); replay
    defence is the REQUIRED, unique X-GitHub-Delivery dedup enforced at the ingress."""
    expected = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


def verify_for_source(source: str, secret: str, ts: str | None, body: bytes,
                      signature: str) -> bool:
    """Dispatch to the source's signing scheme (see `_SOURCE_HEADERS[...]['scheme']`)."""
    if header_names(source).get("scheme") == "github":
        return verify_github_signature(secret, body, signature)
    return verify_signature(secret, ts, body, signature)


# --------------------------------------------------------------- per-source headers (§15.8)
# Per-source signing scheme + header/dedup map. `scheme` selects signature verification and
# `timestamp` documents anti-replay: a source with a signed timestamp (v0) enforces the ±5 min
# window; a source with `timestamp: None` (github) has no timestamp and defers replay defence
# to its REQUIRED, unique delivery id.
#
#   source     | signature header       | scheme | timestamp   | dedup value
#   -----------+------------------------+--------+-------------+-------------------------------
#   github     | X-Hub-Signature-256    | github | (none)      | X-GitHub-Delivery (required)
#   _default   | X-Signature            | v0     | X-Timestamp | sha256(signed body) — id header
#   (sentry/…) |                        |        | (required)  |   is unsigned, so NOT trusted
_SOURCE_HEADERS: dict[str, dict[str, str | None]] = {
    "github": {"signature": "x-hub-signature-256", "delivery": "x-github-delivery",
               "timestamp": None, "event": "x-github-event", "scheme": "github"},
    "_default": {"signature": "x-signature", "delivery": "x-delivery-id",
                 "timestamp": "x-timestamp", "event": "x-event-type", "scheme": "v0"},
}


def header_names(source: str) -> dict[str, str | None]:
    return _SOURCE_HEADERS.get(source, _SOURCE_HEADERS["_default"])


def resolve_delivery_id(source: str, delivery_header: str, body: bytes) -> str | None:
    """The dedup/idempotency delivery value, per source (§15.8 #1). Never skipped:

      • github → the REQUIRED X-GitHub-Delivery (always unique). Empty → None (caller rejects).
      • other  → sha256 of the raw SIGNED body. The unsigned X-Delivery-Id header is NOT
                 trusted for dedup (an attacker could vary it to bypass dedup while replaying
                 the exact signed (ts, body)); the signed-body hash cannot be forged and is
                 distinct per event (so a no-id payload still dedups, §15.8 #5)."""
    if header_names(source).get("scheme") == "github":
        return delivery_header or None
    return "sha256:" + hashlib.sha256(body).hexdigest()


def event_type_of(source: str, headers, payload: dict) -> str:
    """Derive the event type. GitHub: `<X-GitHub-Event>.<payload.action>` (e.g.
    pull_request.opened); generic: the X-Event-Type header, else payload type/event_type."""
    names = header_names(source)
    evt = headers.get(names["event"]) if names.get("event") else None
    if source == "github":
        base = evt or ""
        action = payload.get("action")
        return f"{base}.{action}" if base and action else base
    return evt or payload.get("event_type") or payload.get("type") or ""


# --------------------------------------------------------------- anti-replay (§15.8)
REPLAY_WINDOW_SECONDS = 300  # ±5 min


def within_replay_window(timestamp, now: float, window: int = REPLAY_WINDOW_SECONDS) -> bool:
    """True only if the event timestamp is present AND within ±window of now (§15.8 #1).
    Fail-closed: a missing (None/"") or malformed timestamp is REJECTED — a v0 signature only
    proves the sender signed the (ts, body); the window is what rejects an old-but-valid
    signature replayed within a still-valid HMAC. The endpoint calls this only for sources
    that carry a signed timestamp (github has none and defers to delivery-id dedup)."""
    if timestamp is None or timestamp == "":
        return False
    try:
        ts = float(timestamp)
    except (TypeError, ValueError):
        return False
    return abs(now - ts) <= window


# --------------------------------------------------------------- dedup (delivery-id, §15.8)
class DedupStore(Protocol):
    """Delivery-id dedup ledger. Default in-memory (dev/test); Redis-backed in prod (REDIS_URL)
    so dedup survives a restart and is shared across replicas — the same seam as the scheduler's
    RunsStore (scheduler.py) and the gateway taint store (ADR-012)."""

    def seen(self, delivery_id: str, now: float | None = None) -> bool: ...
    def mark(self, delivery_id: str, now: float | None = None) -> None: ...


class InMemoryDedup:
    """Default DedupStore — delivery_id → expiry. Loses state on restart (fine for dev/test)."""

    def __init__(self, ttl: float = 3600.0) -> None:
        self._seen: dict[str, float] = {}
        self.ttl = ttl

    def _purge(self, now: float) -> None:
        for k in [k for k, exp in self._seen.items() if exp <= now]:
            del self._seen[k]

    def seen(self, delivery_id: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        self._purge(now)
        return delivery_id in self._seen

    def mark(self, delivery_id: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        self._seen[delivery_id] = now + self.ttl

    def clear(self) -> None:
        self._seen.clear()


class RedisDedup:
    """Redis-backed DedupStore (§16.2). Config-gated seam: the `redis` client is imported lazily
    on first use, so the offline/keyless default path (no REDIS_URL) never needs the package —
    mirrors pgstore's asyncpg import and the gateway's RedisTaint (ADR-012)."""

    def __init__(self, url: str, ttl: float = 3600.0) -> None:
        self.url = url
        self.ttl = int(ttl)
        self._client = None

    def _redis(self):
        if self._client is None:
            import redis  # lazy: only when REDIS_URL is configured
            self._client = redis.Redis.from_url(self.url)
        return self._client

    def seen(self, delivery_id: str, now: float | None = None) -> bool:
        return bool(self._redis().exists(_dedup_key(delivery_id)))

    def mark(self, delivery_id: str, now: float | None = None) -> None:
        # NX+EX: set only if absent — never refreshes an existing key's TTL.
        self._redis().set(_dedup_key(delivery_id), "1", nx=True, ex=self.ttl)


def _dedup_key(delivery_id: str) -> str:
    return f"webhook:dedup:{delivery_id}"


def dedup_store_from_env(env=None) -> DedupStore:
    env = os.environ if env is None else env
    url = env.get("REDIS_URL")
    return RedisDedup(url) if url else InMemoryDedup()


# --------------------------------------------------------------- storm control (§15.8)
class StormControl:
    """Fixed-window fan-out limiter, keyed per (source, org, automation) by the caller so a
    flood throttles ONLY the offending tenant/trigger — never other orgs (§15.8 #2). Beyond
    `threshold` deliveries within `window` seconds, allow() returns False so the ingress stops
    fanning out to THAT target and records a digest/pause signal (`tripped[key]`) instead of
    amplifying the storm — §15.8 "contrôle de tempête". The endpoint does NOT consume the
    delivery dedup key on suppression, so a suppressed delivery stays retryable (no loss)."""

    def __init__(self, threshold: int = 100, window: float = 60.0) -> None:
        self.threshold = threshold
        self.window = window
        self._buckets: dict[str, tuple[float, int]] = {}
        self.tripped: dict[str, int] = {}  # key -> count of suppressed deliveries (digest signal)

    def allow(self, key: str, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        start, count = self._buckets.get(key, (now, 0))
        if now - start >= self.window:
            start, count = now, 0
        count += 1
        self._buckets[key] = (start, count)
        if count > self.threshold:
            self.tripped[key] = self.tripped.get(key, 0) + 1
            return False
        return True

    def clear(self) -> None:
        self._buckets.clear()
        self.tripped.clear()


# --------------------------------------------------------------- router (match + fan-out)
class EventSignatureError(Exception):
    code = "E_AUTH_INVALID_TOKEN"


@dataclass
class EventAutomation:
    id: str
    user_id: str
    org_id: str
    source: str                 # github|sentry|slack|…
    event_type: str             # e.g. "pull_request.opened"
    prompt: str
    match: dict = field(default_factory=dict)  # optional field filters — all must match


@dataclass
class WebhookRouter:
    """Per-(source, org) signing secrets + the orgs' event-automations (§15.8 #4). A secret is
    bound to a SPECIFIC tenant, so a valid signature authenticates exactly one org and fan-out
    is scoped to that org — a signature for org A can never trigger org B's automation.
    Populated at wiring time (prod: Vault + the automations table); tests register directly.
    Empty by default so an unconfigured (source, org) fails closed (no secret → 401)."""

    automations: list[EventAutomation] = field(default_factory=list)
    # (source, org_id) -> signing secret. Keyed per tenant so signatures are tenant-bound.
    secrets: dict[tuple[str, str], str] = field(default_factory=dict)

    def register(self, a: EventAutomation) -> None:
        self.automations.append(a)

    def secret_for(self, source: str, org_id: str) -> str | None:
        return self.secrets.get((source, org_id))

    def clear(self) -> None:
        self.automations.clear()
        self.secrets.clear()

    def _matches(self, a: EventAutomation, source: str, event_type: str, payload: dict) -> bool:
        if a.source != source or a.event_type != event_type:
            return False
        for k, v in a.match.items():
            if str(payload.get(k)) != str(v):
                return False
        return True

    def fan_out(self, source: str, org_id: str, event_type: str, payload: dict,
                delivery: str) -> list[dict]:
        """Match + build InboundMessages (channel="webhook", untrusted=True), SCOPED to
        `org_id` (§15.8 #4) — only the verifying tenant's automations are considered. Assumes
        the signature has ALREADY been verified by the endpoint (fail-closed there). `delivery`
        is the signed delivery value (never a constant fallback, §15.8 #5); it stamps the
        idempotency/task ids. Each inbound carries a private `_storm_key` the endpoint pops to
        throttle storm control per (source, org, automation)."""
        out: list[dict] = []
        for a in self.automations:
            if a.org_id != org_id:  # tenant scoping — never fan out to a different org
                continue
            if not self._matches(a, source, event_type, payload):
                continue
            out.append({
                "schema_version": "1.2",
                "message_id": f"evt_{a.id}_{event_type}",
                "task_id": f"task_evt_{a.id}_{delivery}",
                "user_id": a.user_id, "org_id": a.org_id,
                "conversation_id": f"event:{a.id}", "channel": "webhook", "untrusted": True,
                "text": _interpolate(a.prompt, payload),
                "idempotency_key": f"{a.id}:{delivery}",
                "event": {"source": source, "type": event_type},
                "_storm_key": f"{source}:{a.org_id}:{a.id}",
            })
        return out


def _interpolate(prompt: str, payload: dict) -> str:
    """Substitute {field} placeholders from the (untrusted) event payload."""
    return re.sub(r"\{(\w+)\}", lambda m: str(payload.get(m.group(1), m.group(0))), prompt)


# --------------------------------------------------------------- process-global singletons
# Module-level like backend-core's `store`/`approvals`: the endpoint reads these; tests reset
# them. Dedup picks Redis when REDIS_URL is set, else in-memory (offline/test default).
webhook_router = WebhookRouter()
webhook_dedup: DedupStore = dedup_store_from_env()
webhook_storm = StormControl()
