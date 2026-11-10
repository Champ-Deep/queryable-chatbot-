"""Champions Group Agent: A2A server + MCP server + OAuth token endpoint.

    uvicorn champions.app:app --port 9100

Endpoints
  GET  /.well-known/agent-card.json   A2A Agent Card (public)
  POST /oauth/token                   OAuth2 client credentials -> scoped JWT
  POST /a2a                           A2A JSON-RPC (SendMessage, GetTask, ...)  [Bearer]
  POST /mcp                           MCP Streamable HTTP (tools)               [Bearer]
  GET  /audit                         this client's audit entries               [Bearer, audit:read]
"""

import contextlib
import contextvars
import json
import os
import threading
import time

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

from champions import matcher
from champions.catalog import BY_ID, CARDS
from common import auth
from common.schemas import CapabilityRequest, Filters

PUBLIC_URL = os.getenv("CHAMPIONS_URL", "http://127.0.0.1:9100")
ALLOWED_HOSTS = ["127.0.0.1:*", "localhost:*", "champions", "champions:*"]

# Claims of the authenticated caller for the current request.
current_claims = contextvars.ContextVar("current_claims", default=None)

SKILL_SCOPES = {
    "describe_capabilities": "catalog:read",
    "find_data_cards": "catalog:read",
    "get_insights": "insights:read",
}

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
        try:
            request = CapabilityRequest.model_validate(parts[0])
        except ValidationError as error:
            await fail(f"Invalid capability_request: {error.errors()[0]['msg']}")
            return

        claims = current_claims.get() or {}
        try:
            auth.require_scope(claims, SKILL_SCOPES[request.skill])
        except auth.AuthError as error:
            await fail(error.message)
            return

        result = matcher.answer(request)
        audit(
            "a2a." + request.skill,
            task_id=task.id,
            consent_id=request.context.consent_id if request.context else None,
            purpose=request.context.purpose if request.context else None,
            shared_fields=sorted(request.context.shared) if request.context else [],
            cards=[m.card_id for m in result.matches],
            matching_companies=result.matching_companies,
        )
        payload = json.loads(result.model_dump_json(by_alias=True))
        await updater.add_artifact([new_data_part(payload)], name="catalog_result")
        await updater.complete()

    async def cancel(self, context, event_queue):
        return None


# ------------------------------------------------------------------ MCP tools

mcp = MCPServer(
    name="champions-catalog",
    instructions="Champions Group data catalog: data cards, VAF field definitions and "
    "aggregate insights. All tools are read-only.",
)


@mcp.tool()
def list_data_cards() -> list[dict]:
    """List Champions data cards with description, refresh, price and field count."""

    audit("mcp.list_data_cards")
    return [
        {"id": c.id, "name": c.name, "description": c.description, "refresh": c.refresh,
         "credits_per_1k_records": c.credits_per_1k_records, "vaf_field_count": len(c.vaf_fields),
         "contains_personal_data": c.contains_personal_data}
        for c in CARDS
    ]


@mcp.tool()
def get_vaf_fields(card_id: str) -> dict:
    """VAF field definitions (type, coverage %, refresh, example) for one data card."""

    card = BY_ID.get(card_id)
    if card is None:
        raise ToolError(f"Unknown card_id {card_id!r}. Known: {', '.join(BY_ID)}")
    audit("mcp.get_vaf_fields", card_id=card_id)
    return {"card_id": card.id, "name": card.name,
            "vaf_fields": [f.model_dump() for f in card.vaf_fields]}


@mcp.tool()
def get_insights(
    industries: list[str] | None = None,
    regions: list[str] | None = None,
    size_bands: list[str] | None = None,
    intent_topics: list[str] | None = None,
) -> dict:
    """Aggregate insights for a segment (needs the insights:read scope)."""

    try:
        auth.require_scope(current_claims.get() or {}, "insights:read")
    except auth.AuthError as error:
        raise ToolError(error.message) from error
    filters = Filters(industries=industries or [], regions=regions or [],
                      size_bands=size_bands or [], intent_topics=intent_topics or [])
    total, insights, _ = matcher.insights_for(filters)
    audit("mcp.get_insights", matching_companies=total)
    return {"matching_companies": total, "insights": [i.model_dump() for i in insights]}


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


def create_app():
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

    app.router.routes.extend(mcp_app.routes)

    app.add_middleware(BearerAuth)
    return app


app = create_app()
