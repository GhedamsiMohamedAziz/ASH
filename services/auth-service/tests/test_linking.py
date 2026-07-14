import sys; from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pytest
from app.linking import LinkingError, LinkingService

def test_start_complete_roundtrip():
    s = LinkingService("secret")
    state = s.start("slack", "U123", now=1000)
    binding = s.complete(state, "usr_1", now=1001)
    assert binding == {"provider": "slack", "external_id": "U123", "user_id": "usr_1"}

def test_single_use():
    s = LinkingService("secret")
    state = s.start("slack", "U123", now=1000)
    s.complete(state, "usr_1", now=1001)
    with pytest.raises(LinkingError):
        s.complete(state, "usr_1", now=1002)  # reused

def test_expired():
    s = LinkingService("secret", ttl=10)
    state = s.start("slack", "U123", now=1000)
    with pytest.raises(LinkingError):
        s.complete(state, "usr_1", now=2000)

def test_forged_signature():
    s = LinkingService("secret")
    state = s.start("slack", "U123", now=1000)
    tampered = state.rsplit("|",1)[0] + "|deadbeef"
    with pytest.raises(LinkingError):
        s.complete(tampered, "usr_1", now=1001)

def test_malformed():
    s = LinkingService("secret")
    with pytest.raises(LinkingError):
        s.complete("garbage", "usr_1")
