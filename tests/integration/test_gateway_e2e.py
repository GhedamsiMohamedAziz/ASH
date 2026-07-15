"""FULL security-path E2E: a real `opencode serve` turn calls a tool THROUGH the real MCP
Gateway — TASK_JWT auth + allowed_tools AuthZ + taint + audit — NOT opencode's builtin tools
(instructions.md §10, §12, §13). This closes the "Gateway-in-the-loop" gap.

WIRING (all keyless/offline, no network, no API keys):
  • the REAL MCP Gateway core (buildGateway() with its StubBackend) fronted by a thin MCP
    Streamable-HTTP adapter (tests/integration/mcp_gateway_http.ts). The adapter adds ONLY MCP
    JSON-RPC framing; every tools/call runs the real gw.call() chain (JWT verify, allowed_tools,
    taint, approval, DLP, audit). It exists because the shipped gateway speaks a bespoke REST
    surface (POST /v1/tool/call), not MCP — so opencode's MCP client cannot reach it directly;
  • the REAL llm-proxy in KEYLESS stub mode; LLM_PROXY_STUB_TOOL names the Gateway tool, so the
    stub emits exactly one tool_call for it, then finishes with text once the tool result returns;
  • a REAL `opencode serve` configured with the Gateway as a remote MCP server (Authorization:
    Bearer <TASK_JWT>) and llm-proxy as its OpenAI-compatible LLM provider;
  • `app.runner._run_turn` (OPENCODE_SERVER_URL mode) drives one turn and maps opencode's SSE
    events to AgentEvents.

PROOF the call traversed the Gateway (not a builtin): after the turn we read the Gateway's
append-only AUDIT log (adapter GET /audit) and assert a `tool.call` row for `github.search`,
status `ok`, actor = the TASK_JWT subject. We also assert the AgentEvents carry tool.call +
tool.result + a terminal done.

A dev HS256 TASK_JWT (shared secret `dev-task-jwt-secret`, iss `olma-prompt-layer`, aud
`olma-mcp-gateway`) is minted allowing `github.search` and embedded in opencode's MCP header —
opencode resolves config at server-load, so the token is in place before it connects.

Guarded like the existing RUN_OPENCODE_IT / DATABASE_URL integration tests: skipped unless
RUN_GATEWAY_IT=1 AND the `opencode` and `node` binaries are on PATH. No Docker/Redis needed —
the gateway's StubBackend and in-memory taint keep the whole chain self-contained. CI without
these deps still passes (the module is collected but every test skips).
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

_REPO = Path(__file__).resolve().parents[2]
_LLM_PROXY_DIR = _REPO / "services" / "llm-proxy"
_BACKEND_DIR = _REPO / "services" / "backend-core"
_SHARED_PY = _REPO / "packages" / "shared-py"
_ADAPTER_TS = _REPO / "tests" / "integration" / "mcp_gateway_http.ts"

# The runner lives in services/backend-core; make it importable without a conftest.
sys.path.insert(0, str(_BACKEND_DIR))
sys.path.insert(0, str(_SHARED_PY))

pytestmark = pytest.mark.skipif(
    not (os.getenv("RUN_GATEWAY_IT") and shutil.which("opencode") and shutil.which("node")),
    reason="requires RUN_GATEWAY_IT=1 and the `opencode` + `node` binaries (live Gateway-in-loop turn)",
)

# The Gateway tool this turn drives, and its opencode-facing MCP name (adapter maps name→gwTool).
_GW_TOOL = "github.search"
_MCP_TOOL = "github_search"
_JWT_SUB = "usr_dev"
_JWT_ORG = "org_1"


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
        except Exception as exc:  # noqa: BLE001 — poll until the server is up
            last = exc
        time.sleep(0.3)
    raise RuntimeError(f"timeout waiting for {url}: {last}")


def _mint_task_jwt() -> str:
    """Dev HS256 TASK_JWT allowing github.search (mirrors prompt-layer's claim shape, §13.4)."""
    from olma_shared.jwt import sign

    iat = int(time.time())
    claims = {
        "sub": _JWT_SUB, "org_id": _JWT_ORG,
        "iss": "olma-prompt-layer", "aud": "olma-mcp-gateway",
        "iat": iat, "exp": iat + 900,
        "allowed_tools": [_GW_TOOL], "approval_tools": [],
        "task_id": "task_gw_it", "origin": "interactive",
    }
    return sign(claims, "dev-task-jwt-secret")


@pytest.fixture
def stack(tmp_path):
    """Start Gateway MCP adapter + llm-proxy stub + opencode serve; yield (opencode_base, audit_url)."""
    procs: list[subprocess.Popen] = []
    logs = tmp_path / "logs"
    logs.mkdir()

    def _spawn(name: str, argv: list[str], *, cwd: Path, env: dict) -> subprocess.Popen:
        f = open(logs / f"{name}.log", "w")  # noqa: SIM115 — closed on teardown via proc lifetime
        p = subprocess.Popen(argv, cwd=str(cwd), env=env, stdout=f, stderr=subprocess.STDOUT)
        procs.append(p)
        return p

    task_jwt = _mint_task_jwt()

    # --- 1) Real MCP Gateway core behind the MCP Streamable-HTTP adapter (keyless StubBackend) ---
    adapter_port = _free_port()
    adapter_env = {**os.environ, "PORT": str(adapter_port)}
    # OLMA_ENV/GITHUB_TOKEN intentionally unset → dev HS256 secret + StubBackend (offline).
    adapter_env.pop("GITHUB_TOKEN", None)
    adapter_env.pop("OLMA_ENV", None)
    adapter_env.pop("REDIS_URL", None)  # in-memory taint keeps it single-process/self-contained
    _spawn("adapter", ["node", str(_ADAPTER_TS)], cwd=_REPO, env=adapter_env)
    adapter_base = f"http://127.0.0.1:{adapter_port}"
    _wait_http(f"{adapter_base}/healthz")

    # --- 2) llm-proxy KEYLESS stub; emit a tool_call for the Gateway tool, args satisfy its schema ---
    llm_port = _free_port()
    llm_env = {**os.environ, "LLM_PROXY_PROVIDER": "stub",
               "LLM_PROXY_STUB_TOOL": _MCP_TOOL,
               "LLM_PROXY_STUB_TOOL_ARGS": json.dumps({"query": "login"})}
    _spawn("llm", [sys.executable, "-m", "uvicorn", "app.main:app",
                   "--host", "127.0.0.1", "--port", str(llm_port)],
           cwd=_LLM_PROXY_DIR, env=llm_env)
    _wait_http(f"http://127.0.0.1:{llm_port}/healthz")

    # --- 3) opencode serve: LLM → llm-proxy stub; MCP → the real Gateway (Bearer TASK_JWT) ---
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
        # The crux: opencode's MCP client connects to the REAL Gateway (via the adapter's /mcp),
        # presenting the TASK_JWT. opencode resolves config at load, so the token is embedded now.
        "mcp": {
            "mcp-gateway": {
                "type": "remote",
                "url": f"{adapter_base}/mcp",
                "enabled": True,
                "headers": {"Authorization": f"Bearer {task_jwt}"},
            }
        },
    }
    cfg_path = workdir / "opencode.json"
    cfg_path.write_text(json.dumps(cfg))

    oc_port = _free_port()
    oc_env = {**os.environ, "OPENCODE_CONFIG": str(cfg_path)}
    _spawn("opencode", ["opencode", "serve", "--port", str(oc_port), "--hostname", "127.0.0.1"],
           cwd=workdir, env=oc_env)
    base = f"http://127.0.0.1:{oc_port}"
    _wait_http(f"{base}/config/providers",
               predicate=lambda b: "stub" in [p.get("id") for p in json.loads(b).get("providers", [])])

    try:
        yield base, f"{adapter_base}/audit", logs
    finally:
        for p in procs:
            p.terminate()
        for p in procs:
            try:
                p.wait(timeout=10)
            except subprocess.TimeoutExpired:
                p.kill()


def _read_audit(audit_url: str) -> list[dict]:
    with urllib.request.urlopen(audit_url, timeout=5) as r:
        return json.loads(r.read().decode()).get("audit", [])


def test_opencode_turn_calls_tool_through_gateway(stack, monkeypatch):
    base, audit_url, logs = stack

    import app.runner as runner
    monkeypatch.setattr(runner, "OPENCODE_SERVER_URL", base)
    monkeypatch.setattr(runner, "OPENCODE_PROVIDER_ID", "stub")
    monkeypatch.setattr(runner, "OPENCODE_MODEL_ID", "stub-model")
    monkeypatch.setattr(runner, "OPENCODE_AGENT", "build")

    from app.bus import agent_events_subject, bus

    conversation_id = "conv_gw_it"
    events: list[dict] = []

    async def _collect(msg):
        events.append(msg.data)

    unsub = bus.subscribe(agent_events_subject(conversation_id), _collect)
    try:
        asyncio.run(runner._run_turn(conversation_id, "task_gw_it", "cherche le code de login"))
    finally:
        unsub()

    types = [e["type"] for e in events]
    diag = f"events={types} | logs={logs}"
    assert types, f"no AgentEvents produced by the real turn | {diag}"
    assert types[0] == "agent.thinking", diag
    assert types[-1] == "agent.done", diag

    # The stub-injected tool_call round-tripped through opencode's MCP client → the Gateway tool.
    tool_calls = [e for e in events if e["type"] == "agent.tool.call"]
    tool_results = [e for e in events if e["type"] == "agent.tool.result"]
    assert any(_MCP_TOOL in str(e["data"].get("tool", "")) for e in tool_calls), diag
    assert any(_MCP_TOOL in str(e["data"].get("tool", "")) for e in tool_results), diag

    # THE proof it traversed the REAL Gateway: an append-only audit row for the canonical tool,
    # status ok, attributed to the TASK_JWT subject — a builtin tool would leave NO gateway audit.
    audit = _read_audit(audit_url)
    ok_rows = [
        a for a in audit
        if a.get("tool") == _GW_TOOL and a.get("action") == "tool.call"
        and a.get("status") == "ok" and a.get("actor") == _JWT_SUB
    ]
    assert ok_rows, f"no gateway audit row for {_GW_TOOL} — call did NOT traverse the Gateway. audit={audit} | {diag}"

    done = next(e for e in events if e["type"] == "agent.done")
    assert done["data"]["task_id"] == "task_gw_it", diag
