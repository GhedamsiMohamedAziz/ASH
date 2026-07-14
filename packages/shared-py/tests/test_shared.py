"""Tests for the shared runtime helpers (AX-007)."""

import asyncio
import time

import pytest

from olma_shared import jwt, telemetry
from olma_shared.bus import DedupeGuard, InMemoryBus
from olma_shared.idempotency import InMemoryStore


# ------------------------------------------------------------------ jwt
def test_jwt_roundtrip():
    tok = jwt.sign({"sub": "usr_1", "role": "member"}, "secret")
    claims = jwt.verify(tok, "secret")
    assert claims["sub"] == "usr_1" and claims["role"] == "member"


def test_jwt_rejects_wrong_secret():
    tok = jwt.sign({"sub": "usr_1"}, "secret")
    with pytest.raises(jwt.InvalidSignature):
        jwt.verify(tok, "other-secret")


def test_jwt_rejects_expired_and_honors_leeway():
    tok = jwt.sign({"sub": "x", "exp": 1000}, "s")
    with pytest.raises(jwt.ExpiredToken):
        jwt.verify(tok, "s", now=1001)
    assert jwt.verify(tok, "s", now=1000)  # exactly at exp is still valid
    assert jwt.verify(tok, "s", now=1005, leeway=10)  # within leeway


def test_jwt_rejects_alg_none_bypass():
    # Forge a token claiming alg=none — must be rejected, not trusted.
    import base64, json
    def b(o): return base64.urlsafe_b64encode(json.dumps(o).encode()).rstrip(b"=").decode()
    forged = f"{b({'alg':'none','typ':'JWT'})}.{b({'sub':'admin'})}."
    with pytest.raises(jwt.JWTError):
        jwt.verify(forged, "s")


def test_jwt_iss_aud_checks():
    tok = jwt.sign({"sub": "x", "iss": "olma-auth", "aud": "olma-internal"}, "s")
    assert jwt.verify(tok, "s", iss="olma-auth", aud="olma-internal")
    with pytest.raises(jwt.InvalidClaim):
        jwt.verify(tok, "s", iss="somebody-else")


# ------------------------------------------------------------------ idempotency
def test_idempotency_dedup_and_replay():
    store = InMemoryStore()
    assert store.remember("k1", {"message_id": "m1"}) is True   # new
    assert store.remember("k1", {"message_id": "m1"}) is False  # duplicate
    assert store.get("k1") == {"message_id": "m1"}
    assert store.seen("k1") is True
    assert store.seen("nope") is False


def test_idempotency_ttl_expiry():
    store = InMemoryStore()
    store.remember("k", "v", ttl=-1)  # already expired
    assert store.get("k") is None
    assert store.remember("k", "v2") is True  # can store again after expiry


# ------------------------------------------------------------------ bus
def test_bus_publish_subscribe_and_wildcard():
    bus = InMemoryBus()
    got: list[str] = []

    async def h(msg):
        got.append(msg.subject)

    bus.subscribe("agent.events.*", h)
    bus.subscribe("inbound.messages", h)

    async def run():
        await bus.publish("agent.events.conv_1", {"x": 1})
        await bus.publish("inbound.messages", {"y": 2})
        await bus.publish("other.subject", {"z": 3})  # no subscriber

    asyncio.run(run())
    assert got == ["agent.events.conv_1", "inbound.messages"]


def test_bus_unsubscribe():
    bus = InMemoryBus()
    got = []
    unsub = bus.subscribe("s", lambda m: _append(got, m))
    unsub()
    asyncio.run(bus.publish("s", {}))
    assert got == []


async def _append(lst, msg):
    lst.append(msg)


def test_dedupe_guard():
    g = DedupeGuard()
    assert g.is_duplicate("m1") is False
    assert g.is_duplicate("m1") is True
    assert g.is_duplicate("") is False  # empty id never dedups
    assert g.is_duplicate("m2") is False


# ------------------------------------------------------------------ telemetry
def test_traceparent_new_and_roundtrip():
    ctx = telemetry.new_trace()
    tp = ctx.to_traceparent()
    parsed = telemetry.parse(tp)
    assert parsed.trace_id == ctx.trace_id and parsed.span_id == ctx.span_id


def test_traceparent_child_keeps_trace_new_span():
    root = telemetry.new_trace().to_traceparent()
    c = telemetry.child(root)
    assert c.trace_id == telemetry.parse(root).trace_id
    assert c.span_id != telemetry.parse(root).span_id


def test_traceparent_invalid_starts_new_root():
    assert telemetry.parse("garbage") is None
    assert telemetry.parse("00-" + "0" * 32 + "-" + "0" * 16 + "-01") is None  # all-zero invalid
    c = telemetry.child("garbage")  # falls back to a fresh root
    assert len(c.trace_id) == 32 and len(c.span_id) == 16
