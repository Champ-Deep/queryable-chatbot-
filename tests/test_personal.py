"""Personal Agent: planning, consent enforcement, evaluation, full A2A turn."""

import asyncio
import json

import httpx
import pytest

from champions.app import create_app
from common.schemas import CardMatch, CatalogResult
from personal import agent, evaluator, planner
from personal.profile import ConsentStore, get_profile, shared_context

QUESTION = "Find mid-size healthcare companies in Europe that are switching HR platforms"


# ------------------------------------------------------------------ planner

def test_planner_reads_segment_and_intent_from_the_question():
    request, purpose = planner.plan(QUESTION, get_profile("priya"), [])
    assert request.skill == "get_insights"
    assert request.filters.industries == ["Healthcare"]
    assert request.filters.regions == ["EMEA"]
    assert request.filters.size_bands == ["Mid-market"]
    assert request.filters.intent_topics == ["HR Platform Replacement"]
    assert purpose == "market_insights"


def test_planner_uses_stored_segment_only_with_consent():
    profile = get_profile("priya")
    without, _ = planner.plan("Show me the market", profile, ["industry"])
    with_consent, _ = planner.plan("Show me the market", profile, ["target_segment"])
    assert without.filters.industries == []
    assert with_consent.filters.industries == ["Healthcare"]


def test_contact_requests_are_outreach_purpose():
    _, purpose = planner.plan("Give me HR decision makers' emails at UK banks", get_profile("marcus"), [])
    assert purpose == "outreach"


# ------------------------------------------------------------------ consent

def test_private_fields_can_never_be_consented():
    with pytest.raises(ValueError):
        ConsentStore().grant("priya", "market_insights", ["industry", "budget_monthly_credits"])


def test_shared_context_contains_only_consented_fields():
    store = ConsentStore()
    consent = store.grant("priya", "market_insights", ["industry", "role"])
    shared = shared_context(get_profile("priya"), consent)
    assert shared == {"industry": "HR Software", "role": "Head of Sales"}


def test_revoked_consent_stops_sharing():
    store = ConsentStore()
    store.grant("priya", "market_insights", ["industry"])
    assert store.revoke("priya", "market_insights")
    assert store.active("priya", "market_insights") is None


# ---------------------------------------------------------------- evaluator

def _catalog(*matches, companies=400):
    return CatalogResult(matches=list(matches), matching_companies=companies, method="test")


def _m(card_id, relevance, refresh, credits, personal=False, fields=()):
    return CardMatch(card_id=card_id, name=card_id.title(), relevance=relevance, why="test",
                     matched_fields=list(fields), coverage_pct=80, refresh=refresh,
                     credits_per_1k_records=credits, contains_personal_data=personal)


def test_evaluator_keeps_bundle_within_private_budget():
    rec = evaluator.evaluate(_catalog(
        _m("intent_signals", 0.95, "daily", 120, fields=["intent_score"]),
        _m("technographics", 0.9, "weekly", 75, fields=["hr_platform"]),
        _m("firmographics", 0.95, "monthly", 40, fields=["employee_count"]),
    ), get_profile("priya"))
    assert rec.bundle_monthly_credits <= 600
    assert rec.within_budget
    assert "intent_signals" in rec.bundle


def test_gdpr_strict_user_is_steered_away_from_personal_data():
    rec = evaluator.evaluate(_catalog(_m("contacts", 1.0, "weekly", 10, personal=True)), get_profile("priya"))
    option = rec.options[0]
    assert option.verdict == "not_recommended"
    assert any("DPA" in r for r in option.reasons)


# ---------------------------------------------------- full turn over A2A + MCP

async def _turn(store, persona, question):
    app = create_app()
    async with app.router.lifespan_context(app):
        return await agent.run_turn(persona, question, store, transport=httpx.ASGITransport(app=app))


def test_turn_without_consent_asks_first_and_sends_nothing():
    result = asyncio.run(_turn(ConsentStore(), "priya", QUESTION))
    assert result["status"] == "consent_required"
    assert not any(e["direction"] == "out" for e in result["wire"])


def test_full_turn_goes_oauth_card_a2a_mcp_and_shares_only_consented_fields():
    store = ConsentStore()
    store.grant("priya", "market_insights", ["industry", "role"])
    result = asyncio.run(_turn(store, "priya", QUESTION))

    assert result["status"] == "ok", result
    protocols = [e["protocol"] for e in result["wire"] if e["direction"] == "out"]
    assert protocols[0] == "OAuth2"
    assert "A2A card" in protocols and "A2A" in protocols and "MCP" in protocols

    sent = json.dumps([e.get("body") for e in result["wire"] if e["direction"] == "out"])
    assert "HR Software" in sent and "Head of Sales" in sent
    for secret in ("PeopleFlow", "Q1 quota", "gdpr_strict", "demo-secret-change-me"):
        assert secret not in sent, secret

    rec = result["recommendation"]
    assert rec["bundle"] and rec["within_budget"]
    assert result["catalog"]["matching_companies"] > 0


def test_wire_titles_name_the_json_rpc_method():
    store = ConsentStore()
    store.grant("priya", "market_insights", ["industry"])
    result = asyncio.run(_turn(store, "priya", QUESTION))
    titles = [e["title"] for e in result["wire"] if e["direction"] == "out"]
    assert any("SendMessage" in t for t in titles)
    assert any("tools/call get_vaf_fields" in t for t in titles)


def test_whole_numbers_from_protobuf_come_back_as_ints():
    from common.schemas import Insight

    assert Insight(label="x", value=16.0).value == 16
    assert isinstance(Insight(label="x", value=16.0).value, int)
    assert Insight(label="x", value=2.5).value == 2.5


def test_capability_question_lists_catalog_instead_of_a_shopping_list():
    store = ConsentStore()
    store.grant("aiko", "data_discovery", ["industry"])
    result = asyncio.run(_turn(store, "aiko", "What data can Champions provide?"))
    assert result["answer"].startswith("Champions offers 6 data cards")
    assert "Best fits for your profile" in result["answer"]
    assert "Buy " not in result["answer"]


def test_budget_wording_when_bundle_uses_all_of_it():
    rec = evaluator.evaluate(_catalog(_m("technographics", 0.9, "weekly", 75)), get_profile("marcus"))
    assert "uses your full 300-credit budget" in rec.summary
