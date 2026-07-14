"""Multi-level budget enforcement + kill-switch (instructions.md §10.2, §15.6, §25).

Cost control is the product's spine ("maîtrise des coûts", §4.2). Spend is capped
at four levels + a global switch, checked BEFORE work commits (fail-closed):
  • per turn      (interactive, §10.2)          → E_BUDGET_EXCEEDED
  • per run       (scheduled, from the job)      → E_BUDGET_EXCEEDED
  • per job/month (a cron's monthly ceiling)     → E_BUDGET_EXCEEDED
  • per org/month (org contractual ceiling, §25) → E_BUDGET_EXCEEDED
  • org kill-switch (automations.enabled flag)   → halts scheduled runs (§15.6)

Spend is recorded to a ledger (usage_daily in prod, §16.1); here in-memory.
"""

from __future__ import annotations

from dataclasses import dataclass, field

E_BUDGET_EXCEEDED = "E_BUDGET_EXCEEDED"


class BudgetExceeded(Exception):
    code = E_BUDGET_EXCEEDED

    def __init__(self, level: str, limit: float, would_be: float) -> None:
        super().__init__(f"{level} budget ${limit:.4f} exceeded (would reach ${would_be:.4f})")
        self.level = level
        self.limit = limit
        self.would_be = would_be


@dataclass
class OrgBudget:
    monthly_org_usd: float | None = None      # org contractual ceiling (§25)
    per_turn_usd: float | None = None         # default interactive turn cap
    automations_enabled: bool = True          # kill-switch (§15.6)


@dataclass
class Ledger:
    """Records spend keyed by month. usage_daily.origin in prod (§16.1)."""

    # (org_id, month) -> usd ; (job_id, month) -> usd
    _org: dict[tuple[str, str], float] = field(default_factory=dict)
    _job: dict[tuple[str, str], float] = field(default_factory=dict)

    def org_spent(self, org_id: str, month: str) -> float:
        return self._org.get((org_id, month), 0.0)

    def job_spent(self, job_id: str, month: str) -> float:
        return self._job.get((job_id, month), 0.0)

    def record(self, org_id: str, month: str, cost: float, job_id: str | None = None) -> None:
        self._org[(org_id, month)] = self.org_spent(org_id, month) + cost
        if job_id:
            self._job[(job_id, month)] = self.job_spent(job_id, month) + cost


class BudgetGuard:
    def __init__(self, ledger: Ledger, org: OrgBudget) -> None:
        self.ledger = ledger
        self.org = org

    def _check_org_month(self, org_id: str, month: str, estimate: float) -> None:
        if self.org.monthly_org_usd is None:
            return
        would = self.ledger.org_spent(org_id, month) + estimate
        if would > self.org.monthly_org_usd:
            raise BudgetExceeded("org/month", self.org.monthly_org_usd, would)

    def check_turn(self, org_id: str, month: str, estimate: float,
                   per_turn_usd: float | None = None) -> None:
        """Interactive turn: per-turn cap + org monthly ceiling (§10.2)."""
        cap = per_turn_usd if per_turn_usd is not None else self.org.per_turn_usd
        if cap is not None and estimate > cap:
            raise BudgetExceeded("per-turn", cap, estimate)
        self._check_org_month(org_id, month, estimate)

    def check_run(self, org_id: str, job_id: str, month: str, estimate: float, *,
                  per_run_usd: float, monthly_job_usd: float | None) -> None:
        """Scheduled run: kill-switch + per-run + per-job/month + org/month (§15.6)."""
        if not self.org.automations_enabled:
            # kill-switch: automations halted for the org (interactive unaffected).
            raise BudgetExceeded("kill-switch", 0.0, estimate)
        if estimate > per_run_usd:
            raise BudgetExceeded("per-run", per_run_usd, estimate)
        if monthly_job_usd is not None:
            would = self.ledger.job_spent(job_id, month) + estimate
            if would > monthly_job_usd:
                raise BudgetExceeded("job/month", monthly_job_usd, would)
        self._check_org_month(org_id, month, estimate)

    def commit(self, org_id: str, month: str, cost: float, job_id: str | None = None) -> None:
        """Record actual spend after a turn/run completes."""
        self.ledger.record(org_id, month, cost, job_id=job_id)
