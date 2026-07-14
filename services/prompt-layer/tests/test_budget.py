"""AX-050 multi-level budget + kill-switch tests (§10.2, §15.6, §25)."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.budget import BudgetExceeded, BudgetGuard, Ledger, OrgBudget  # noqa: E402

M = "2026-07"


def _guard(**org):
    return BudgetGuard(Ledger(), OrgBudget(**org))


# ---------------------------------------------------------------- per-turn (§10.2)
def test_per_turn_cap():
    g = _guard(per_turn_usd=0.10)
    g.check_turn("org_1", M, 0.05)  # under → ok
    with pytest.raises(BudgetExceeded) as e:
        g.check_turn("org_1", M, 0.20)
    assert e.value.level == "per-turn" and e.value.code == "E_BUDGET_EXCEEDED"


def test_per_turn_override_beats_org_default():
    g = _guard(per_turn_usd=0.10)
    g.check_turn("org_1", M, 0.30, per_turn_usd=0.50)  # override allows it


# ---------------------------------------------------------------- org monthly (§25)
def test_org_monthly_ceiling_accumulates():
    g = _guard(monthly_org_usd=1.00)
    for _ in range(9):
        g.check_turn("org_1", M, 0.10)
        g.commit("org_1", M, 0.10)  # 0.90 spent
    g.check_turn("org_1", M, 0.10)  # would reach 1.00 exactly → ok
    with pytest.raises(BudgetExceeded) as e:
        g.check_turn("org_1", M, 0.20)  # would reach 1.10 → deny
    assert e.value.level == "org/month"


def test_org_monthly_is_per_month():
    g = _guard(monthly_org_usd=0.50)
    g.commit("org_1", "2026-07", 0.50)
    g.check_turn("org_1", "2026-08", 0.40)  # next month is fresh


# ---------------------------------------------------------------- per-run + job/month (§15.6)
def test_per_run_cap():
    g = _guard()
    g.check_run("org_1", "job_1", M, 0.05, per_run_usd=0.12, monthly_job_usd=None)
    with pytest.raises(BudgetExceeded) as e:
        g.check_run("org_1", "job_1", M, 0.20, per_run_usd=0.12, monthly_job_usd=None)
    assert e.value.level == "per-run"


def test_job_monthly_ceiling():
    g = _guard()
    for _ in range(5):
        g.check_run("org_1", "job_1", M, 0.10, per_run_usd=0.12, monthly_job_usd=0.60)
        g.commit("org_1", M, 0.10, job_id="job_1")  # 0.50
    with pytest.raises(BudgetExceeded) as e:
        g.check_run("org_1", "job_1", M, 0.15, per_run_usd=0.20, monthly_job_usd=0.60)
    assert e.value.level == "job/month"


# ---------------------------------------------------------------- kill-switch (§15.6)
def test_kill_switch_halts_scheduled_runs():
    g = _guard(automations_enabled=False)
    with pytest.raises(BudgetExceeded) as e:
        g.check_run("org_1", "job_1", M, 0.01, per_run_usd=1.0, monthly_job_usd=None)
    assert e.value.level == "kill-switch"


def test_kill_switch_does_not_affect_interactive():
    g = _guard(automations_enabled=False, per_turn_usd=0.10)
    g.check_turn("org_1", M, 0.05)  # a human turn still works when automations are off


# ---------------------------------------------------------------- layering
def test_org_ceiling_applies_to_runs_too():
    g = _guard(monthly_org_usd=0.30)
    g.commit("org_1", M, 0.25)
    with pytest.raises(BudgetExceeded) as e:
        g.check_run("org_1", "job_1", M, 0.10, per_run_usd=1.0, monthly_job_usd=None)  # 0.35 > 0.30
    assert e.value.level == "org/month"
