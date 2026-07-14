"""AX-033 approval flow tests (§13.3, §3.3)."""

import uuid

import pytest
from fastapi.testclient import TestClient

from app.approvals import ApprovalError, ApprovalManager, ApprovalStatus
from app.main import app, store, approvals


@pytest.fixture(autouse=True)
def _reset():
    store.conversations.clear()
    store.idempotency.clear()
    approvals.approvals.clear()
    yield


@pytest.fixture
def client():
    return TestClient(app)


# ------------------------------------------------------------------ manager unit
def test_create_and_approve():
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="github.merge_pr", args_summary="#42",
                 requester="usr_1", approver_group=None, now=100)
    assert a.status is ApprovalStatus.pending
    r = m.resolve(a.id, decision="approve", approver="usr_1", now=101)
    assert r.status is ApprovalStatus.approved and r.approver == "usr_1"


def test_deny():
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="t", args_summary="", requester="u",
                 approver_group=None, now=0)
    r = m.resolve(a.id, decision="deny", approver="u", now=1)
    assert r.status is ApprovalStatus.denied


def test_expired_cannot_be_resolved():
    m = ApprovalManager(ttl_seconds=10)
    a = m.create(conversation_id="c1", tool="t", args_summary="", requester="u",
                 approver_group=None, now=0)
    with pytest.raises(ApprovalError):
        m.resolve(a.id, decision="approve", approver="u", now=100)  # past ttl
    assert m.get(a.id).status is ApprovalStatus.expired


def test_team_mode_requester_cannot_self_approve():
    """§3.3: with a designated approver_group, the requester can't approve themselves."""
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="github.merge_pr", args_summary="",
                 requester="usr_mehdi", approver_group="tech-leads", now=0)
    with pytest.raises(ApprovalError):
        m.resolve(a.id, decision="approve", approver="usr_mehdi", now=1)
    # a different tech-lead can
    r = m.resolve(a.id, decision="approve", approver="usr_lead", now=1, approver_in_group=True)
    assert r.status is ApprovalStatus.approved and r.approver == "usr_lead"


def test_team_mode_approver_must_be_in_group():
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="t", args_summary="", requester="u",
                 approver_group="tech-leads", now=0)
    with pytest.raises(ApprovalError):
        m.resolve(a.id, decision="approve", approver="usr_x", now=1, approver_in_group=False)


def test_audit_records_both_parties():
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="github.merge_pr", args_summary="",
                 requester="usr_req", approver_group="tech-leads", now=0)
    m.resolve(a.id, decision="approve", approver="usr_appr", now=1, approver_in_group=True)
    d = m.audit_detail(a)
    assert d["requester"] == "usr_req" and d["approver"] == "usr_appr"


def test_group_gate_fails_closed_when_membership_not_computed():
    """A caller that forgets to pass approver_in_group must DENY, not admit (fail closed)."""
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="github.merge_pr", args_summary="",
                 requester="usr_req", approver_group="tech-leads", now=0)
    with pytest.raises(ApprovalError, match="not in the designated group"):
        m.resolve(a.id, decision="approve", approver="usr_other", now=1)  # default False now


def test_promote_moves_tool_into_allowed_after_approval():
    """§13.3 re-mint context: an approved tool moves approval_tools → allowed_tools."""
    from app.approvals import ApprovalStatus
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="github.merge_pr", args_summary="PR #42",
                 requester="usr_1", approver_group=None, now=0,
                 user_id="usr_1", org_id="org_1", args={"repo": "acme/x", "number": 42},
                 allowed_tools=["github.search", "github.create_pr"],
                 approval_tools=["github.merge_pr"])
    m.resolve(a.id, decision="approve", approver="usr_1", now=1)  # Mode A self-approve OK
    assert a.status is ApprovalStatus.approved
    allowed, approval = ApprovalManager.promote(a)
    assert "github.merge_pr" in allowed and "github.merge_pr" not in approval
    assert a.args == {"repo": "acme/x", "number": 42}  # replay context preserved


def test_promote_rejects_unapproved():
    m = ApprovalManager()
    a = m.create(conversation_id="c1", tool="t", args_summary="", requester="u",
                 approver_group=None, now=0)
    with pytest.raises(ApprovalError):
        ApprovalManager.promote(a)  # still pending


# ------------------------------------------------------------------ HTTP flow
def test_http_request_then_approve(client):
    conv = client.post("/api/v1/conversations", json={}).json()
    cid = conv["id"]
    r = client.post(f"/api/v1/conversations/{cid}/request-approval",
                    json={"tool": "github.merge_pr", "args_summary": "PR #42"})
    aid = r.json()["approval_id"]
    assert r.json()["status"] == "pending"

    ok = client.post(f"/api/v1/conversations/{cid}/approve",
                     json={"approval_id": aid, "decision": "approve"})
    assert ok.status_code == 200
    assert ok.json()["status"] == "approved"


def test_http_double_resolve_conflicts(client):
    conv = client.post("/api/v1/conversations", json={}).json()
    cid = conv["id"]
    aid = client.post(f"/api/v1/conversations/{cid}/request-approval",
                      json={"tool": "t"}).json()["approval_id"]
    client.post(f"/api/v1/conversations/{cid}/approve",
                json={"approval_id": aid, "decision": "approve"})
    dup = client.post(f"/api/v1/conversations/{cid}/approve",
                      json={"approval_id": aid, "decision": "deny"})
    assert dup.status_code == 409  # already resolved


def test_http_approval_needed_event_emitted(client):
    conv = client.post("/api/v1/conversations", json={}).json()
    cid = conv["id"]
    with client.websocket_connect(f"/api/v1/conversations/{cid}/stream") as ws:
        ws.send_json({"type": "subscribe", "last_seq": 0})
        client.post(f"/api/v1/conversations/{cid}/request-approval",
                    json={"tool": "github.merge_pr", "args_summary": "PR #7"})
        ev = ws.receive_json()
    assert ev["type"] == "agent.approval.needed"
    assert ev["data"]["tool"] == "github.merge_pr"
