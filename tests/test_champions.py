"""Champions Group Agent: OAuth, A2A, MCP and audit over HTTP."""

import json

import pytest

from tests.conftest import CLIENT_ID, token

MCP_HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def a2a_send(client, headers, payload):
    body = {
        "jsonrpc": "2.0", "id": "1", "method": "SendMessage",
        "params": {"message": {"messageId": "m1", "role": "ROLE_USER", "parts": [{"data": payload}]}},
    }
    return client.post("/a2a", json=body, headers={"A2A-Version": "1.0", **headers})


def artifact(response):
    task = response.json()["result"]["task"]
    return task, task["artifacts"][0]["parts"][0]["data"] if task.get("artifacts") else None


def mcp_call(client, headers, method, params=None):
    body = {"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}}
    return client.post("/mcp", json=body, headers={**MCP_HEADERS, **headers})


# ----------------------------------------------------------------- OAuth

def test_token_has_requested_scopes_and_expiry(champions):
    response = champions.post("/oauth/token", data={
        "grant_type": "client_credentials", "client_id": CLIENT_ID,
        "client_secret": "demo-secret-change-me", "scope": "catalog:read"})
    body = response.json()
    assert body["token_type"] == "Bearer" and body["scope"] == "catalog:read"
    assert 0 < body["expires_in"] <= 300


@pytest.mark.parametrize("secret, scope, status", [
    ("wrong", "", 401),
    ("demo-secret-change-me", "contacts:read", 400),
])
def test_token_refuses_bad_secret_or_ungranted_scope(champions, secret, scope, status):
    response = champions.post("/oauth/token", data={
        "grant_type": "client_credentials", "client_id": CLIENT_ID,
        "client_secret": secret, "scope": scope})
    assert response.status_code == status


# ------------------------------------------------------------------ A2A

def test_agent_card_is_public_and_declares_bearer(champions):
    card = champions.get("/.well-known/agent-card.json").json()
    assert card["name"] == "Champions Group Agent"
    assert {s["id"] for s in card["skills"]} == {"describe_capabilities", "find_data_cards", "get_insights"}
    assert card["securitySchemes"]["bearer"]["httpAuthSecurityScheme"]["scheme"] == "Bearer"
    assert card["supportedInterfaces"][0]["url"].endswith("/a2a")


def test_a2a_without_token_is_401(champions):
    response = a2a_send(champions, {}, {"skill": "describe_capabilities", "need": "x"})
    assert response.status_code == 401
    assert "Bearer" in response.headers["www-authenticate"]


def test_a2a_get_insights_returns_matches_and_aggregates(champions, bearer):
    response = a2a_send(champions, bearer, {
        "schema": "champions.capability_request/v1",
        "skill": "get_insights",
        "need": "mid-size healthcare companies in Europe switching HR platforms",
        "filters": {"industries": ["Healthcare"], "regions": ["EMEA"], "size_bands": ["Mid-market"]},
        "context": {"consent_id": "c-1", "purpose": "market_insights",
                    "shared": {"industry": "HR Software", "role": "Head of Sales"}},
    })
    task, result = artifact(response)
    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    cards = [m["card_id"] for m in result["matches"]]
    assert cards[0] == "firmographics" and "intent_signals" in cards and "technographics" in cards
    assert result["matching_companies"] > 0
    assert result["consent_id"] == "c-1"
    assert len(result["sample"]) <= 5
    assert not any("email" in json.dumps(row) for row in result["sample"])


def test_a2a_insights_need_insights_scope(champions):
    headers = {"Authorization": f"Bearer {token(champions, 'catalog:read')}"}
    response = a2a_send(champions, headers, {"skill": "get_insights", "need": "x"})
    task, _ = artifact(response)
    assert task["status"]["state"] == "TASK_STATE_FAILED"
    assert "insights:read" in json.dumps(task["status"])


def test_a2a_rejects_malformed_payload(champions, bearer):
    task, _ = artifact(a2a_send(champions, bearer, {"skill": "delete_everything"}))
    assert task["status"]["state"] == "TASK_STATE_FAILED"


# ------------------------------------------------------------------ MCP

def test_mcp_without_token_is_401(champions):
    assert mcp_call(champions, {}, "tools/list").status_code == 401


def test_mcp_lists_and_calls_tools(champions, bearer):
    init = mcp_call(champions, bearer, "initialize", {
        "protocolVersion": "2025-06-18", "capabilities": {},
        "clientInfo": {"name": "test", "version": "1"}})
    assert init.status_code == 200, init.text

    tools = mcp_call(champions, bearer, "tools/list").json()["result"]["tools"]
    assert {t["name"] for t in tools} == {"list_data_cards", "get_vaf_fields", "get_insights"}

    called = mcp_call(champions, bearer, "tools/call",
                      {"name": "get_vaf_fields", "arguments": {"card_id": "intent_signals"}}).json()
    content = json.loads(called["result"]["content"][0]["text"])
    assert content["card_id"] == "intent_signals"
    assert {f["name"] for f in content["vaf_fields"]} >= {"intent_topic", "intent_score"}


def test_mcp_insights_need_insights_scope(champions):
    headers = {"Authorization": f"Bearer {token(champions, 'catalog:read')}"}
    called = mcp_call(champions, headers, "tools/call",
                      {"name": "get_insights", "arguments": {"industries": ["Retail"]}}).json()
    assert called["result"]["isError"] is True
    assert "insights:read" in json.dumps(called["result"])


# ---------------------------------------------------------------- audit

def test_audit_records_consent_and_shared_field_names_only(champions, bearer):
    a2a_send(champions, bearer, {
        "skill": "find_data_cards", "need": "retail CRM",
        "context": {"consent_id": "c-audit", "purpose": "data_discovery",
                    "shared": {"industry": "Retail"}}})
    entries = champions.get("/audit", headers=bearer).json()["entries"]
    entry = next(e for e in entries if e.get("consent_id") == "c-audit")
    assert entry["purpose"] == "data_discovery"
    assert entry["shared_fields"] == ["industry"]
    assert "Retail" not in json.dumps(entry)


def test_intent_topic_is_a_share_of_the_segment_not_a_filter():
    from champions import matcher
    from common.schemas import Filters

    segment = Filters(industries=["Healthcare"], regions=["EMEA"], size_bands=["Mid-market"])
    with_topic = segment.model_copy(update={"intent_topics": ["HR Platform Replacement"]})
    total_segment, _, _ = matcher.insights_for(segment)
    total, insights, sample = matcher.insights_for(with_topic)

    assert total == total_segment >= 30
    topic = next(i for i in insights if i.label == "Researching HR Platform Replacement")
    assert 0 < topic.value < total
    assert sample[0]["intent_topic"] == "HR Platform Replacement"
