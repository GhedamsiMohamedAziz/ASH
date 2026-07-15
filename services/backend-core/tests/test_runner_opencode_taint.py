"""The OpenCode runner path mints a per-turn TASK JWT and hands THAT to OpenCode (RESIDUAL FIX).

Defect: `_run_turn` routes a turn to `_opencode_turn` FIRST when OPENCODE_SERVER_URL is set, and
that path dropped channel/untrusted/user_id and never called /v1/plan — so build_task's §17.6.3
pre-taint never ran and OpenCode presented the STATIC env TASK_JWT (fixed origin/task_id, never
tainted). A webhook-injected turn then ran untainted and the gateway's egress gate never fired
(webhook -> public-egress exfiltration).

These tests drive `_on_inbound` with a webhook-shaped bus message and assert the OpenCode path
now (a) calls /v1/plan carrying channel=webhook + untrusted=True + the real user/org, and
(b) writes the pipeline-minted per-turn JWT (not the static env one) to the tmpfs the gateway
reads. A second test proves the offline fallback: with no PROMPT_LAYER_URL, no /v1/plan call is
made and the static env JWT path (jwt=None -> OPENCODE_TASK_JWT) is used.
"""

from __future__ import annotations

import asyncio
from types import SimpleNamespace

import app.runner as runner


class _FakeResp:
    def __init__(self, data): self._data = data
    def raise_for_status(self): pass
    def json(self): return self._data


class _FakePlanClient:
    """Answers /v1/plan with a per-turn task_jwt; short-circuits the rest of the drive.

    Records every POST. Once /v1/plan has been answered (and its JWT written by the code under
    test), the session-create POST raises to terminate the turn — the assertions target only the
    plan call + JWT write, both of which happen before any OpenCode HTTP call.
    """
    calls: list = []

    def __init__(self, *a, **k): pass
    async def __aenter__(self): return self
    async def __aexit__(self, *a): return False

    async def post(self, url, json=None):
        _FakePlanClient.calls.append((url, json))
        if url.endswith("/v1/plan"):
            return _FakeResp({"class": "task_agentique", "task_jwt": "PER_TURN_JWT",
                              "allowed_tools": [], "approval_tools": [], "task_id": "tk_hot"})
        raise RuntimeError("stop after jwt mint")  # short-circuit /session (drive not under test)


def test_opencode_path_mints_and_writes_per_turn_jwt(monkeypatch):
    import httpx
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", "http://oc.test")
    monkeypatch.setattr(runner, "PROMPT_LAYER_URL", "http://pl.test")
    monkeypatch.setattr(runner, "OPENCODE_TASK_JWT", "STATIC_ENV_JWT")
    monkeypatch.setattr(httpx, "AsyncClient", _FakePlanClient)
    _FakePlanClient.calls = []

    written: dict = {}
    monkeypatch.setattr(runner, "_write_task_jwt", lambda jwt=None: written.__setitem__("jwt", jwt))

    # A webhook-injected bus message (webhooks.py fan_out shape): untrusted, webhook channel.
    msg = SimpleNamespace(data={
        "conversation_id": "event:auto1", "task_id": "task_evt_auto1_d1",
        "text": "injected PR title", "org_id": "org_9",
        "channel": "webhook", "untrusted": True, "user_id": "usr_hook",
    })
    asyncio.run(runner._on_inbound(msg))

    # (a) /v1/plan was called with the REAL webhook origin (was dropped before the fix).
    plan_calls = [c for c in _FakePlanClient.calls if c[0].endswith("/v1/plan")]
    assert plan_calls, "OpenCode path did not call /v1/plan (pre-taint never runs)"
    inbound = plan_calls[0][1]["inbound"]
    assert inbound["channel"] == "webhook", "webhook channel dropped on the OpenCode path"
    assert inbound["untrusted"] is True, "untrusted taint dropped on the OpenCode path"
    assert inbound["user_id"] == "usr_hook"
    assert inbound["org_id"] == "org_9"

    # (b) the pipeline-minted per-turn JWT reached the tmpfs — NOT the static env JWT.
    assert written.get("jwt") == "PER_TURN_JWT", (
        "OpenCode was handed the static env JWT (untainted); the per-turn JWT never reached tmpfs")


def test_opencode_path_falls_back_to_static_jwt_offline(monkeypatch):
    """No PROMPT_LAYER_URL (dev/CI/offline): no /v1/plan call, static env JWT path (jwt=None)."""
    import httpx
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", "http://oc.test")
    monkeypatch.setattr(runner, "PROMPT_LAYER_URL", None)
    monkeypatch.setattr(httpx, "AsyncClient", _FakePlanClient)
    _FakePlanClient.calls = []

    written: dict = {"sentinel": True}
    monkeypatch.setattr(runner, "_write_task_jwt", lambda jwt=None: written.__setitem__("jwt", jwt))

    msg = SimpleNamespace(data={
        "conversation_id": "conv_off", "task_id": "task_off", "text": "hello",
        "org_id": "org_1", "channel": "web", "user_id": "usr_42",
    })
    asyncio.run(runner._on_inbound(msg))

    assert not [c for c in _FakePlanClient.calls if c[0].endswith("/v1/plan")], \
        "offline path must not call /v1/plan"
    # jwt=None signals _write_task_jwt to use the static env fallback (legacy behavior).
    assert written.get("jwt") is None
