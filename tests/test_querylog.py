"""Query log: what agents ask, what we answered, and whether it was useful."""

import csv
import io
import json

import pytest

from champions import querylog
from common.schemas import CapabilityRequest, Filters


@pytest.fixture()
def log(tmp_path):
    return querylog.QueryLog(tmp_path / "q.db")


@pytest.mark.parametrize("need, skill, filters, outputs, expected", [
    ("What data can Champions provide?", "describe_capabilities", {}, [], "catalog"),
    ("Size the APAC manufacturing market", "get_insights", {"industries": ["Manufacturing"]}, [], "market_sizing"),
    ("Companies switching HR platforms", "get_insights", {"intent_topics": ["HR Platform Replacement"]}, [],
     "tech_displacement"),
    ("Emails of HR decision makers", "get_insights", {}, ["contacts"], "contacts"),
    ("Whose HR contract renews next quarter?", "get_insights", {}, [], "timing_renewals"),
    ("Fast-growing funded fintechs", "get_insights", {}, ["financials"], "growth_signals"),
    ("Find accounts in UK banks to target", "get_insights", {"industries": ["Financial Services"]}, [],
     "account_discovery"),
    ("What ERP do German manufacturers use?", "get_insights", {"intent_topics": ["ERP Upgrade"]}, [],
     "tech_stack"),
    ("Which cloud do US retailers use today?", "get_insights", {}, [], "tech_stack"),
    ("Retail companies in Latin America researching analytics", "get_insights",
     {"intent_topics": ["Data Analytics"]}, [], "intent_research"),
    ("Payroll outsourcing intent in Australia", "get_insights", {"intent_topics": ["Payroll Outsourcing"]}, [],
     "intent_research"),
])
def test_classify_intent(need, skill, filters, outputs, expected):
    request = CapabilityRequest(skill=skill, need=need, filters=Filters(**filters), desired_outputs=outputs)
    assert querylog.classify(request) == expected


def test_gaps_are_detected():
    vague = CapabilityRequest(skill="get_insights", need="what's hot right now?")
    assert "segment_not_understood" in querylog.gaps(vague, matching=2400)
    contacts = CapabilityRequest(skill="get_insights", need="emails", desired_outputs=["contacts"],
                                 filters=Filters(industries=["Retail"]))
    assert "contacts_not_available" in querylog.gaps(contacts, matching=300)
    nothing = CapabilityRequest(skill="get_insights", need="x", filters=Filters(industries=["Retail"]))
    assert querylog.gaps(nothing, matching=0) == ["no_results"]


def test_record_feedback_and_stats(log):
    request = CapabilityRequest(skill="get_insights", need="Companies switching HR platforms",
                                filters=Filters(industries=["Healthcare"],
                                                intent_topics=["HR Platform Replacement"]),
                                source="simulator")
    qid = log.record(request, channel="a2a", client="personal-agent-demo",
                     shared={"role": "Head of Sales", "industry": "HR Software", "goals": ["x"]},
                     cards=["firmographics"], insight_ids=["hot_accounts", "segment_size"],
                     matching=88, latency_ms=12.5)
    log.add_feedback(qid, {"hot_accounts": True, "segment_size": False})

    stats = log.stats()
    assert stats["total"] == 1 and stats["answered_pct"] == 100.0
    assert stats["useful_pct"] == 50.0
    assert stats["by_intent"][0]["intent"] == "tech_displacement"
    assert stats["insights"][0] == {"insight": "hot_accounts", "shown": 1, "rated": 1, "useful": 1,
                                    "useful_pct": 100.0}
    assert stats["by_source"] == {"simulator": 1}
    assert stats["by_role"][0]["role"] == "Head of Sales"

    row = log.recent()[0]
    assert row["need"] == "Companies switching HR platforms" and row["useful"] == 1 and row["rated"] == 2
    assert "goals" not in json.dumps(row["shared_role"])


def test_feedback_for_unknown_query_is_rejected(log):
    assert log.add_feedback("nope", {"a": True}) is False


def test_export_csv_and_jsonl(log):
    log.record(CapabilityRequest(skill="describe_capabilities", need="catalog?"), channel="mcp",
               client="c", shared={}, cards=[], insight_ids=[], matching=2400, latency_ms=1)
    rows = list(csv.DictReader(io.StringIO(log.export("csv"))))
    assert rows[0]["intent"] == "catalog" and rows[0]["channel"] == "mcp"
    line = json.loads(log.export("jsonl").splitlines()[0])
    assert line["need"] == "catalog?"


def test_log_survives_reopen(tmp_path):
    querylog.QueryLog(tmp_path / "q.db").record(
        CapabilityRequest(skill="get_insights", need="x"), channel="a2a", client="c", shared={},
        cards=[], insight_ids=[], matching=1, latency_ms=1)
    assert querylog.QueryLog(tmp_path / "q.db").stats()["total"] == 1
