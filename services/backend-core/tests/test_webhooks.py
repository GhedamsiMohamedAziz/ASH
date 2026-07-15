"""Webhook ingress tests (instructions.md §15.8) — POST /webhooks/{source}.

Covers the full §15.8 envelope: HMAC signature (fail-closed), ±5 min anti-replay,
delivery-id dedup (publish exactly once + dedup-on-success on a publish failure),
fan-out storm control, untrusted provenance, and the no-match ack. No DB/Redis needed:
the router/dedup/storm singletons default to in-memory and are reset per test.
"""

import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.webhooks import (
    EventAutomation,
    StormControl,
    webhook_dedup,
    webhook_router,
    webhook_storm,
)

SECRET = "whsec_test"


@pytest.fixture(autouse=True)
def _reset():
    webhook_router.clear()
    webhook_dedup.clear()
    webhook_storm.clear()
    webhook_storm.threshold = 100
    webhook_storm.window = 60.0
    yield
    webhook_router.clear()
    webhook_dedup.clear()
    webhook_storm.clear()


@pytest.fixture
def client():
    return TestClient(app)


def _sign(body: bytes, secret: str = SECRET) -> str:
    """GitHub scheme — HMAC over the raw body only."""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


def _sign_v0(body: bytes, ts: str, secret: str = SECRET) -> str:
    """Generic v0 scheme — HMAC over 'v0:' + ts + ':' + body (timestamp-bound)."""
    base = b"v0:" + ts.encode() + b":" + body
    return "v0=" + hmac.new(secret.encode(), base, hashlib.sha256).hexdigest()


def _register_pr_automation(org="org_1", secret=SECRET):
    webhook_router.secrets[("github", org)] = secret
    webhook_router.register(EventAutomation(
        id=f"auto_pr_{org}", user_id="usr_1", org_id=org, source="github",
        event_type="pull_request.opened", prompt="Review PR {number}",
        match={"repo": "checkout"}))


def _post_github(client, body: dict, *, delivery="d1", signature=None, event="pull_request",
                 org="org_1", secret=SECRET, headers=None):
    raw = json.dumps(body).encode()
    hdrs = {
        "X-Hub-Signature-256": signature if signature is not None else _sign(raw, secret),
        "X-GitHub-Delivery": delivery,
        "X-GitHub-Event": event,
    }
    if headers is not None:
        hdrs = {**hdrs, **headers}
        hdrs = {k: v for k, v in hdrs.items() if v is not None}
    return client.post(f"/webhooks/github?org={org}", content=raw, headers=hdrs)


# --------------------------------------------------------------- happy path
def test_valid_signature_matching_automation_publishes_untrusted(client):
    _register_pr_automation()
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        r = _post_github(client, {"action": "opened", "repo": "checkout", "number": 42, "id": "e1"})
    finally:
        unsub()

    assert r.status_code == 202
    assert r.json() == {"status": "accepted", "fanned_out": 1, "suppressed": 0}
    assert seen, "no InboundMessage published to the bus"
    published = seen[-1].data
    assert published["channel"] == "webhook"
    assert published["untrusted"] is True
    assert published["org_id"] == "org_1" and published["user_id"] == "usr_1"
    assert published["text"] == "Review PR 42"
    assert published["event"] == {"source": "github", "type": "pull_request.opened"}


# --------------------------------------------------------------- fail-closed signature
def test_bad_signature_is_401_and_publishes_nothing(client):
    _register_pr_automation()
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        r = _post_github(client, {"action": "opened", "repo": "checkout", "number": 42},
                         signature="sha256=deadbeef")
    finally:
        unsub()
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"
    assert not seen, "a bad signature must publish nothing (fail-closed)"


def test_missing_signature_is_401(client):
    _register_pr_automation()
    raw = json.dumps({"action": "opened", "repo": "checkout"}).encode()
    r = client.post("/webhooks/github?org=org_1", content=raw,
                    headers={"X-GitHub-Delivery": "d1", "X-GitHub-Event": "pull_request"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_missing_org_is_401(client):
    # #4: the request must name its tenant so the secret used is that org's. No org → closed.
    _register_pr_automation()
    raw = json.dumps({"action": "opened", "repo": "checkout", "id": "e1"}).encode()
    r = client.post("/webhooks/github", content=raw, headers={
        "X-Hub-Signature-256": _sign(raw), "X-GitHub-Delivery": "d1",
        "X-GitHub-Event": "pull_request"})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_unconfigured_source_secret_fails_closed(client):
    # No secret registered for this (source, org) → denied even with a plausible signature.
    raw = json.dumps({"type": "x"}).encode()
    r = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
        "X-Signature": "v0=whatever", "X-Delivery-Id": "d1",
        "X-Timestamp": str(int(time.time()))})
    assert r.status_code == 401


def _register_sentry_automation(org="org_1", secret=SECRET):
    webhook_router.secrets[("sentry", org)] = secret
    webhook_router.register(EventAutomation(
        id=f"auto_s_{org}", user_id="usr_1", org_id=org, source="sentry",
        event_type="issue.p1", prompt="Brief me", match={}))


# --------------------------------------------------------------- anti-replay (±5 min, v0)
def test_replay_outside_window_is_rejected(client):
    # Generic v0 source binds the timestamp INTO the signature; a stale one (>5 min) is
    # rejected even though its HMAC is valid.
    _register_sentry_automation()
    raw = json.dumps({"event_type": "issue.p1"}).encode()
    stale = str(int(time.time()) - 600)  # 10 min ago
    r = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
        "X-Signature": _sign_v0(raw, stale), "X-Delivery-Id": "d1",
        "X-Event-Type": "issue.p1", "X-Timestamp": stale})
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_fresh_timestamp_is_accepted(client):
    _register_sentry_automation()
    raw = json.dumps({"event_type": "issue.p1"}).encode()
    ts = str(int(time.time()))
    r = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
        "X-Signature": _sign_v0(raw, ts), "X-Delivery-Id": "d1",
        "X-Event-Type": "issue.p1", "X-Timestamp": ts})
    assert r.status_code == 202


def test_v0_replay_with_omitted_timestamp_is_rejected(client):
    # #1: an attacker replays a captured valid (body, signature) with X-Timestamp OMITTED.
    # The v0 signature is timestamp-bound, so a missing ts fails closed — never accepted.
    _register_sentry_automation()
    raw = json.dumps({"event_type": "issue.p1"}).encode()
    ts = str(int(time.time()))
    r = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
        "X-Signature": _sign_v0(raw, ts), "X-Delivery-Id": "d1",
        "X-Event-Type": "issue.p1"})  # X-Timestamp omitted
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_github_replay_with_omitted_delivery_is_rejected(client):
    # #1: replay of a valid github (body, signature) with X-GitHub-Delivery OMITTED. Dedup is
    # never skipped — a missing delivery id fails closed instead of being reprocessed forever.
    _register_pr_automation()
    raw = json.dumps({"action": "opened", "repo": "checkout", "number": 1, "id": "e1"}).encode()
    r = client.post("/webhooks/github?org=org_1", content=raw, headers={
        "X-Hub-Signature-256": _sign(raw), "X-GitHub-Event": "pull_request"})  # no delivery
    assert r.status_code == 401
    assert r.json()["error"]["code"] == "E_AUTH_INVALID_TOKEN"


def test_v0_source_dedups_even_without_delivery_header(client):
    # #1: a v0 source with NO delivery header still dedups — on sha256 of the signed body.
    _register_sentry_automation()
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    raw = json.dumps({"event_type": "issue.p1", "n": 5}).encode()
    ts = str(int(time.time()))
    sig = _sign_v0(raw, ts)
    try:
        r1 = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
            "X-Signature": sig, "X-Event-Type": "issue.p1", "X-Timestamp": ts})
        r2 = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
            "X-Signature": sig, "X-Event-Type": "issue.p1", "X-Timestamp": ts})
    finally:
        unsub()
    assert r1.status_code == 202
    assert r2.status_code == 200 and r2.json()["status"] == "duplicate"
    assert len(seen) == 1, "an identical signed body must dedup even with no delivery header"


# --------------------------------------------------------------- dedup
def test_duplicate_delivery_id_publishes_exactly_once(client):
    _register_pr_automation()
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    body = {"action": "opened", "repo": "checkout", "number": 7, "id": "e7"}
    try:
        r1 = _post_github(client, body, delivery="dup1")
        r2 = _post_github(client, body, delivery="dup1")
    finally:
        unsub()
    assert r1.status_code == 202 and r1.json()["fanned_out"] == 1
    assert r2.status_code == 200 and r2.json()["status"] == "duplicate"
    assert len(seen) == 1, "a duplicate delivery must be published at most once"


def test_publish_failure_does_not_consume_dedup_key(client, monkeypatch):
    """dedup-on-SUCCESS (ADR-016): a mid-processing publish failure leaves the delivery-id
    unmarked, so the webhook retry re-processes it instead of silently dropping the event."""
    _register_pr_automation()
    from app import bus as busmod

    async def boom(*args, **kwargs):
        raise RuntimeError("bus down")

    monkeypatch.setattr(busmod.bus, "publish", boom)
    body = {"action": "opened", "repo": "checkout", "number": 9, "id": "e9"}
    r_fail = _post_github(client, body, delivery="retry1")
    assert r_fail.status_code == 502
    # The failed delivery was NOT marked as seen — a retry must still fan out.
    assert not webhook_dedup.seen("retry1")

    seen = []

    async def spy(msg):
        seen.append(msg)

    monkeypatch.undo()  # restore the real bus.publish
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        r_ok = _post_github(client, body, delivery="retry1")
    finally:
        unsub()
    assert r_ok.status_code == 202 and r_ok.json()["fanned_out"] == 1
    assert len(seen) == 1, "retry of an unconsumed dedup key must publish"


# --------------------------------------------------------------- storm control
def test_storm_over_threshold_stops_fanning_out_and_signals(client):
    _register_pr_automation()
    webhook_storm.threshold = 2  # tiny window for the test
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        results = []
        for i in range(4):
            body = {"action": "opened", "repo": "checkout", "number": i, "id": f"s{i}"}
            results.append(_post_github(client, body, delivery=f"storm{i}"))
    finally:
        unsub()

    statuses = [r.json()["status"] for r in results]
    assert statuses[:2] == ["accepted", "accepted"]
    assert "storm_paused" in statuses[2:], "over-threshold deliveries must be storm-paused"
    paused = [r for r in results if r.json()["status"] == "storm_paused"][0]
    assert paused.status_code == 200 and paused.json()["suppressed"] >= 1
    assert len(seen) == 2, "storm control must stop fanning out beyond the threshold"
    assert webhook_storm.tripped.get("github:org_1:auto_pr_org_1", 0) >= 1  # digest signal


def test_storm_throttles_only_flooding_org_and_keeps_it_retryable(client):
    # #2: a flood on org_a must NOT suppress org_b, and org_a's suppressed deliveries must NOT
    # be dedup-consumed (they stay retryable / route to a digest — no permanent loss).
    _register_pr_automation(org="org_a", secret="secret_a")
    _register_pr_automation(org="org_b", secret="secret_b")
    webhook_storm.threshold = 2
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        # Flood org_a past its threshold.
        flood = []
        for i in range(4):
            body = {"action": "opened", "repo": "checkout", "number": i, "id": f"a{i}"}
            flood.append(_post_github(client, body, delivery=f"a{i}", org="org_a",
                                      secret="secret_a"))
        # org_b delivers once, AFTER the flood — it must still fan out.
        body_b = {"action": "opened", "repo": "checkout", "number": 99, "id": "b1"}
        r_b = _post_github(client, body_b, delivery="b1", org="org_b", secret="secret_b")
    finally:
        unsub()

    flood_statuses = [r.json()["status"] for r in flood]
    assert flood_statuses[:2] == ["accepted", "accepted"]
    assert flood_statuses[2:] == ["storm_paused", "storm_paused"]
    # org_b is untouched by org_a's flood — its own storm key is separate.
    assert r_b.status_code == 202 and r_b.json()["status"] == "accepted"
    # Suppressed org_a deliveries were NOT dedup-consumed → retryable.
    assert not webhook_dedup.seen("a2") and not webhook_dedup.seen("a3")
    # org_b's org_b automation is the only org_b message published.
    org_b_msgs = [m for m in seen if m.data["org_id"] == "org_b"]
    assert len(org_b_msgs) == 1
    assert webhook_storm.tripped.get("github:org_a:auto_pr_org_a", 0) >= 1
    assert "github:org_b:auto_pr_org_b" not in webhook_storm.tripped


# --------------------------------------------------------------- no match
def test_no_matching_automation_acks_without_publishing(client):
    webhook_router.secrets[("github", "org_1")] = SECRET  # secret set, no automation registered
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        r = _post_github(client, {"action": "closed", "repo": "checkout", "id": "n1"})
    finally:
        unsub()
    assert r.status_code == 200
    assert r.json() == {"status": "no_match", "fanned_out": 0}
    assert not seen, "no matching automation must publish nothing"


# --------------------------------------------------------------- tenant binding (#4)
def test_signature_for_org_a_cannot_trigger_org_b(client):
    # #4: org_a and org_b each have their own secret + automation. A signature made with
    # org_a's secret, replayed against org_b, verifies against org_b's DIFFERENT secret → 401.
    _register_pr_automation(org="org_a", secret="secret_a")
    _register_pr_automation(org="org_b", secret="secret_b")
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    body = {"action": "opened", "repo": "checkout", "number": 1, "id": "x1"}
    try:
        # Sign with org_a's secret but aim at org_b → the org_b secret rejects it.
        r_cross = _post_github(client, body, delivery="d_cross", org="org_b", secret="secret_a")
        # A correctly-signed org_a request fans out ONLY org_a's automation, never org_b's.
        r_ok = _post_github(client, body, delivery="d_ok", org="org_a", secret="secret_a")
    finally:
        unsub()

    assert r_cross.status_code == 401
    assert r_ok.status_code == 202 and r_ok.json()["fanned_out"] == 1
    org_ids = {m.data["org_id"] for m in seen}
    assert org_ids == {"org_a"}, "a signature must only trigger its own org's automations"


# --------------------------------------------------------------- body-size cap (#3)
def test_oversized_body_is_413(client):
    _register_pr_automation()
    big = {"action": "opened", "repo": "checkout", "id": "big", "blob": "A" * (1024 * 1024 + 10)}
    r = _post_github(client, big, delivery="big1")
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "E_VALIDATION"


def test_oversized_content_length_is_413_before_read(client):
    # A lying/huge Content-Length is rejected before the body is buffered.
    _register_pr_automation()
    raw = json.dumps({"action": "opened", "repo": "checkout", "id": "e1"}).encode()
    r = client.post("/webhooks/github?org=org_1", content=raw, headers={
        "X-Hub-Signature-256": _sign(raw), "X-GitHub-Delivery": "d1",
        "X-GitHub-Event": "pull_request", "Content-Length": str(1024 * 1024 + 1)})
    assert r.status_code == 413
    assert r.json()["error"]["code"] == "E_VALIDATION"


# --------------------------------------------------------------- distinct dedup (#5)
def test_no_id_payloads_get_distinct_dedup_keys(client):
    # #5: two distinct no-`id` v0 payloads must NOT collide — dedup is sha256(signed body),
    # so distinct bodies yield distinct keys and both fan out.
    _register_sentry_automation()
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    ts = str(int(time.time()))
    raw1 = json.dumps({"event_type": "issue.p1", "n": 1}).encode()
    raw2 = json.dumps({"event_type": "issue.p1", "n": 2}).encode()
    try:
        r1 = client.post("/webhooks/sentry?org=org_1", content=raw1, headers={
            "X-Signature": _sign_v0(raw1, ts), "X-Event-Type": "issue.p1", "X-Timestamp": ts})
        r2 = client.post("/webhooks/sentry?org=org_1", content=raw2, headers={
            "X-Signature": _sign_v0(raw2, ts), "X-Event-Type": "issue.p1", "X-Timestamp": ts})
    finally:
        unsub()
    assert r1.status_code == 202 and r2.status_code == 202
    keys = {m.data["idempotency_key"] for m in seen}
    assert len(keys) == 2, "distinct no-id payloads must get distinct dedup keys"


# --------------------------------------------------------------- partial storm suppression (FIX 6)
def test_partial_storm_suppression_keeps_delivery_retryable(client):
    # Two automations match the same event; ONE is already at its storm threshold, the other is
    # fresh. The delivery publishes the fresh one but suppresses the throttled one — the dedup key
    # must NOT be consumed, so a redelivery can still deliver the suppressed target (never lost).
    webhook_router.secrets[("github", "org_1")] = SECRET
    for i in (1, 2):
        webhook_router.register(EventAutomation(
            id=f"auto_pr_{i}", user_id="usr_1", org_id="org_1", source="github",
            event_type="pull_request.opened", prompt=f"Review {i} PR {{number}}",
            match={"repo": "checkout"}))
    webhook_storm.threshold = 5
    # Pre-throttle ONLY auto_pr_1's bucket to the threshold so it alone gets suppressed.
    webhook_storm._buckets["github:org_1:auto_pr_1"] = (time.time(), 5)

    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    body = {"action": "opened", "repo": "checkout", "number": 3, "id": "p1"}
    try:
        r1 = _post_github(client, body, delivery="partial1")
        # SAME delivery id — since it was NOT dedup-consumed (a target was suppressed), it is
        # reprocessed rather than acked as a duplicate.
        r2 = _post_github(client, body, delivery="partial1")
    finally:
        unsub()

    assert r1.status_code == 202
    assert r1.json()["fanned_out"] == 1 and r1.json()["suppressed"] == 1
    assert not webhook_dedup.seen("partial1"), "a partially-suppressed delivery must stay retryable"
    assert r2.json()["status"] != "duplicate", "the suppressed target must not be lost to dedup"


def test_publish_failure_does_not_advance_storm_bucket(client, monkeypatch):
    # FIX 6: the storm bucket must advance only on ACCEPTED (published) events — a publish
    # failure + retry must not double-count toward the threshold.
    _register_pr_automation()
    webhook_storm.threshold = 1
    from app import bus as busmod

    async def boom(*args, **kwargs):
        raise RuntimeError("bus down")

    monkeypatch.setattr(busmod.bus, "publish", boom)
    body = {"action": "opened", "repo": "checkout", "number": 1, "id": "e1"}
    r_fail = _post_github(client, body, delivery="pf1")
    assert r_fail.status_code == 502
    # The failed publish left the bucket at zero (would be 1 if it counted before publishing).
    assert webhook_storm._buckets.get("github:org_1:auto_pr_org_1", (0.0, 0))[1] == 0

    seen = []

    async def spy(msg):
        seen.append(msg)

    monkeypatch.undo()  # restore the real bus.publish
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    try:
        # threshold=1: this is the FIRST accepted event and must publish — it would be wrongly
        # storm-paused if the earlier failure had advanced the bucket.
        r_ok = _post_github(client, body, delivery="pf2")
    finally:
        unsub()
    assert r_ok.status_code == 202 and r_ok.json()["fanned_out"] == 1
    assert len(seen) == 1


# --------------------------------------------------------------- distinct-time dedup (FIX 7)
def test_identical_v0_payloads_at_distinct_times_are_not_dropped(client):
    # FIX 7: two legitimately-distinct v0 deliveries with an IDENTICAL body but different SIGNED
    # timestamps must NOT collide on sha256(body) alone — folding the signed ts in keeps both.
    _register_sentry_automation()
    seen = []

    async def spy(msg):
        seen.append(msg)

    from app import bus as busmod
    unsub = busmod.bus.subscribe("inbound.messages", spy)
    raw = json.dumps({"event_type": "issue.p1"}).encode()
    now = int(time.time())
    ts1, ts2 = str(now), str(now - 1)  # both within ±5 min, distinct signed timestamps
    try:
        r1 = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
            "X-Signature": _sign_v0(raw, ts1), "X-Event-Type": "issue.p1", "X-Timestamp": ts1})
        r2 = client.post("/webhooks/sentry?org=org_1", content=raw, headers={
            "X-Signature": _sign_v0(raw, ts2), "X-Event-Type": "issue.p1", "X-Timestamp": ts2})
    finally:
        unsub()
    assert r1.status_code == 202 and r2.status_code == 202
    assert len(seen) == 2, "identical payloads at distinct signed times must not collide on dedup"


# --------------------------------------------------------------- dedup store seam
def test_dedup_store_from_env_selects_redis_when_configured():
    from app.webhooks import dedup_store_from_env, InMemoryDedup, RedisDedup
    assert isinstance(dedup_store_from_env({}), InMemoryDedup)
    assert isinstance(dedup_store_from_env({"REDIS_URL": "redis://x:6379"}), RedisDedup)
