"""Champions side of agent testing: personalised answers, query log, feedback,
REST API with an internal key, MCP tools that wrap that API, and the Lab."""

import json

from common.auth import API_KEY
from tests.test_champions import a2a_send, artifact, mcp_call

PRIYA_REQUEST = {
    "skill": "get_insights",
    "need": "Find mid-size healthcare companies in Europe that are switching HR platforms",
    "filters": {"industries": ["Healthcare"], "regions": ["EMEA"], "size_bands": ["Mid-market"],
                "intent_topics": ["HR Platform Replacement"]},
    "context": {"consent_id": "c-1", "purpose": "market_insights",
                "shared": {"industry": "HR Software", "role": "Head of Sales",
                           "goals": ["Build pipeline with companies replacing their HR platform"]}},
}


def _init_mcp(client, bearer):
    return mcp_call(client, bearer, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                   "clientInfo": {"name": "t", "version": "1"}})


def _tool(client, bearer, name, arguments):
    _init_mcp(client, bearer)
    result = mcp_call(client, bearer, "tools/call", {"name": name, "arguments": arguments}).json()["result"]
    assert not result.get("isError"), result
    return json.loads(result["content"][0]["text"])


def test_a2a_answer_is_personalised_and_logged(champions, bearer):
    _, result = artifact(a2a_send(champions, bearer, PRIYA_REQUEST))
    assert result["query_id"].startswith("q-")
    assert set(result["personalised_for"]) == {"role", "goals", "industry"}
    assert len(result["insights"]) == 6
    top = result["insights"][0]
    assert top["id"] != "segment_size" and top["why_for_you"] and top["follow_ups"]

    recent = champions.get("/lab/api/recent").json()["queries"]
    assert recent[0]["query_id"] == result["query_id"]
    assert recent[0]["channel"] == "a2a" and recent[0]["intent"] == "tech_displacement"
    assert recent[0]["shared_role"] == "Head of Sales"


def test_feedback_over_a2a_updates_usefulness(champions, bearer):
    _, result = artifact(a2a_send(champions, bearer, PRIYA_REQUEST))
    ids = [i["id"] for i in result["insights"]]
    task, ack = artifact(a2a_send(champions, bearer, {
        "schema": "champions.feedback/v1", "query_id": result["query_id"],
        "ratings": [{"insight_id": ids[0], "useful": True}, {"insight_id": ids[1], "useful": False}]}))
    assert task["status"]["state"] == "TASK_STATE_COMPLETED"
    assert ack["recorded"] == 2

    stats = champions.get("/lab/api/stats").json()
    assert stats["useful_pct"] == 50.0 and stats["rated"] == 2


def test_feedback_for_unknown_query_fails(champions, bearer):
    task, _ = artifact(a2a_send(champions, bearer, {
        "schema": "champions.feedback/v1", "query_id": "q-missing",
        "ratings": [{"insight_id": "x", "useful": True}]}))
    assert task["status"]["state"] == "TASK_STATE_FAILED"


def test_rest_api_needs_the_internal_key(champions):
    assert champions.get("/api/v1/cards").status_code == 401
    cards = champions.get("/api/v1/cards", headers={"X-API-Key": API_KEY}).json()
    assert len(cards) == 6


def test_rest_insights_endpoint_logs_the_channel(champions):
    response = champions.post("/api/v1/insights", json=PRIYA_REQUEST,
                              headers={"X-API-Key": API_KEY, "X-Champions-Channel": "rest"})
    assert response.status_code == 200
    assert champions.get("/lab/api/recent").json()["queries"][0]["channel"] == "rest"


def test_mcp_tools_wrap_the_rest_api_without_caller_api_keys(champions, bearer):
    assert "X-API-Key" not in bearer
    out = _tool(champions, bearer, "get_insights", {
        "need": "companies switching HR platforms", "industries": ["Healthcare"], "regions": ["EMEA"],
        "role": "Head of Sales"})
    assert out["insights"][0]["why_for_you"].startswith("As Head of Sales")
    assert out["query_id"].startswith("q-")

    row = champions.get("/lab/api/recent").json()["queries"][0]
    assert row["channel"] == "mcp" and row["client"] == "personal-agent-demo"

    found = _tool(champions, bearer, "find_data_cards", {"need": "CRM data for UK fintechs"})
    assert any(m["card_id"] == "technographics" for m in found["matches"])

    stats = _tool(champions, bearer, "get_query_stats", {})
    assert stats["total"] == 2


def test_lab_page_and_exports(champions, bearer):
    a2a_send(champions, bearer, PRIYA_REQUEST)
    page = champions.get("/lab")
    assert page.status_code == 200 and "Agent Lab" in page.text
    csv_text = champions.get("/lab/api/export.csv").text
    assert csv_text.startswith("query_id,") and "switching HR platforms" in csv_text
    jsonl = champions.get("/lab/api/export.jsonl").text
    assert json.loads(jsonl.splitlines()[0])["channel"] == "a2a"


# ------------------------------------------------------------- security fixes

def test_lab_api_refuses_non_local_callers(tmp_path):
    from fastapi.testclient import TestClient

    from champions.app import create_app

    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url="http://champions",
                    client=("203.0.113.9", 5000)) as remote:
        assert remote.get("/lab/api/recent").status_code == 403
        assert remote.get("/lab/api/export.csv").status_code == 403


def test_lab_clear_needs_a_non_simple_header(champions):
    assert champions.post("/lab/api/clear").status_code == 403
    assert champions.post("/lab/api/clear", headers={"X-Requested-With": "lab"}).status_code == 200


def test_feedback_only_for_your_own_queries(champions, bearer):
    from champions import app as champions_app

    _, result = artifact(a2a_send(champions, bearer, PRIYA_REQUEST))
    assert champions_app._log.add_feedback(result["query_id"], {"x": True}, client="someone-else") is False
    assert champions_app._log.add_feedback(result["query_id"], {"x": True}, client="personal-agent-demo") is True


def test_mcp_query_stats_only_cover_the_callers_own_queries(champions, bearer):
    from champions import app as champions_app
    from common.schemas import CapabilityRequest

    champions_app._log.record(CapabilityRequest(skill="get_insights", need="another partner's secret plan"),
                              channel="a2a", client="other-partner", shared={}, cards=[], insight_ids=[],
                              matching=1, latency_ms=1)
    a2a_send(champions, bearer, PRIYA_REQUEST)
    stats = _tool(champions, bearer, "get_query_stats", {})
    assert stats["total"] == 1
    assert "secret plan" not in json.dumps(stats)


def test_api_key_has_no_hardcoded_default():
    from common import auth

    assert auth.API_KEY != "champions-internal-demo-key" and len(auth.API_KEY) >= 32


def test_lab_refuses_foreign_host_headers(champions):
    # DNS rebinding: a local browser reaches 127.0.0.1 under an attacker's host name.
    assert champions.get("/lab/api/recent", headers={"Host": "evil.example"}).status_code == 403
    assert champions.get("/lab/api/recent", headers={"Host": "127.0.0.1:9100"}).status_code == 200
    assert champions.get("/lab/api/recent", headers={"Host": "localhost:9100"}).status_code == 200


def test_mcp_vaf_fields_rejects_unknown_card_ids(champions, bearer):
    _init_mcp(champions, bearer)
    for card_id in ("../query-stats", "..%2Fquery-stats", "nope"):
        result = mcp_call(champions, bearer, "tools/call",
                          {"name": "get_vaf_fields", "arguments": {"card_id": card_id}}).json()["result"]
        assert result.get("isError"), card_id
        assert "total" not in result["content"][0]["text"]


def test_rest_query_stats_are_scoped_to_the_partner_called_for(champions):
    from champions import app as champions_app
    from common.schemas import CapabilityRequest

    for client in ("partner-a", "partner-b", "partner-b"):
        champions_app._log.record(CapabilityRequest(skill="get_insights", need=f"{client} plan"),
                                  channel="a2a", client=client, shared={}, cards=[], insight_ids=[],
                                  matching=1, latency_ms=1)
    headers = {"X-API-Key": API_KEY, "X-On-Behalf-Of": "partner-a"}
    assert champions.get("/api/v1/query-stats", headers=headers).json()["total"] == 1
    assert champions.get("/api/v1/query-stats?client=partner-b", headers=headers).json()["total"] == 1
    internal = champions.get("/api/v1/query-stats", headers={"X-API-Key": API_KEY}).json()
    assert internal["total"] == 3
