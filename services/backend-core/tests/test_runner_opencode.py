"""End-to-end integration: the runner drives a REAL `opencode serve` with the KEYLESS
llm-proxy stub, and its events map to AgentEvents (instructions.md §10, §12).

WHAT THIS EXERCISES (when enabled):
  • starts the real `opencode serve` (opencode 1.17.x) and the real llm-proxy in stub mode;
  • OpenCode's LLM provider points at llm-proxy's OpenAI-compatible stub (no API key);
  • the stub emits a tool_call for the builtin read-only `glob` tool, so OpenCode runs a REAL
    tool round-trip and then finishes with text;
  • `app.runner._run_turn` (opencode mode) creates a session, pushes the turn, consumes
    OpenCode's SSE event stream and publishes AgentEvents on the bus;
  • we assert the real AgentEvents come back: thinking, text.delta, tool.call+tool.result
    (the round-trip), and a terminal done.

WHAT IT DOES *NOT* COVER: the MCP Gateway is NOT started here — the tool round-trip uses
OpenCode's builtin `glob` (self-contained, no Gateway/JWT). Gateway-tool round-trips are
proved separately in the Gateway's own suite. Provider/model config lives in the temp
opencode.json this test writes (mirrors sandbox/opencode.json's llm-proxy provider shape).

Guarded like the DATABASE_URL tests: skipped unless RUN_OPENCODE_IT=1 AND the `opencode`
binary is on PATH.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

import pytest

import app.runner as runner
from app.bus import agent_events_subject, bus

_REPO = Path(__file__).resolve().parents[3]
_LLM_PROXY_DIR = _REPO / "services" / "llm-proxy"

pytestmark = pytest.mark.skipif(
    not (os.getenv("RUN_OPENCODE_IT") and shutil.which("opencode")),
    reason="requires RUN_OPENCODE_IT=1 and the `opencode` binary (live end-to-end turn)",
)


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_http(url: str, timeout: float = 30.0, predicate=None) -> None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                body = r.read().decode()
                if predicate is None or predicate(body):
                    return
        except Exception as exc:  # noqa: BLE001 — polling until the server is up
            last = exc
        time.sleep(0.3)
    raise RuntimeError(f"timeout waiting for {url}: {last}")


@pytest.fixture
def stack(tmp_path):
    """Start llm-proxy (stub) + opencode serve wired to it; yield the opencode base URL."""
    procs: list[subprocess.Popen] = []

    # --- 1) llm-proxy in KEYLESS stub mode; the stub emits a `glob` tool_call per turn ---
    llm_port = _free_port()
    llm_env = {**os.environ, "LLM_PROXY_PROVIDER": "stub",
               "LLM_PROXY_STUB_TOOL": "glob", "LLM_PROXY_STUB_TOOL_ARGS": json.dumps({"pattern": "*.json"})}
    llm = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", str(llm_port)],
        cwd=str(_LLM_PROXY_DIR), env=llm_env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    procs.append(llm)
    _wait_http(f"http://127.0.0.1:{llm_port}/healthz")

    # --- 2) opencode workdir + config: LLM provider -> llm-proxy stub (OpenAI-compatible) ---
    workdir = tmp_path / "ocwork"
    workdir.mkdir()
    cfg = {
        "$schema": "https://opencode.ai/config.json",
        "permission": {"bash": "allow", "edit": "allow", "webfetch": "allow"},
        "provider": {
            "stub": {
                "npm": "@ai-sdk/openai-compatible",
                "name": "Axone llm-proxy (stub)",
                "options": {"baseURL": f"http://127.0.0.1:{llm_port}/v1", "apiKey": "sk-stub"},
                "models": {"stub-model": {"name": "Stub Model"}},
            }
        },
    }
    cfg_path = workdir / "opencode.json"
    cfg_path.write_text(json.dumps(cfg))

    oc_port = _free_port()
    oc_env = {**os.environ, "OPENCODE_CONFIG": str(cfg_path)}
    oc = subprocess.Popen(
        ["opencode", "serve", "--port", str(oc_port), "--hostname", "127.0.0.1"],
        cwd=str(workdir), env=oc_env,
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
    )
    procs.append(oc)
    base = f"http://127.0.0.1:{oc_port}"
    # ready when opencode has loaded the custom "stub" provider from our config
    _wait_http(f"{base}/config/providers",
               predicate=lambda b: "stub" in [p.get("id") for p in json.loads(b).get("providers", [])])

    try:
        yield base
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()


def test_runner_drives_real_opencode_turn(stack, monkeypatch):
    base = stack
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", base)
    monkeypatch.setattr(runner, "OPENCODE_PROVIDER_ID", "stub")
    monkeypatch.setattr(runner, "OPENCODE_MODEL_ID", "stub-model")
    monkeypatch.setattr(runner, "OPENCODE_AGENT", "build")

    conversation_id = "conv_it_opencode"
    events: list[dict] = []

    async def _collect(msg):
        events.append(msg.data)

    unsub = bus.subscribe(agent_events_subject(conversation_id), _collect)
    try:
        asyncio.run(runner._run_turn(conversation_id, "task_it", "list the json files here"))
    finally:
        unsub()

    types = [e["type"] for e in events]
    assert types, "no AgentEvents were produced by the real turn"
    # A real turn streamed back through the runner:
    assert types[0] == "agent.thinking"
    assert "agent.text.delta" in types, types
    assert types[-1] == "agent.done", types

    # The stub-injected tool_call really round-tripped through OpenCode's `glob` tool.
    tool_calls = [e for e in events if e["type"] == "agent.tool.call"]
    tool_results = [e for e in events if e["type"] == "agent.tool.result"]
    assert any(e["data"].get("tool") == "glob" for e in tool_calls), types
    assert any(e["data"].get("tool") == "glob" for e in tool_results), types

    done = next(e for e in events if e["type"] == "agent.done")
    assert done["data"]["reply"], "terminal done carried no reply text"
    assert done["data"]["task_id"] == "task_it"
