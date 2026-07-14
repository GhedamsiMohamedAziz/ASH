"""AX-040 admin console API tests (§24.1-24.3)."""

import pytest

from app.admin import Actor, AdminDenied, AdminService, ToolPolicy


def _svc():
    return AdminService()


ORG_ADMIN = Actor("usr_admin", "org_1", "admin")
MEMBER = Actor("usr_m", "org_1", "member")
PLATFORM = Actor("usr_root", "org_platform", "admin", platform_admin=True)


# ---------------------------------------------------------------- RBAC
def test_org_admin_can_set_own_org_policy():
    s = _svc()
    s.set_policy(ORG_ADMIN, ToolPolicy("org_1", "member", "github.merge_pr", "require_approval"))
    assert len(s.list_policies(ORG_ADMIN, "org_1")) == 1


def test_member_cannot_admin():
    s = _svc()
    with pytest.raises(AdminDenied):
        s.set_policy(MEMBER, ToolPolicy("org_1", "member", "x", "allow"))


def test_org_admin_cannot_touch_other_org():
    s = _svc()
    with pytest.raises(AdminDenied):
        s.set_policy(ORG_ADMIN, ToolPolicy("org_2", "member", "x", "allow"))


def test_platform_admin_spans_all_orgs():
    s = _svc()
    s.set_policy(PLATFORM, ToolPolicy("org_1", "member", "x", "allow"))
    s.set_policy(PLATFORM, ToolPolicy("org_2", "member", "y", "deny"))
    assert len(s.list_policies(PLATFORM, "org_1")) == 1


# ---------------------------------------------------------------- audit (§24.1)
def test_every_admin_action_audited():
    s = _svc()
    s.set_budget(ORG_ADMIN, "org_1", 100.0)
    s.set_policy(ORG_ADMIN, ToolPolicy("org_1", "member", "x", "allow"))
    actions = [a["action"] for a in s.audit]
    assert "budget.set" in actions and "policy.set" in actions
    assert all(a["actor"] == "admin" for a in s.audit)


def test_platform_admin_actions_also_audited():
    s = _svc()
    s.set_budget(PLATFORM, "org_1", 500.0)
    assert s.audit[-1]["platform_admin"] is True


def test_org_admin_audit_scoped_to_org():
    s = _svc()
    s.set_policy(PLATFORM, ToolPolicy("org_2", "member", "z", "deny"))  # other org
    s.set_policy(ORG_ADMIN, ToolPolicy("org_1", "member", "x", "allow"))
    rows = s.query_audit(ORG_ADMIN, "org_1")
    assert all("org_1" in r["target"] for r in rows)


# ---------------------------------------------------------------- view-as (§24.1)
def test_view_as_requires_reason_and_is_readonly():
    s = _svc()
    with pytest.raises(AdminDenied):
        s.view_as(ORG_ADMIN, "usr_x", "org_1", reason="")
    res = s.view_as(ORG_ADMIN, "usr_x", "org_1", reason="debugging a support ticket")
    assert res["read_only"] is True
    assert s.audit[-1]["action"] == "view_as" and s.audit[-1]["details"]["reason"]
