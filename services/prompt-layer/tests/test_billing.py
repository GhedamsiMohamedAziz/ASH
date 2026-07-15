"""Usage overage → invoice tests (§30.1, Annexe E/F). Fully offline via StubBilling — no PSP key."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.billing import Biller, Plan, StubBilling, UsageRecord  # noqa: E402

PLAN = Plan(name="pro", seat_price_usd=30.0, included_per_seat_usd=20.0, overage_margin=0.30)


def _usage(org, month, inter, sched):
    rows = []
    if inter:
        rows.append(UsageRecord(org, month, "interactive", inter))
    if sched:
        rows.append(UsageRecord(org, month, "scheduled", sched))
    return rows


def test_no_overage_when_under_included():
    b = Biller()
    inv = b.invoice("org_1", "2026-07", _usage("org_1", "2026-07", 10.0, 5.0), PLAN, active_seats=2)
    # 2 seats × $20 included = $40 quota; usage $15 < $40 → no overage
    assert inv.overage_usd == 0.0
    assert inv.subtotal_usd == 60.0  # 2 × $30 seat
    assert inv.vat_usd == round(60.0 * 0.19, 2)


def test_overage_is_cost_plus_margin_split_by_origin():
    b = Biller()
    # 1 seat, $20 included; usage $50 ($30 interactive + $20 scheduled) → overage cost $30
    inv = b.invoice("org_1", "2026-07", _usage("org_1", "2026-07", 30.0, 20.0), PLAN, active_seats=1)
    assert inv.interactive_usd == 30.0 and inv.scheduled_usd == 20.0
    assert inv.included_usd == 20.0
    assert inv.overage_usd == round(30.0 * 1.30, 2)          # cost + 30% margin = $39
    assert inv.subtotal_usd == round(30.0 + 39.0, 2)          # seat $30 + overage $39
    assert any("Dépassement" in ln.label for ln in inv.lines)


def test_vat_and_tnd_conversion():
    b = Biller(usd_to_tnd=3.2, vat_rate=0.19)
    inv = b.invoice("org_1", "2026-07", _usage("org_1", "2026-07", 100.0, 0.0), PLAN, active_seats=1)
    assert inv.vat_usd == round(inv.subtotal_usd * 0.19, 2)
    assert inv.total_usd == round(inv.subtotal_usd + inv.vat_usd, 2)
    assert inv.total_tnd == round(inv.total_usd * 3.2, 2)
    assert inv.total_tnd > inv.total_usd  # TND figure larger at 3.2x


def test_zero_usage_bills_only_seats():
    b = Biller()
    inv = b.invoice("org_1", "2026-07", [], PLAN, active_seats=3)
    assert inv.overage_usd == 0.0
    assert inv.subtotal_usd == 90.0  # 3 × $30


def test_only_this_org_and_month_counted():
    b = Biller()
    usage = [
        UsageRecord("org_1", "2026-07", "interactive", 100.0),
        UsageRecord("org_2", "2026-07", "interactive", 999.0),  # other org
        UsageRecord("org_1", "2026-06", "interactive", 999.0),  # other month
    ]
    inv = b.invoice("org_1", "2026-07", usage, PLAN, active_seats=1)
    assert inv.interactive_usd == 100.0  # neither org_2 nor June leaked in


def test_issue_is_idempotent_per_org_month():
    stub = StubBilling()
    b = Biller(provider=stub)
    inv = b.invoice("org_1", "2026-07", _usage("org_1", "2026-07", 50.0, 0.0), PLAN, active_seats=1)
    first = b.issue(inv)
    second = b.issue(inv)  # re-run (retry) must not double-charge
    assert first["duplicate"] is False
    assert second["duplicate"] is True
    assert first["id"] == second["id"]
    assert len(stub.charges) == 1


def test_charge_amount_matches_invoice_total():
    stub = StubBilling()
    b = Biller(provider=stub)
    inv = b.invoice("org_1", "2026-07", _usage("org_1", "2026-07", 80.0, 0.0), PLAN, active_seats=2)
    rec = b.issue(inv)
    assert rec["amount_usd"] == inv.total_usd
