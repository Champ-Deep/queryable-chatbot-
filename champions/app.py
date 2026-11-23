"""Champions Group Agent: A2A server + MCP server + OAuth token endpoint.

    uvicorn champions.app:app --port 9100

Endpoints
  GET  /.well-known/agent-card.json   A2A Agent Card (public)
  POST /oauth/token                   OAuth2 client credentials -> scoped JWT
  POST /a2a                           A2A JSON-RPC (SendMessage, GetTask, ...)  [Bearer]
  POST /mcp                           MCP Streamable HTTP (tools)               [Bearer]
  GET  /audit                         this client's audit entries               [Bearer, audit:read]
  *    /api/v1/...                      REST API that the MCP tools wrap          [X-API-Key, internal]
  GET  /lab                             Agent Lab: what partner agents ask         [operator, localhost]
"""

import contextlib
import contextvars
import json
import os
import threading
import time
from urllib.parse import quote

import httpx
from a2a.helpers import get_data_parts, new_data_part, new_task_from_user_message, new_text_message
from a2a.server.agent_execution import AgentExecutor
from a2a.server.request_handlers import DefaultRequestHandler
from a2a.server.routes import add_a2a_routes_to_fastapi, create_agent_card_routes, create_jsonrpc_routes
from a2a.server.tasks import InMemoryTaskStore, TaskUpdater
from a2a.types.a2a_pb2 import (
    AgentCapabilities, AgentCard, AgentInterface, AgentProvider, AgentSkill,
    HTTPAuthSecurityScheme, SecurityRequirement, SecurityScheme, StringList,
)
from fastapi import FastAPI, Form, Request
from fastapi.responses import JSONResponse
from mcp.server.mcpserver import MCPServer
from mcp.server.mcpserver.exceptions import ToolError
from mcp.server.transport_security import TransportSecuritySettings
from pydantic import ValidationError

from champions import api as rest_api
from champions import lab, service
from champions.catalog import CARDS
from champions.querylog import QueryLog
from common import auth
from common.http import tls_context
from common.schemas import CapabilityRequest, Feedback

PUBLIC_URL = os.getenv("CHAMPIONS_URL", "http://127.0.0.1:9100")
ALLOWED_HOSTS = ["127.0.0.1:*", "localhost:*", "champions", "champions:*"]

# Claims of the authenticated caller for the current request.
current_claims = contextvars.ContextVar("current_claims", default=None)

SKILL_SCOPES = {
    "describe_capabilities": "catalog:read",
    "find_data_cards": "catalog:read",
    "get_insights": "insights:read",
    "submit_feedback": "catalog:read",
}

# Set by create_app: the query log, and the app the MCP tools call the REST API on.
_log = None
_api_app = None
API_URL = os.getenv("CHAMPIONS_API_URL")  # wrap a remote API instead of this process

# ------------------------------------------------------------------ audit log

_audit = []
_audit_lock = threading.Lock()
AUDIT_LIMIT = 500


def audit(event, **fields):
    claims = current_claims.get() or {}
    entry = {"at": time.strftime("%Y-%m-%dT%H:%M:%S"), "client": claims.get("sub"), "event": event, **fields}
    with _audit_lock:
        _audit.append(entry)
        del _audit[:-AUDIT_LIMIT]
    return entry


# ------------------------------------------------------------------ A2A agent

def agent_card():
    bearer = SecurityScheme(http_auth_security_scheme=HTTPAuthSecurityScheme(
        scheme="Bearer", bearer_format="JWT",
        description=f"OAuth2 client credentials: POST {PUBLIC_URL}/oauth/token",
    ))
    return AgentCard(
        name="Champions Group Agent",
        description="Company data provider. Knows the Champions data cards and VAF fields, "
        "matches them to a buyer's need and returns aggregate insights. Never exports records "
        "or personal data over A2A.",
        version="1.0.0",
        provider=AgentProvider(organization="Champions Group (demo)", url="https://champions.example"),
        supported_interfaces=[AgentInterface(
            url=f"{PUBLIC_URL}/a2a", protocol_binding="JSONRPC", protocol_version="1.0")],
        capabilities=AgentCapabilities(streaming=False, push_notifications=False),
        security_schemes={"bearer": bearer},
        security_requirements=[SecurityRequirement(schemes={"bearer": StringList(list=["catalog:read"])})],
        default_input_modes=["application/json"],
        default_output_modes=["application/json"],
        skills=[
            AgentSkill(
                id="describe_capabilities", name="Describe capabilities",
                description="Lists every data card with its VAF fields, coverage and refresh.",
                tags=["catalog"], examples=["What data can Champions provide?"],
                input_modes=["application/json"], output_modes=["application/json"]),
            AgentSkill(
                id="find_data_cards", name="Find data cards",
                description="Ranks data cards and VAF fields for a described need and segment.",
                tags=["catalog", "matching"],
                examples=["Mid-size healthcare companies in Europe switching HR platforms"],
                input_modes=["application/json"], output_modes=["application/json"]),
            AgentSkill(
                id="get_insights", name="Get insights",
                description="Card matches plus aggregate insights and a small sample for a segment "
                "(needs insights:read).",
                tags=["insights"], examples=["How many fintechs in the UK are researching payroll?"],
                input_modes=["application/json"], output_modes=["application/json"]),
            AgentSkill(
                id="submit_feedback", name="Submit feedback",
                description="Rate which insights from an earlier answer were useful "
                "(champions.feedback/v1: query_id + insight ratings, no reasons).",
                tags=["feedback", "quality"], examples=["insight hot_accounts was useful"],
                input_modes=["application/json"], output_modes=["application/json"]),
        ],
    )


class ChampionsExecutor(AgentExecutor):
    async def execute(self, context, event_queue):
        task = context.current_task or new_task_from_user_message(context.message)
        await event_queue.enqueue_event(task)
        updater = TaskUpdater(event_queue, task.id, task.context_id)

        def fail(reason):
            audit("rejected", reason=reason, task_id=task.id)
            return updater.failed(new_text_message(reason, context_id=task.context_id, task_id=task.id))

        parts = get_data_parts(context.message.parts)
        if not parts:
            await fail("Send a DataPart with a champions.capability_request/v1 payload.")
            return
        claims = current_claims.get() or {}

        if str(parts[0].get("schema", "")).startswith("champions.feedback/"):
            try:
                fb = Feedback.model_validate(parts[0])
            except ValidationError as error:
                await fail(f"Invalid feedback: {error.errors()[0]['msg']}")
                return
            try:
                auth.require_scope(claims, SKILL_SCOPES["submit_feedback"])
            except auth.AuthError as error:
                await fail(error.message)
                return
            # Callers can only rate their own queries.
            recorded = service.feedback(fb, log=_log, client=claims.get("sub"))
            if recorded is None:
                await fail(f"Unknown query_id {fb.query_id}")
                return
            audit("a2a.submit_feedback", task_id=task.id, query_id=fb.query_id, ratings=recorded)
            await updater.add_artifact([new_data_part({"schema": "champions.feedback_ack/v1",
                                                       "query_id": fb.query_id, "recorded": recorded})],
                                       name="feedback_ack")
            await updater.complete()
            return

        try:
            request = CapabilityRequest.model_validate(parts[0])
        except ValidationError as error:
            await fail(f"Invalid capability_request: {error.errors()[0]['msg']}")
            return

        try:
            auth.require_scope(claims, SKILL_SCOPES[request.skill])
        except auth.AuthError as error:
            await fail(error.message)
            return

        result = service.answer(request, log=_log, channel="a2a", client=claims.get("sub"))
        audit(
            "a2a." + request.skill,
            task_id=task.id,
            consent_id=request.context.consent_id if request.context else None,
            purpose=request.context.purpose if request.context else None,
            shared_fields=sorted(request.context.shared) if request.context else [],
            cards=[m.card_id for m in result.matches],
            matching_companies=result.matching_companies,
            query_id=result.query_id,
        )
        payload = json.loads(result.model_dump_json(by_alias=True))
        await updater.add_artifact([new_data_part(payload)], name="catalog_result")
        await updater.complete()

    async def cancel(self, context, event_queue):
        return None


# ------------------------------------------------------------------ MCP tools
#
# The MCP server wraps the Champions REST API. It holds the internal API key
# and knows the endpoints; an MCP client (a partner agent, Claude Desktop...)
# only presents its own OAuth token and calls tools by name.

mcp = MCPServer(
    name="champions-catalog",
    instructions="Champions Group data catalog: data cards, VAF field definitions, personalised "
    "aggregate insights and query statistics. All tools are read-only. Pass role and goals to "
    "get_insights for insights ranked for that person.",
)


def _api_client():
    claims = current_claims.get() or {}
    headers = {"X-API-Key": auth.API_KEY, "X-Champions-Channel": "mcp",
               "X-On-Behalf-Of": claims.get("sub", "")}
    if API_URL:
        return httpx.AsyncClient(base_url=API_URL, headers=headers, timeout=20, verify=tls_context())
    return httpx.AsyncClient(base_url="http://champions-api", headers=headers, timeout=20, verify=tls_context(),
                             transport=httpx.ASGITransport(app=_api_app))


async def _call(method, path, body=None):
    async with _api_client() as http:
        response = await http.request(method, f"/api/v1{path}", json=body)
    if response.status_code != 200:
        is_json = "json" in response.headers.get("content-type", "")
        detail = response.json().get("detail") if is_json else response.text[:200]
        raise ToolError(f"Champions API {response.status_code}: {detail}")
    return response.json()


def _request(skill, need, industries, regions, countries, size_bands, intent_topics, shared=None):
    body = {"skill": skill, "need": need or "", "filters": {
        "industries": industries or [], "regions": regions or [], "countries": countries or [],
        "size_bands": size_bands or [], "intent_topics": intent_topics or []}}
    if shared:
        body["context"] = {"consent_id": "mcp-caller-declared", "purpose": "market_insights", "shared": shared}
    return body


@mcp.tool()
async def list_data_cards() -> list[dict]:
    """List Champions data cards with description, refresh, price and field count."""

    audit("mcp.list_data_cards")
    return await _call("GET", "/cards")


@mcp.tool()
async def get_vaf_fields(card_id: str) -> dict:
    """VAF field definitions (type, coverage %, refresh, example) for one data card."""

    result = await _call("GET", f"/cards/{card_id}/fields")
    audit("mcp.get_vaf_fields", card_id=card_id)
    return result


@mcp.tool()
async def find_data_cards(
    need: str,
    industries: list[str] | None = None,
    regions: list[str] | None = None,
    countries: list[str] | None = None,
    size_bands: list[str] | None = None,
    intent_topics: list[str] | None = None,
) -> dict:
    """Rank data cards and VAF fields for a described need and segment."""

    result = await _call("POST", "/search", _request(
        "find_data_cards", need, industries, regions, countries, size_bands, intent_topics))
    audit("mcp.find_data_cards", query_id=result["query_id"])
    return result


@mcp.tool()
async def get_insights(
    need: str = "",
    industries: list[str] | None = None,
    regions: list[str] | None = None,
    countries: list[str] | None = None,
    size_bands: list[str] | None = None,
    intent_topics: list[str] | None = None,
    role: str = "",
    goals: list[str] | None = None,
    industry: str = "",
) -> dict:
    """Aggregate insights for a segment, ranked for the person (role, goals, industry).
    Needs the insights:read scope."""

    try:
        auth.require_scope(current_claims.get() or {}, "insights:read")
    except auth.AuthError as error:
        raise ToolError(error.message) from error
    shared = {k: v for k, v in (("role", role), ("goals", goals), ("industry", industry)) if v}
    result = await _call("POST", "/insights", _request(
        "get_insights", need, industries, regions, countries, size_bands, intent_topics, shared))
    audit("mcp.get_insights", matching_companies=result["matching_companies"], query_id=result["query_id"])
    return result


@mcp.tool()
async def get_query_stats() -> dict:
    """Your own queries to Champions: totals, intents, useful insights and gaps."""

    audit("mcp.get_query_stats")
    # Partners only ever see their own queries; the cross-partner view is the operator Lab.
    client = (current_claims.get() or {}).get("sub", "")
    return await _call("GET", f"/query-stats?client={quote(client)}")


# ------------------------------------------------------------------ app

class BearerAuth:
    """ASGI middleware: protected paths need a valid bearer token."""

    PROTECTED = ("/a2a", "/mcp", "/audit")

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or not scope["path"].startswith(self.PROTECTED):
            await self.app(scope, receive, send)
            return
        headers = {k.decode().lower(): v.decode() for k, v in scope["headers"]}
        try:
            claims = auth.verify_token(headers.get("authorization"))
        except auth.AuthError as error:
            response = JSONResponse(
                {"error": "unauthorized", "detail": error.message}, status_code=error.status,
                headers={"WWW-Authenticate": f'Bearer realm="champions", error="invalid_token"'})
            await response(scope, receive, send)
            return
        token = current_claims.set(claims)
        try:
            await self.app(scope, receive, send)
        finally:
            current_claims.reset(token)


def create_app(log_path=None):
    global _log, _api_app
    _log = QueryLog(log_path)
    card = agent_card()
    handler = DefaultRequestHandler(
        agent_executor=ChampionsExecutor(), task_store=InMemoryTaskStore(), agent_card=card)

    # Each app gets its own MCP transport: its session manager can run once.
    mcp_app = mcp.streamable_http_app(
        streamable_http_path="/mcp",
        stateless_http=True,
        json_response=True,
        transport_security=TransportSecuritySettings(
            enable_dns_rebinding_protection=True,
            allowed_hosts=ALLOWED_HOSTS,
            allowed_origins=["http://127.0.0.1:*", "http://localhost:*"],
        ),
    )

    @contextlib.asynccontextmanager
    async def lifespan(_app):
        async with mcp_app.router.lifespan_context(mcp_app):
            yield

    app = FastAPI(title="Champions Group Agent", lifespan=lifespan)

    @app.post("/oauth/token")
    def token(
        grant_type: str = Form(...),
        client_id: str = Form(...),
        client_secret: str = Form(...),
        scope: str = Form(""),
    ):
        if grant_type != "client_credentials":
            return JSONResponse({"error": "unsupported_grant_type"}, status_code=400)
        try:
            issued = auth.issue_token(client_id, client_secret, scope)
        except auth.AuthError as error:
            return JSONResponse({"error": error.message}, status_code=error.status)
        audit("oauth.token_issued", client_id=client_id, scope=issued["scope"])
        return issued

    @app.get("/audit")
    def audit_log(request: Request):
        claims = current_claims.get() or {}
        try:
            auth.require_scope(claims, "audit:read")
        except auth.AuthError as error:
            return JSONResponse({"error": error.message}, status_code=error.status)
        with _audit_lock:
            mine = [e for e in _audit if e.get("client") == claims["sub"]
                    or e.get("client_id") == claims["sub"]]
        return {"entries": mine[-50:]}

    @app.get("/health")
    def health():
        return {"status": "ok", "agent": "champions", "cards": len(CARDS)}

    add_a2a_routes_to_fastapi(
        app,
        agent_card_routes=create_agent_card_routes(card),
        jsonrpc_routes=create_jsonrpc_routes(handler, rpc_url="/a2a"),
    )

    app.include_router(rest_api.router(_log))
    app.include_router(lab.router(_log))
    app.router.routes.extend(mcp_app.routes)

    app.add_middleware(BearerAuth)
    _api_app = app
    return app


app = create_app()
