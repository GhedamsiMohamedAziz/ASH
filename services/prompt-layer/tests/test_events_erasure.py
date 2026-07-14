"""AX-066 event-driven automations + AX-097 user-erasure tests (§15.8, §15.7)."""

import hashlib
import hmac
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.event_triggers import (  # noqa: E402
    EventAutomation,
    EventRouter,
    EventSignatureError,
    verify_signature,
)
from app.erasure import ErasureStores, erase_user  # noqa: E402
from app.memory import MemoryStore  # noqa: E402
from app.procedural import ProceduralNotes  # noqa: E402
from app.oauth import OAuthFlows, Token  # noqa: E402
from app.scheduler import JobStore  # noqa: E402
from app.scheduled import JobStatus, ScheduledJob  # noqa: E402


def _sign(secret, body):
    return "sha256=" + hmac.new(secret.encode(), body.encode(), hashlib.sha256).hexdigest()


# ---------------------------------------------------------------- event triggers (AX-066)
def _router():
    r = EventRouter(secrets={"github": "gh-secret"})
    r.register(EventAutomation("a1", "usr_1", "org_1", "github", "pull_request.opened",
                               "review PR {number} in {repo}", match={"repo": "checkout"}))
    return r


def test_matching_event_produces_inbound():
    r = _router()
    payload = {"repo": "checkout", "number": 42, "id": "pr42"}
    body = '{"pr":42}'
    out = r.process("github", "pull_request.opened", body, _sign("gh-secret", body), payload)
    assert len(out) == 1
    assert out[0]["channel"] == "scheduler"
    assert out[0]["text"] == "review PR 42 in checkout"  # interpolated


def test_non_matching_filter_is_skipped():
    r = _router()
    payload = {"repo": "other-repo", "number": 1, "id": "x"}
    body = "{}"
    out = r.process("github", "pull_request.opened", body, _sign("gh-secret", body), payload)
    assert out == []  # repo filter didn't match


def test_bad_signature_rejected_fail_closed():
    r = _router()
    with pytest.raises(EventSignatureError):
        r.process("github", "pull_request.opened", "{}", "sha256=deadbeef", {"repo": "checkout"})


def test_unknown_source_rejected():
    r = _router()
    with pytest.raises(EventSignatureError):
        r.process("gitlab", "x", "{}", "sig", {})


def test_verify_signature_helper():
    assert verify_signature("s", "body", _sign("s", "body"))
    assert not verify_signature("s", "body", _sign("other", "body"))


# ---------------------------------------------------------------- user-erasure (AX-097)
def test_erasure_purges_all_stores():
    mem = MemoryStore()
    mem.save("a fact", "fact", now=0)
    mem.save("another", "fact", now=0)
    proc = ProceduralNotes()
    proc.append("checkout", "deploy via ArgoCD")
    oauth = OAuthFlows(exchanger=None)  # type: ignore[arg-type]
    oauth.tokens[("usr_1", "github")] = Token("github", "a", "r", expires_at=1)
    oauth.tokens[("usr_2", "github")] = Token("github", "b", "r", expires_at=1)  # other user
    jobs = JobStore()
    j = jobs.create(ScheduledJob(id="job_1", user_id="usr_1", org_id="org_1", role="member",
                                 prompt="p", required_tools=[], cron="0 9 * * 1",
                                 status=JobStatus.draft))
    jobs.approve(j.id)  # draft → pending_approval (on create) → active

    manifest = erase_user("usr_1", ErasureStores(memory=mem, procedural=proc, oauth=oauth,
                                                 jobs=jobs), projects=["checkout"])
    assert manifest["memories"] == 2
    assert manifest["procedural_notes"] == 1
    assert manifest["oauth_tokens"] == 1               # only usr_1's token
    assert manifest["scheduled_jobs"] == 1
    # verify actual purge
    assert mem.all() == []
    assert proc.get("checkout") == []
    assert ("usr_1", "github") not in oauth.tokens
    assert ("usr_2", "github") in oauth.tokens         # other user untouched
    assert jobs.get("job_1").status is JobStatus.deleted


def test_erasure_is_idempotent():
    mem = MemoryStore()
    mem.save("x", "fact", now=0)
    s = ErasureStores(memory=mem)
    erase_user("usr_1", s)
    second = erase_user("usr_1", s)  # no-op
    assert second["memories"] == 0
