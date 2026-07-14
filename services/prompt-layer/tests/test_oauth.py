"""AX-038 OAuth connect flow + refresh sweep tests (§13.2, §15.7)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.oauth import OAuthError, OAuthFlows, Token  # noqa: E402


class FakeExchanger:
    def __init__(self, refresh_fails: bool = False):
        self.refresh_fails = refresh_fails

    def exchange_code(self, provider, code):
        return Token(provider, f"access-{code}", "refresh-1", expires_at=10000)

    def refresh(self, provider, refresh_token):
        if self.refresh_fails:
            raise OAuthError("refresh rejected")
        return Token(provider, "access-new", "refresh-2", expires_at=99999)


def _flows(**kw):
    return OAuthFlows(exchanger=FakeExchanger(**kw))


# ---------------------------------------------------------------- connect flow
def test_start_returns_authorize_url_with_state():
    f = _flows()
    url = f.start("usr_1", "github")
    assert url.startswith("https://github.com/login/oauth/authorize")
    assert "state=" in url


def test_callback_exchanges_and_stores_token():
    f = _flows()
    url = f.start("usr_1", "github")
    state = url.split("state=")[1].split("&")[0]
    tok = f.callback(state, "code123")
    assert tok.access_token == "access-code123"
    assert f.tokens[("usr_1", "github")].access_token == "access-code123"


def test_state_is_single_use_csrf_defense():
    f = _flows()
    state = f.start("usr_1", "github").split("state=")[1].split("&")[0]
    f.callback(state, "code")
    with pytest.raises(OAuthError):
        f.callback(state, "code")  # reused state → rejected


def test_forged_state_rejected():
    f = _flows()
    with pytest.raises(OAuthError):
        f.callback("not-a-real-state", "code")


# ---------------------------------------------------------------- refresh sweep (§15.7)
def test_sweep_refreshes_expiring_token():
    f = _flows()
    f.tokens[("usr_1", "github")] = Token("github", "a", "refresh-1", expires_at=1000)
    res = f.refresh_sweep(now=1000)  # expires now → within 24h horizon
    assert ("usr_1", "github") in res["refreshed"]
    assert f.tokens[("usr_1", "github")].access_token == "access-new"


def test_sweep_skips_healthy_token():
    f = _flows()
    f.tokens[("usr_1", "github")] = Token("github", "a", "refresh-1", expires_at=1_000_000)
    res = f.refresh_sweep(now=1000)  # far from expiry
    assert res["refreshed"] == []


def test_sweep_flags_reconnect_when_no_refresh_token():
    f = _flows()
    f.tokens[("usr_1", "notion")] = Token("notion", "a", None, expires_at=1000)
    res = f.refresh_sweep(now=1000)
    assert ("usr_1", "notion") in res["needs_reconnect"]


def test_sweep_flags_reconnect_when_refresh_fails():
    f = _flows(refresh_fails=True)
    f.tokens[("usr_1", "github")] = Token("github", "a", "refresh-1", expires_at=1000)
    res = f.refresh_sweep(now=1000)
    assert ("usr_1", "github") in res["needs_reconnect"]
