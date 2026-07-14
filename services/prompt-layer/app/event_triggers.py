"""Event-driven automations (instructions.md §15.8).

The time-driven cron subsystem's complement: "when a PR is opened, review it",
"when a P1 ticket arrives, brief me". An inbound webhook (GitHub/Sentry/Slack) is
verified (HMAC signature), matched against the org's event-automations, and each
match is re-injected as a scheduler-channel InboundMessage — the SAME security
path as crons (no new path, §15.8). Fail-closed: a bad signature is dropped.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass, field


def verify_signature(secret: str, body: str, signature: str) -> bool:
    """HMAC-SHA256 signature check (GitHub/Slack-style `sha256=<hex>`)."""
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

        out: list[dict] = []
        for a in self.automations:
            if not self._matches(a, source, event_type, payload):
                continue
            # Same scheduler-channel InboundMessage a cron produces (§15.8).
            out.append({
                "message_id": f"evt_{a.id}_{event_type}",
                "user_id": a.user_id, "org_id": a.org_id,
                "conversation_id": f"event:{a.id}", "channel": "scheduler",
                "text": _interpolate(a.prompt, payload),
                "idempotency_key": f"{a.id}:{payload.get('id', event_type)}",
                "event": {"source": source, "type": event_type},
            })
        return out


def _interpolate(prompt: str, payload: dict) -> str:
    """Substitute {field} placeholders from the event payload."""
    return re.sub(r"\{(\w+)\}", lambda m: str(payload.get(m.group(1), m.group(0))), prompt)


class EventSignatureError(Exception):
    code = "E_AUTH_INVALID_TOKEN"
