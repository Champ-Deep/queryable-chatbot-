"""Champions REST API (/api/v1): the plain endpoints the MCP server wraps.

Protected by an internal API key (``X-API-Key``). Partner agents never get
this key: they reach the same functions through A2A or MCP with their own
OAuth token, and Champions' MCP server calls this API on their behalf.

Optional headers from internal callers:
  X-Champions-Channel  which door the query came through (mcp, rest)
  X-On-Behalf-Of       the partner client id, for the query log
"""

import json
import secrets

from fastapi import APIRouter, Depends, Header, HTTPException, Request

from champions import service
from champions.catalog import BY_ID, CARDS
from common import auth
from common.schemas import CapabilityRequest, Feedback


def _key(x_api_key: str = Header("")):
    if not secrets.compare_digest(x_api_key, auth.API_KEY):
        raise HTTPException(401, "missing or invalid X-API-Key")


def _who(request: Request):
    return (request.headers.get("x-champions-channel", "rest"),
            request.headers.get("x-on-behalf-of", "internal"))


def router(log):
    api = APIRouter(prefix="/api/v1", dependencies=[Depends(_key)], tags=["Champions API"])

    @api.get("/cards")
    def cards():
        return [{"id": c.id, "name": c.name, "description": c.description, "refresh": c.refresh,
                 "credits_per_1k_records": c.credits_per_1k_records, "vaf_field_count": len(c.vaf_fields),
                 "contains_personal_data": c.contains_personal_data} for c in CARDS]

    @api.get("/cards/{card_id}/fields")
    def fields(card_id: str):
        card = BY_ID.get(card_id)
        if card is None:
            raise HTTPException(404, f"Unknown card_id {card_id!r}. Known: {', '.join(BY_ID)}")
        return {"card_id": card.id, "name": card.name, "vaf_fields": [f.model_dump() for f in card.vaf_fields]}

    def _answer(body, skill, request):
        channel, client = _who(request)
        body = body.model_copy(update={"skill": skill})
        result = service.answer(body, log=log, channel=channel, client=client)
        return json.loads(result.model_dump_json(by_alias=True))

    @api.post("/search")
    def search(body: CapabilityRequest, request: Request):
        return _answer(body, "find_data_cards", request)

    @api.post("/insights")
    def insights(body: CapabilityRequest, request: Request):
        return _answer(body, "get_insights", request)

    @api.post("/feedback")
    def feedback(body: Feedback, request: Request):
        recorded = service.feedback(body, log=log, client=_who(request)[1])
        if recorded is None:
            raise HTTPException(404, f"unknown query_id {body.query_id}")
        return {"recorded": recorded}

    @api.get("/query-stats")
    def query_stats(client: str | None = None):
        return log.stats(client=client)

    return api
