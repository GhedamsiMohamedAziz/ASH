"""Usage overage → invoice, behind a payment-provider seam (§25, §30.1, Annexe E/F).

Pricing model (§30.1): bill the ACTIVE seat (not the provisioned one), an included usage quota
per seat with visible caps, and transparent overage = actual cost + margin. Usage is split by
origin (interactive vs scheduled) for the invoice — `usage_daily.origin` is the source of truth.

The seam, same shape as the LLM/GitHub edges: `BillingProvider` has a `StubBilling` default
(deterministic, offline, no key) so the whole calculation + issuance path is testable without a
real PSP. A real processor (Stripe, a local Tunisian PSP) drops in behind the identical interface;
only the actual charge call spends money. Issuance is idempotent per (org, month) — never a double
charge — following the dedup-on-success discipline (ADR-016).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Protocol


@dataclass(frozen=True)
class UsageRecord:
    """One usage_daily-shaped row: cost for an org in a month, tagged by origin."""
    org_id: str
    month: str        # "2026-07"
    origin: str       # interactive | scheduled
    cost_usd: float


@dataclass(frozen=True)
class Plan:
    """A pricing plan (§30.1). Included quota is per ACTIVE seat; overage is cost + margin."""
    name: str
    seat_price_usd: float          # monthly price per active seat
    included_per_seat_usd: float   # usage included per active seat
    overage_margin: float = 0.30   # 30% margin on pass-through overage (§30.1 "au réel + marge")


@dataclass(frozen=True)
class InvoiceLine:
    label: str
    amount_usd: float


@dataclass
class Invoice:
    org_id: str
    month: str
    lines: list[InvoiceLine] = field(default_factory=list)
    subtotal_usd: float = 0.0
    vat_rate: float = 0.19          # Tunisia standard VAT (§30, Annexe E)
    vat_usd: float = 0.0
    total_usd: float = 0.0
    usd_to_tnd: float = 3.10        # directional; a real rate feed injects this
    total_tnd: float = 0.0
    # Transparency: usage split by origin (§30.1 caps visible in the UI).
    interactive_usd: float = 0.0
    scheduled_usd: float = 0.0
    included_usd: float = 0.0
    overage_usd: float = 0.0


class BillingProvider(Protocol):
    def charge(self, *, org_id: str, month: str, amount_usd: float,
               description: str, idempotency_key: str) -> dict: ...


class StubBilling:
    """Deterministic offline provider — records charges, idempotent per key. The real PSP
    (Stripe / local processor) injects behind this same interface; only IT spends money."""

    def __init__(self) -> None:
        self.charges: dict[str, dict] = {}

    def charge(self, *, org_id: str, month: str, amount_usd: float,
               description: str, idempotency_key: str) -> dict:
        if idempotency_key in self.charges:
            return {**self.charges[idempotency_key], "duplicate": True}
        rec = {"id": f"ch_{len(self.charges) + 1:06d}", "org_id": org_id, "month": month,
               "amount_usd": round(amount_usd, 4), "description": description}
        self.charges[idempotency_key] = rec
        return {**rec, "duplicate": False}


def _round(x: float) -> float:
    return round(x + 1e-9, 2)


class Biller:
    """Computes an invoice from usage records + a plan, and issues it via the provider."""

    def __init__(self, provider: BillingProvider | None = None, *,
                 usd_to_tnd: float = 3.10, vat_rate: float = 0.19) -> None:
        self.provider = provider or StubBilling()
        self.usd_to_tnd = usd_to_tnd
        self.vat_rate = vat_rate

    def invoice(self, org_id: str, month: str, usage: list[UsageRecord], plan: Plan,
                active_seats: int) -> Invoice:
        rows = [u for u in usage if u.org_id == org_id and u.month == month]
        interactive = sum(u.cost_usd for u in rows if u.origin == "interactive")
        scheduled = sum(u.cost_usd for u in rows if u.origin == "scheduled")
        usage_total = interactive + scheduled

        base = active_seats * plan.seat_price_usd
        included = active_seats * plan.included_per_seat_usd
        overage_cost = max(0.0, usage_total - included)
        overage = overage_cost * (1.0 + plan.overage_margin)

        lines = [InvoiceLine(f"{active_seats} siège(s) actif(s) × ${plan.seat_price_usd:.2f}", _round(base))]
        if overage > 0:
            lines.append(InvoiceLine(
                f"Dépassement d'usage (${overage_cost:.4f} au réel + {int(plan.overage_margin*100)}% marge)",
                _round(overage)))

        subtotal = _round(base + overage)
        vat = _round(subtotal * self.vat_rate)
        total_usd = _round(subtotal + vat)
        return Invoice(
            org_id=org_id, month=month, lines=lines, subtotal_usd=subtotal,
            vat_rate=self.vat_rate, vat_usd=vat, total_usd=total_usd,
            usd_to_tnd=self.usd_to_tnd, total_tnd=_round(total_usd * self.usd_to_tnd),
            interactive_usd=_round(interactive), scheduled_usd=_round(scheduled),
            included_usd=_round(included), overage_usd=_round(overage),
        )

    def issue(self, inv: Invoice) -> dict:
        """Charge the invoice total via the provider — idempotent per (org, month)."""
        return self.provider.charge(
            org_id=inv.org_id, month=inv.month, amount_usd=inv.total_usd,
            description=f"Axone {inv.month} — {inv.total_tnd:.2f} TND (dont TVA {int(inv.vat_rate*100)}%)",
            idempotency_key=f"{inv.org_id}:{inv.month}")
