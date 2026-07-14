"""AX-089 platctl CLI tests (§24.4)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from platctl import run  # noqa: E402


class FakeAdmin:
    def __init__(self):
        self.calls = []

    def status(self):
        self.calls.append("status"); return {"slo": "green", "pool": 8}

    def sandbox(self, action, target):
        self.calls.append(("sandbox", action, target)); return {"ok": True}

    def jobs_pause(self, org, all_orgs):
        self.calls.append(("jobs_pause", org, all_orgs)); return {"paused": org or "ALL"}

    def budget_set(self, org, monthly):
        self.calls.append(("budget", org, monthly)); return {"org": org, "monthly": monthly}

    def offboard(self, user_id):
        self.calls.append(("offboard", user_id)); return {"erasure": "started"}

    def audit_tail(self, filter_expr):
        self.calls.append(("audit", filter_expr)); return [{"action": "tool.call"}]

    def schedules_resync(self):
        self.calls.append("resync"); return {"resynced": 12}

    def connectors(self, action, cid):
        self.calls.append(("connectors", action, cid)); return {"health": "ok"}


def test_status():
    c = FakeAdmin()
    assert run(["status"], c)["slo"] == "green"


def test_sandbox_list():
    c = FakeAdmin()
    run(["sandbox", "list"], c)
    assert ("sandbox", "list", None) in c.calls


def test_jobs_pause_org():
    c = FakeAdmin()
    assert run(["jobs", "pause", "--org", "acme"], c)["paused"] == "acme"


def test_budget_set():
    c = FakeAdmin()
    assert run(["budget", "set", "--org", "acme", "--monthly", "500"], c)["monthly"] == 500.0


def test_audit_tail_filter():
    c = FakeAdmin()
    run(["audit", "tail", "--filter", "tool=github.merge_pr"], c)
    assert ("audit", "tool=github.merge_pr") in c.calls


def test_schedules_resync():
    c = FakeAdmin()
    assert run(["schedules", "resync"], c)["resynced"] == 12


# ---------------------------------------------------------------- destructive guard (§24.4)
def test_destructive_needs_confirmation():
    c = FakeAdmin()
    r = run(["sandbox", "kill", "sb_1"], c)  # no confirm
    assert r.get("needs_confirm") is True
    assert c.calls == []  # not executed


def test_destructive_runs_with_confirm():
    c = FakeAdmin()
    run(["sandbox", "kill", "sb_1"], c, confirm=True)
    assert ("sandbox", "kill", "sb_1") in c.calls


def test_offboard_is_destructive():
    c = FakeAdmin()
    assert run(["user", "offboard", "usr_x"], c).get("needs_confirm") is True
    run(["user", "offboard", "usr_x"], c, confirm=True)
    assert ("offboard", "usr_x") in c.calls
