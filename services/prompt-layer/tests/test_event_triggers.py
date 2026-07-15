"""Event-automation router tests (instructions.md §15.8) — event_triggers.py.

The router verifies the HMAC signature (fail-closed), matches automations, and fans out
InboundMessages stamped with UNTRUSTED webhook provenance so the downstream turn is tainted
(§17.6.3). The ingress hardening (anti-replay/dedup/storm) lives at the HTTP endpoint
(backend-core) and is tested there.
"""

import hashlib
import hmac

import pytest

from app.event_triggers import (
    EventAutomation,
    EventRouter,
    EventSignatureError,
    verify_signature,
)

SECRET = "whsec_test"


def _sign(body: str, secret: str = SECRET) -> str:
    return "sha256=" + hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()


def _router() -> EventRouter:
    r = EventRouter(secrets={"github": SECRET})
    r.register(EventAutomation(
        id="auto_pr", user_id="usr_1", org_id="org_1", source="github",
        event_type="pull_request.opened", prompt="Review PR {number}", match={"repo": "checkout"}))
    return r


def test_verify_signature_fail_closed_on_missing_or_bad():
    body = '{"a":1}'
    assert verify_signature(SECRET, body, _sign(body)) is True
    assert verify_signature(SECRET, body, "") is False
    assert verify_signature(SECRET, body, "sha256=deadbeef") is False


def test_process_marks_untrusted_webhook_provenance():
    r = _router()
    body = '{"action":"opened","repo":"checkout","number":42,"id":"e1"}'
    payload = {"action": "opened", "repo": "checkout", "number": 42, "id": "e1"}
    out = r.process("github", "pull_request.opened", body, _sign(body), payload)
    assert len(out) == 1
    msg = out[0]
    assert msg["channel"] == "webhook"
    assert msg["untrusted"] is True
    assert msg["text"] == "Review PR 42"
    assert msg["org_id"] == "org_1"
    assert msg["event"] == {"source": "github", "type": "pull_request.opened"}


def test_process_raises_on_bad_signature():
    r = _router()
    body = '{"action":"opened","repo":"checkout"}'
    with pytest.raises(EventSignatureError):
        r.process("github", "pull_request.opened", body, "sha256=bad", {"repo": "checkout"})


def test_process_raises_when_no_secret_for_source():
    r = _router()
    body = '{"x":1}'
    with pytest.raises(EventSignatureError):
        r.process("sentry", "issue.p1", body, _sign(body), {})


def test_field_filter_must_match():
    r = _router()
    body = '{"action":"opened","repo":"billing","number":1}'
    payload = {"action": "opened", "repo": "billing", "number": 1}
    out = r.process("github", "pull_request.opened", body, _sign(body), payload)
    assert out == []  # repo != "checkout" → no fan-out


def test_idempotency_key_uses_signed_id_when_present():
    r = _router()
    body = '{"action":"opened","repo":"checkout","number":42,"id":"e1"}'
    payload = {"action": "opened", "repo": "checkout", "number": 42, "id": "e1"}
    out = r.process("github", "pull_request.opened", body, _sign(body), payload)
    assert out[0]["idempotency_key"] == "auto_pr:e1"


def test_no_id_payloads_get_distinct_dedup_keys():
    # #5: without an `id`, the dedup key must derive from a hash of the signed body — never a
    # constant fallback that collapses distinct events into one colliding key.
    r = _router()
    body1 = '{"action":"opened","repo":"checkout","number":1}'
    body2 = '{"action":"opened","repo":"checkout","number":2}'
    out1 = r.process("github", "pull_request.opened", body1, _sign(body1),
                     {"action": "opened", "repo": "checkout", "number": 1})
    out2 = r.process("github", "pull_request.opened", body2, _sign(body2),
                     {"action": "opened", "repo": "checkout", "number": 2})
    k1, k2 = out1[0]["idempotency_key"], out2[0]["idempotency_key"]
    assert k1 != k2
    assert k1.startswith("auto_pr:sha256:") and k2.startswith("auto_pr:sha256:")
