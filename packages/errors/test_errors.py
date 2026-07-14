"""Verify the error taxonomy source + generated Python module (AX-003)."""

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

# The 16 canonical §21 codes that MUST exist.
SPEC_21 = {
    "E_AUTH_INVALID_TOKEN", "E_PERM_TOOL_DENIED", "E_PERM_REVOKED",
    "E_CONN_NEEDS_CONNECTION", "E_CONN_TOKEN_EXPIRED", "E_TOOL_UPSTREAM_ERROR",
    "E_TOOL_TIMEOUT", "E_GUARD_INPUT_BLOCKED", "E_GUARD_OUTPUT_REDACTED",
    "E_BUDGET_EXCEEDED", "E_SANDBOX_UNAVAILABLE", "E_SCHED_QUOTA_REACHED",
    "E_SCHED_INVALID_CRON", "E_SCHED_JOB_PAUSED", "E_RATE_LIMITED", "E_INTERNAL",
}


def _src():
    return json.loads((HERE / "errors.json").read_text(encoding="utf-8"))["errors"]


def _gen_module():
    subprocess.run([sys.executable, str(HERE / "gen.py")], check=True)
    path = HERE / "dist" / "python" / "olma_errors.py"
    spec = importlib.util.spec_from_file_location("olma_errors", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod  # so dataclass type resolution works
    spec.loader.exec_module(mod)
    return mod


def test_all_spec21_codes_present():
    codes = {e["code"] for e in _src()}
    assert SPEC_21 <= codes, f"missing §21 codes: {SPEC_21 - codes}"


def test_http_status_and_locales_valid():
    for e in _src():
        assert 200 <= e["http"] <= 599, e["code"]
        assert set(e["msg"]) == {"fr", "en", "ar"}, f"{e['code']} missing a locale"
        for m in e["msg"].values():
            assert m.strip(), f"{e['code']} has an empty message"


def test_generated_module_matches_source():
    mod = _gen_module()
    src_codes = {e["code"] for e in _src()}
    assert set(mod.ERRORS) == src_codes
    # constants exported
    assert mod.E_PERM_TOOL_DENIED == "E_PERM_TOOL_DENIED"


def test_retryable_flags():
    mod = _gen_module()
    assert mod.ERRORS["E_TOOL_UPSTREAM_ERROR"].retryable is True
    assert mod.ERRORS["E_PERM_TOOL_DENIED"].retryable is False
    assert mod.ERRORS["E_RATE_LIMITED"].retryable is True


def test_localized_message_and_interpolation():
    mod = _gen_module()
    assert mod.ERRORS["E_CONN_NEEDS_CONNECTION"].message("fr", provider="GitHub") == "Connectez d'abord GitHub."
    assert mod.ERRORS["E_CONN_NEEDS_CONNECTION"].message("ar", provider="GitHub").endswith("أولًا.")
    # locale with region falls back to language; unknown lang falls back to en
    assert "GitHub" in mod.ERRORS["E_CONN_NEEDS_CONNECTION"].message("en-US", provider="GitHub")
    assert mod.ERRORS["E_INTERNAL"].message("de")  # unknown → en, non-empty


def test_envelope_shape():
    mod = _gen_module()
    env = mod.envelope("E_CONV_NOT_FOUND", trace_id="abc", locale="en")
    assert env == {"error": {"code": "E_CONV_NOT_FOUND", "message": "Conversation not found.",
                             "trace_id": "abc", "retry_after": None}}


def test_backend_core_codes_are_in_taxonomy():
    """The codes backend-core already emits must exist in the shared taxonomy."""
    codes = {e["code"] for e in _src()}
    assert {"E_IDEMPOTENCY_KEY_REQUIRED", "E_CONV_NOT_FOUND"} <= codes
