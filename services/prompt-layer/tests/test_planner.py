"""AX-048 planning decomposition tests (§9.2)."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.planner import decompose  # noqa: E402


def test_chat_simple_is_single_step():
    p = decompose("what is our branch convention?", agentic=False)
    assert p.steps == ["répondre directement"] and p.budget_tier == "eco"


def test_plan_has_3_to_7_steps():
    p = decompose("déploie fix/login sur staging")
    assert 3 <= len(p.steps) <= 7
    assert p.steps[0].startswith("comprendre")
    assert p.steps[-1].startswith("récapituler")


def test_multi_action_request_is_ordered():
    p = decompose("cherche la PR, vérifie la CI, merge et préviens l'équipe")
    joined = " | ".join(p.steps)
    # order: understand → search → analyze → deploy/merge → notify → recap
    assert p.steps.index(next(s for s in p.steps if "chercher" in s)) < \
           p.steps.index(next(s for s in p.steps if "déployer" in s or "merger" in s))
    assert any("notifier" in s for s in p.steps)


def test_steps_deduped():
    p = decompose("crée une PR et ouvre une autre PR")  # both hit the 'create' rule
    creates = [s for s in p.steps if "créer le changement" in s]
    assert len(creates) == 1  # not duplicated


def test_recurrence_adds_scheduler_step():
    p = decompose("chaque lundi, résume mes PRs et envoie sur Slack", recurrence=True)
    assert p.automation_intent is True
    assert any("automatisation" in s for s in p.steps)


def test_ceiling_of_seven():
    p = decompose("cherche, analyse, crée, déploie, merge, envoie, notifie, poste, push")
    assert len(p.steps) <= 7


def test_floor_of_three():
    p = decompose("fais le nécessaire")  # no strong action verbs
    assert len(p.steps) >= 3
