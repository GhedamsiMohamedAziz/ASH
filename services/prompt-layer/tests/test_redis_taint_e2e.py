"""Cross-process Redis taint integration test (§17.6, §4.4 "Reste à faire", ADR-012).

Proves the invariant that the Gateway (TS, services/mcp-gateway/src/taint.ts) and prompt-layer
(Python, app/redis_taint.py) TaintLedger implementations share taint state through a REAL Redis
instance — not through mocks — because they use the same key scheme (`taint:{task_id}`), the same
`SET NX EX <ttl>` monotone-set semantics, and the same `EXISTS` read.

This spins up a throwaway `redis-server` on a random high port (never touching any Redis instance
that might already be running), points both implementations at it, and asserts:

  1. A taint SET by Python is SEEN by the (real) TS `RedisTaint` — via a Node subprocess bridge
     that imports the actual services/mcp-gateway/src/taint.ts module.
  2. A taint SET by the (real) TS `RedisTaint` is SEEN by Python.
  3. The flag is monotone: a second `taint()` call (either language) does not reset the TTL or
     clear the flag — first write wins (§17.6.3).

Skips cleanly (does not fail) if `redis-server`/`redis-cli` aren't on PATH, if the `redis` Python
package isn't installed, or if the throwaway server fails to start — mirroring this repo's
skip-if-unavailable convention so CI without Redis still passes.

New file — does not modify anything under services/mcp-gateway/ or services/prompt-layer/app/.
"""

from __future__ import annotations

import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

redis = pytest.importorskip("redis", reason="redis python client not installed")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.redis_taint import RedisTaint  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[3]
NODE_BRIDGE = REPO_ROOT / "tests" / "integration" / "redis_taint_bridge.mjs"

DEFAULT_TTL_SECONDS = 900


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_ping(port: int, redis_cli: str, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            out = subprocess.run(
                [redis_cli, "-p", str(port), "ping"],
                capture_output=True,
                text=True,
                timeout=1,
            )
            if out.returncode == 0 and out.stdout.strip() == "PONG":
                return True
        except (subprocess.TimeoutExpired, OSError):
            pass
        time.sleep(0.1)
    return False


@pytest.fixture(scope="module")
def throwaway_redis():
    """Starts a standalone `redis-server` on a random free port for this test module only."""
    redis_server = shutil.which("redis-server")
    redis_cli = shutil.which("redis-cli")
    if not redis_server or not redis_cli:
        pytest.skip("redis-server/redis-cli not found on PATH")

    port = _free_port()
    proc = subprocess.Popen(
        [
            redis_server,
            "--port", str(port),
            "--bind", "127.0.0.1",
            "--save", "",
            "--daemonize", "no",
            "--loglevel", "warning",
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        if not _wait_for_ping(port, redis_cli):
            proc.terminate()
            proc.wait(timeout=5)
            pytest.skip("throwaway redis-server did not become ready in time")
        yield f"redis://127.0.0.1:{port}", port, redis_cli
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=5)


def _node_bridge(mode: str, redis_url: str, task_id: str) -> tuple[bool, str]:
    """Runs the Node bridge exercising the REAL TS RedisTaint. Returns (module_available, stdout)."""
    result = subprocess.run(
        ["node", str(NODE_BRIDGE), mode, redis_url, task_id],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode == 2 and "MODULE_NOT_FOUND:redis" in result.stderr:
        return False, ""
    assert result.returncode == 0, (
        f"node bridge failed (mode={mode}, task_id={task_id}): "
        f"stdout={result.stdout!r} stderr={result.stderr!r}"
    )
    return True, result.stdout.strip()


def _raw_key_exists(redis_cli: str, port: int, task_id: str) -> bool:
    """Fallback / cross-check: read the raw key via redis-cli, independent of either language's
    RedisTaint class — still proves the shared `taint:{task_id}` key scheme."""
    out = subprocess.run(
        [redis_cli, "-p", str(port), "exists", f"taint:{task_id}"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    return out.stdout.strip() == "1"


def _raw_ttl(redis_cli: str, port: int, task_id: str) -> int:
    out = subprocess.run(
        [redis_cli, "-p", str(port), "ttl", f"taint:{task_id}"],
        capture_output=True,
        text=True,
        timeout=5,
    )
    return int(out.stdout.strip())


def test_python_taint_seen_by_ts_redis_taint(throwaway_redis):
    """Python's RedisTaint sets a flag; the REAL TS RedisTaint (via Node bridge) reads it back true."""
    redis_url, port, redis_cli = throwaway_redis
    task_id = "e2e-py-taints"

    py_store = RedisTaint(redis_url)
    assert py_store.is_tainted(task_id) is False

    py_store.taint(task_id)

    module_available, stdout = _node_bridge("check", redis_url, task_id)
    if not module_available:
        # "redis" npm client not installed for services/mcp-gateway in this checkout — fall back
        # to a raw key check, which still proves the shared key scheme (per task instructions).
        assert _raw_key_exists(redis_cli, port, task_id), (
            "taint key not visible via raw redis-cli either — cross-process sharing broken"
        )
        pytest.skip(
            "node 'redis' client not installed under services/mcp-gateway/node_modules — "
            "verified via raw redis-cli key check instead of the real TS RedisTaint class "
            "(key scheme confirmed identical)"
        )
    assert stdout == "true", "real TS RedisTaint.isTainted() did not see the Python-set flag"


def test_ts_taint_seen_by_python_redis_taint(throwaway_redis):
    """The REAL TS RedisTaint (via Node bridge) sets a flag; Python's RedisTaint reads it back true."""
    redis_url, port, redis_cli = throwaway_redis
    task_id = "e2e-ts-taints"

    py_store = RedisTaint(redis_url)
    assert py_store.is_tainted(task_id) is False

    module_available, stdout = _node_bridge("taint", redis_url, task_id)
    if not module_available:
        pytest.skip(
            "node 'redis' client not installed under services/mcp-gateway/node_modules — "
            "cannot exercise the real TS RedisTaint.taint() for this direction"
        )
    assert stdout == "OK"

    assert py_store.is_tainted(task_id) is True, (
        "Python RedisTaint.is_tainted() did not see the flag set by the real TS RedisTaint"
    )


def test_taint_is_monotone_across_languages(throwaway_redis):
    """A second taint() call — from either language — must not clear/reset an existing flag (§17.6.3)."""
    redis_url, port, redis_cli = throwaway_redis
    task_id = "e2e-monotone"

    py_store = RedisTaint(redis_url)

    # First write: Python taints.
    py_store.taint(task_id)
    assert py_store.is_tainted(task_id) is True
    ttl_after_first = _raw_ttl(redis_cli, port, task_id)
    assert 0 < ttl_after_first <= DEFAULT_TTL_SECONDS

    time.sleep(1.1)

    # Second write: Python taints again (NX -> no-op). Flag must remain, TTL must not reset to
    # the full DEFAULT_TTL_SECONDS (it must have kept counting down from the first SET).
    py_store.taint(task_id)
    assert py_store.is_tainted(task_id) is True
    ttl_after_second_py = _raw_ttl(redis_cli, port, task_id)
    assert 0 < ttl_after_second_py < ttl_after_first, (
        "TTL was reset/extended by a second Python taint() call — flag is not monotone"
    )

    # Third write: the REAL TS RedisTaint also attempts to taint the same task_id (NX -> no-op
    # again). Cross-language monotonicity: TS cannot un-taint or refresh a flag Python set.
    module_available, stdout = _node_bridge("taint", redis_url, task_id)
    if module_available:
        assert stdout == "OK"
        assert py_store.is_tainted(task_id) is True
        ttl_after_ts = _raw_ttl(redis_cli, port, task_id)
        assert 0 < ttl_after_ts <= ttl_after_second_py, (
            "TTL was reset/extended by a cross-language (TS) taint() call on an already-tainted "
            "task_id — monotonicity is not preserved across processes"
        )
    else:
        pytest.skip(
            "node 'redis' client not installed under services/mcp-gateway/node_modules — "
            "verified monotonicity within Python only for the cross-language leg"
        )

    assert _raw_key_exists(redis_cli, port, task_id)
