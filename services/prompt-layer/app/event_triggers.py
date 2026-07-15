"""Event-driven automations (instructions.md §15.8).

The time-driven cron subsystem's complement: "when a PR is opened, review it",
"when a P1 ticket arrives, brief me". An inbound webhook (GitHub/Sentry/Slack) is
verified (HMAC signature), matched against the org's event-automations, and each
match is re-injected as an InboundMessage.

A webhook payload is UNTRUSTED input — a PR title or ticket body is an injection
surface (§15.8). So unlike a cron (whose prompt the user authored), every emitted
InboundMessage is stamped `channel="webhook"` + `untrusted=True`, so the downstream
turn's memory/egress are tainted (source_trust=untrusted, §17.6.3). Fail-closed: a
bad signature raises EventSignatureError and the event is dropped (no processing).

The §15.8 ingress hardening around this router — ±5 min anti-replay, delivery-id
dedup (in-memory default + Redis seam), and fan-out storm control — is enforced at
the HTTP ingress endpoint (backend-core `POST /webhooks/{source}`, `app/webhooks.py`)
where the raw body + per-source headers are available. This module stays the pure,
signature-verifying + matching + fan-out core.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass, field


def verify_signature(secret: str, body: str, signature: str) -> bool:
    """HMAC-SHA256 signature check over the raw body (GitHub/Slack-style `sha256=<hex>`).

    Fail-closed: an empty/missing signature never matches (compare_digest against ""). The
    HMAC is computed over the EXACT bytes the sender signed, so callers must pass the raw
    request body, not a re-serialized dict."""
    expected = "sha256=" + hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, signature or "")


@dataclass
class EventAutomation:
    id: str
    user_id: str
    org_id: str
    source: str                 # github|sentry|slack
    event_type: str             # e.g. "pull_request.opened", "issue.p1"
    prompt: str
    # optional field filters, e.g. {"repo": "checkout"} — all must match
    match: dict = field(default_factory=dict)


@dataclass
class EventRouter:
    automations: list[EventAutomation] = field(default_factory=list)
    # per-source signing secret (Vault in prod)
    secrets: dict[str, str] = field(default_factory=dict)

    def register(self, a: EventAutomation) -> None:
        self.automations.append(a)

    def _matches(self, a: EventAutomation, source: str, event_type: str, payload: dict) -> bool:
        if a.source != source or a.event_type != event_type:
            return False
        for k, v in a.match.items():
            if str(payload.get(k)) != str(v):
                return False
        return True

    def process(self, source: str, event_type: str, body: str, signature: str,
                payload: dict) -> list[dict]:
        """Verify + fan out to matching automations. Returns InboundMessages (§15.8)."""
        secret = self.secrets.get(source)
        if secret is None or not verify_signature(secret, body, signature):
            raise EventSignatureError(f"bad signature for {source}")

        delivery = _delivery_id(body, payload)
        out: list[dict] = []
        for a in self.automations:
            if not self._matches(a, source, event_type, payload):
                continue
            # An InboundMessage carrying UNTRUSTED provenance (§15.8): channel="webhook" +
            # untrusted=True so the downstream turn is tainted (source_trust=untrusted, §17.6.3)
            # — a webhook-authored prompt can never be treated as first-party input.
            out.append({
                "message_id": f"evt_{a.id}_{event_type}",
                "user_id": a.user_id, "org_id": a.org_id,
                "conversation_id": f"event:{a.id}", "channel": "webhook", "untrusted": True,
                "text": _interpolate(a.prompt, payload),
                "idempotency_key": f"{a.id}:{delivery}",
                "event": {"source": source, "type": event_type},
            })
        return out


def _delivery_id(body: str, payload: dict) -> str:
    """The dedup/idempotency delivery value (§15.8 #5). The payload's own (signed) id when
    present, else sha256 of the raw SIGNED body — NEVER a constant fallback like the event
    type, which would collapse distinct no-id events into one colliding dedup key. The body is
    HMAC-verified above, so its hash is a forge-proof, per-event identifier."""
    pid = payload.get("id")
    if pid not in (None, ""):
        return str(pid)
    return "sha256:" + hashlib.sha256(body.encode()).hexdigest()


def _interpolate(prompt: str, payload: dict) -> str:
    """Substitute {field} placeholders from the event payload."""
    return re.sub(r"\{(\w+)\}", lambda m: str(payload.get(m.group(1), m.group(0))), prompt)


class EventSignatureError(Exception):
    code = "E_AUTH_INVALID_TOKEN"
