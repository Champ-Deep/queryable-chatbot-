"""The Personal Agent's connection to the Champions Group Agent.

OAuth2 client credentials -> Agent Card discovery -> A2A SendMessage (official
a2a-sdk client) -> MCP tools/call. Every HTTP exchange is recorded for the
demo's "agent wire" panel, with secrets and tokens redacted.
"""

import json
import os
import time
import uuid

import httpx
from a2a.client import ClientConfig, create_client
from a2a.helpers import new_data_part
from a2a.types.a2a_pb2 import Message, Role, SendMessageRequest
from google.protobuf.json_format import MessageToDict

from common.http import tls_context
from common.schemas import CatalogResult, Feedback, InsightRating

CHAMPIONS_URL = os.getenv("CHAMPIONS_URL", "http://127.0.0.1:9100")
CLIENT_ID = os.getenv("PERSONAL_AGENT_CLIENT_ID", "personal-agent-demo")
CLIENT_SECRET = os.getenv("PERSONAL_AGENT_CLIENT_SECRET", "demo-secret-change-me")
SCOPES = "catalog:read insights:read audit:read"
MCP_PROTOCOL_VERSION = "2025-06-18"


class ChampionsError(Exception):
    pass


def _protocol(path):
    if path.startswith("/oauth"):
        return "OAuth2"
    if path.startswith("/.well-known"):
        return "A2A card"
    if path.startswith("/a2a"):
        return "A2A"
    if path.startswith("/mcp"):
        return "MCP"
    return "HTTP"


def _redact_headers(headers):
    shown = {}
    for key in ("authorization", "content-type", "a2a-version", "mcp-protocol-version", "accept"):
        if key in headers:
            value = headers[key]
            if key == "authorization":
                value = value[:19] + "...(redacted)"
            shown[key] = value
    return shown


def _body(content, content_type):
    if not content:
        return None
    text = content.decode("utf-8", "replace")
    if "x-www-form-urlencoded" in (content_type or ""):
        pairs = dict(item.split("=", 1) for item in text.split("&") if "=" in item)
        if "client_secret" in pairs:
            pairs["client_secret"] = "***"
        return pairs
    try:
        return json.loads(text)
    except ValueError:
        return text[:2000]


class Wire:
    """Ordered record of everything the Personal Agent did for one question."""

    def __init__(self):
        self.events = []

    def local(self, kind, title, detail=None):
        self.events.append({"t": time.time(), "direction": "local", "protocol": kind,
                            "title": title, "detail": detail})

    async def on_request(self, request):
        request.extensions["started"] = time.perf_counter()
        body = _body(request.content, request.headers.get("content-type"))
        title = f"{request.method} {request.url.path}"
        if isinstance(body, dict) and "method" in body:
            # JSON-RPC (A2A and MCP): name the method, and the tool for tools/call.
            title += f" · {body['method']}"
            if body["method"] == "tools/call":
                title += f" {body.get('params', {}).get('name', '')}"
        self.events.append({
            "t": time.time(), "direction": "out", "protocol": _protocol(request.url.path),
            "title": title,
            "headers": _redact_headers(request.headers),
            "body": body,
        })

    async def on_response(self, response):
        await response.aread()
        started = response.request.extensions.get("started")
        body = _body(response.content, response.headers.get("content-type"))
        if isinstance(body, dict) and "access_token" in body:
            body = {**body, "access_token": body["access_token"][:12] + "...(redacted)"}
        self.events.append({
            "t": time.time(), "direction": "in", "protocol": _protocol(response.request.url.path),
            "title": f"{response.status_code} {response.request.url.path}",
            "status": response.status_code,
            "ms": round((time.perf_counter() - started) * 1000, 1) if started else None,
            "body": body,
        })


class ChampionsClient:
    def __init__(self, wire, transport=None, base_url=CHAMPIONS_URL):
        self.wire = wire
        self.base_url = base_url.rstrip("/")
        self.transport = transport
        self._token = None

    def _http(self, headers=None):
        return httpx.AsyncClient(
            base_url=self.base_url, transport=self.transport, timeout=20, headers=headers or {}, verify=tls_context(),
            event_hooks={"request": [self.wire.on_request], "response": [self.wire.on_response]})

    async def _bearer(self):
        if self._token is None:
            async with self._http() as http:
                response = await http.post("/oauth/token", data={
                    "grant_type": "client_credentials", "client_id": CLIENT_ID,
                    "client_secret": CLIENT_SECRET, "scope": SCOPES})
            if response.status_code != 200:
                raise ChampionsError(f"Token request refused ({response.status_code}): {response.text}")
            self._token = response.json()["access_token"]
        return {"Authorization": f"Bearer {self._token}"}

    async def ask(self, capability_request):
        """A2A SendMessage with one DataPart; returns the CatalogResult artifact."""

        task = await self._send(json.loads(capability_request.model_dump_json(by_alias=True)))
        return CatalogResult.model_validate(task["artifacts"][0]["parts"][0]["data"])

    async def feedback(self, query_id, ratings):
        """A2A SendMessage with champions.feedback/v1: insight ids and useful yes/no, nothing else."""

        fb = Feedback(query_id=query_id, ratings=[InsightRating(insight_id=k, useful=v) for k, v in ratings.items()])
        task = await self._send(json.loads(fb.model_dump_json(by_alias=True)))
        return task["artifacts"][0]["parts"][0]["data"]

    async def _send(self, payload):
        headers = await self._bearer()
        async with self._http(headers) as http:
            client = await create_client(
                self.base_url, client_config=ClientConfig(streaming=False, httpx_client=http))
            message = Message(message_id=str(uuid.uuid4()), role=Role.ROLE_USER,
                              parts=[new_data_part(payload)])
            task = None
            async for response in client.send_message(SendMessageRequest(message=message)):
                data = MessageToDict(response)
                task = data.get("task") or task

        if not task:
            raise ChampionsError("Champions returned no task")
        state = task["status"]["state"]
        if state != "TASK_STATE_COMPLETED":
            parts = task["status"].get("message", {}).get("parts", [])
            reason = " ".join(p.get("text", "") for p in parts) or state
            raise ChampionsError(f"Champions task {state}: {reason}")
        return task

    async def mcp_tool(self, name, arguments):
        """MCP tools/call over Streamable HTTP (stateless JSON mode)."""

        headers = {**await self._bearer(), "Accept": "application/json, text/event-stream",
                   "MCP-Protocol-Version": MCP_PROTOCOL_VERSION}
        async with self._http(headers) as http:
            init = await http.post("/mcp", json={
                "jsonrpc": "2.0", "id": 1, "method": "initialize",
                "params": {"protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {},
                           "clientInfo": {"name": "personal-agent", "version": "1.0"}}})
            if init.status_code != 200:
                raise ChampionsError(f"MCP initialize failed ({init.status_code})")
            response = await http.post("/mcp", json={
                "jsonrpc": "2.0", "id": 2, "method": "tools/call",
                "params": {"name": name, "arguments": arguments}})
        result = response.json().get("result", {})
        if result.get("isError"):
            raise ChampionsError(result["content"][0]["text"])
        return json.loads(result["content"][0]["text"])

    async def audit(self):
        async with self._http(await self._bearer()) as http:
            response = await http.get("/audit")
        return response.json().get("entries", [])
