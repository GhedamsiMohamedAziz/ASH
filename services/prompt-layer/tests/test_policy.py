"""Tests for the permissions engine (AX-032, §9.4)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.policy import ALLOW, DENY, REQUIRE_APPROVAL, Policy, PolicyEngine  # noqa: E402


def _engine():
    return PolicyEngine([
        Policy("org_1", "member", "github.search", "allow"),
        Policy("org_1", "member", "github.merge_pr", "require_approval", "tech-leads"),
        Policy("org_1", "member", "database.write", "deny"),
        Policy("org_1", "power_user", "github.*", "allow"),
        Policy("org_1", "power_user", "github.merge_pr", "require_approval", "tech-leads"),
    ])


def test_exact_allow_and_deny():
    e = _engine()
    assert e.evaluate("org_1", "member", "github.search") == (ALLOW, None)
    assert e.evaluate("org_1", "member", "database.write") == (DENY, None)


def test_require_approval_carries_group():
    e = _engine()
    assert e.evaluate("org_1", "member", "github.merge_pr") == (REQUIRE_APPROVAL, "tech-leads")


def test_no_match_is_fail_closed_deny():
    e = _engine()
    assert e.evaluate("org_1", "member", "unknown.tool") == (DENY, None)
    # unknown org → deny everything (isolation)
    assert e.evaluate("org_other", "member", "github.search") == (DENY, None)


def test_exact_beats_wildcard():
    """power_user has github.* allow, but github.merge_pr exact require_approval wins."""
    e = _engine()
    assert e.evaluate("org_1", "power_user", "github.search") == (ALLOW, None)
    assert e.evaluate("org_1", "power_user", "github.merge_pr")[0] == REQUIRE_APPROVAL


def test_compute_tools_partitions():
    e = _engine()
    allowed, approval, groups = e.compute_tools(
        "org_1", "member",
        ["github.search", "github.merge_pr", "database.write", "nope.tool"])
    assert "github.search" in allowed
    assert "github.merge_pr" in allowed and "github.merge_pr" in approval
    assert "database.write" not in allowed   # deny → excluded
    assert "nope.tool" not in allowed        # no match → excluded (fail-closed)
    assert groups["github.merge_pr"] == "tech-leads"


def test_wildcard_specificity_ordering():
    e = PolicyEngine([
        Policy("o", "r", "*", "deny"),
        Policy("o", "r", "github.*", "allow"),
        Policy("o", "r", "github.merge_pr", "require_approval"),
    ])
    assert e.evaluate("o", "r", "database.read") == (DENY, None)      # only '*' matches
    assert e.evaluate("o", "r", "github.create_pr") == (ALLOW, None)  # github.* wins over '*'
    assert e.evaluate("o", "r", "github.merge_pr")[0] == REQUIRE_APPROVAL  # exact wins
