"""Personal Agent side of agent testing: private usefulness judging, feedback
to Champions, more personas, and the simulator."""

import asyncio
import json

import httpx

from champions import app as champions_app
from champions.app import create_app
from common.schemas import Insight
from personal import agent, judge, scenarios, simulator
from personal.profile import PERSONAS, ConsentStore, get_profile

QUESTION = "Find mid-size healthcare companies in Europe that are switching HR platforms"


def _i(id_, value=10, detail="", themes=("accounts",)):
    return Insight(id=id_, label=id_, value=value, detail=detail, themes=list(themes))


def test_private_notes_make_an_insight_useful():
    judged = judge.judge([_i("legacy_platform_switchers", detail="ADP (6), Oracle HCM (4)", themes=["displacement"])],
                         get_profile("priya"), QUESTION)
    assert judged[0]["useful"] is True
    assert "notes" in judged[0]["reason"]


def test_must_have_fields_make_an_insight_useful():
    judged = judge.judge([_i("crm_mix", themes=["tech", "crm"])], get_profile("marcus"), "UK fintech payroll")
    assert judged[0]["useful"] is True and "crm" in judged[0]["reason"]


def test_empty_findings_are_not_useful():
    judged = judge.judge([_i("hot_accounts", value=0)], get_profile("priya"), QUESTION)
    assert judged[0]["useful"] is False


def test_there_are_at_least_ten_personas_each_with_questions():
    assert len(PERSONAS) >= 10
    assert set(scenarios.SCENARIOS) == set(PERSONAS)
    assert all(len(qs) >= 4 for qs in scenarios.SCENARIOS.values())


async def _turn(store, persona, question, **kw):
    app = create_app()
    async with app.router.lifespan_context(app):
        return await agent.run_turn(persona, question, store, transport=httpx.ASGITransport(app=app), **kw)


def test_turn_returns_judged_insights_and_sends_only_ratings_back():
    store = ConsentStore()
    store.grant("priya", "market_insights", ["industry", "role", "goals"])
    result = asyncio.run(_turn(store, "priya", QUESTION))

    assert result["status"] == "ok", result
    assert result["insights"] and all("useful" in i and "reason" in i for i in result["insights"])
    assert any(i["useful"] for i in result["insights"])
    assert result["follow_ups"]

    outbound = [e for e in result["wire"] if e["direction"] == "out"]
    feedback = [e for e in outbound if "champions.feedback/v1" in json.dumps(e.get("body"))]
    assert len(feedback) == 1
    sent = json.dumps(feedback[0]["body"])
    for private in ("reason", "notes", "Q1 quota", "ADP or Oracle"):
        assert private not in sent, private

    row = champions_app._log.recent()[0]
    assert row["rated"] == len(result["insights"])


def test_simulator_runs_personas_and_reports():
    app = create_app()

    async def run():
        async with app.router.lifespan_context(app):
            return await simulator.run(transport=httpx.ASGITransport(app=app), personas=["priya", "aiko"])

    report = asyncio.run(run())
    assert report["conversations"] == len(scenarios.SCENARIOS["priya"]) + len(scenarios.SCENARIOS["aiko"])
    assert 0 < report["answered_pct"] <= 100
    assert report["useful_pct"] > 0
    assert report["by_persona"] and report["examples"]
    assert "# Agent-to-agent simulation" in simulator.markdown(report)
    assert champions_app._log.stats()["by_source"].get("simulator", 0) >= report["conversations"] - 2
