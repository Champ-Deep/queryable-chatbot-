"""Personal Agent web app: the demo page plus its JSON API.

    uvicorn personal.app:app --port 9200      ->  http://127.0.0.1:9200
"""

import asyncio
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.middleware.base import BaseHTTPMiddleware

from common.basic_auth import challenge, credentials_ok

from personal import agent, simulator
from common.http import tls_context
from personal.champions_client import CHAMPIONS_URL, ChampionsClient, ChampionsError, Wire
from personal.profile import FIELDS, PERSONAS, PURPOSES, ConsentStore, get_profile
from personal.scenarios import SCENARIOS

STATIC = Path(__file__).resolve().parent / "static"

REPORTS = Path(__file__).resolve().parent.parent / "reports"

DEFAULT_DEMO_USER = "admin"
# Left open even with a login: start.ps1 polls it to know the server is up.
OPEN_PATHS = {"/api/health"}


class DemoLogin(BaseHTTPMiddleware):
    """When PERSONAL_DEMO_PASSWORD is set, the whole demo needs an HTTP Basic login
    (user PERSONAL_DEMO_USER, default ``admin``). Unset = open, as before."""

    async def dispatch(self, request, call_next):
        password = os.getenv("PERSONAL_DEMO_PASSWORD")
        if password and request.url.path not in OPEN_PATHS:
            user = os.getenv("PERSONAL_DEMO_USER") or DEFAULT_DEMO_USER
            if not credentials_ok(request.headers.get("authorization"), user, password):
                return JSONResponse({"detail": "log in to the Personal Agent demo"}, status_code=401,
                                    headers=challenge("Personal Agent demo"))
        return await call_next(request)


app = FastAPI(title="Personal Agent")
# Added first so CORS wraps it: a 401 still carries CORS headers the Lab page can read.
app.add_middleware(DemoLogin)
# The Champions Agent Lab (:9100/lab) may start a simulation run here, sending the demo login.
app.add_middleware(CORSMiddleware, allow_origins=["http://127.0.0.1:9100", "http://localhost:9100"],
                   allow_methods=["GET", "POST"], allow_headers=["Content-Type"], allow_credentials=True)
consents = ConsentStore()
_simulating = asyncio.Lock()


class ChatIn(BaseModel):
    persona: str
    message: str


class ConsentIn(BaseModel):
    persona: str
    purpose: str
    fields: list[str]


def _persona(name):
    if name not in PERSONAS:
        raise HTTPException(404, f"unknown persona {name}")
    return name


@app.get("/")
def index():
    return FileResponse(STATIC / "index.html")


@app.get("/api/personas")
def personas():
    return [{"id": key, "display": value["display"], "role": value["role"]} for key, value in PERSONAS.items()]


@app.get("/api/scenarios")
def scenarios():
    return SCENARIOS


@app.post("/api/simulate")
async def simulate():
    """Run every persona's questions through the real A2A path; returns the report."""

    if _simulating.locked():
        raise HTTPException(409, "a simulation is already running")
    async with _simulating:
        try:
            report = await simulator.run()
        except (ChampionsError, OSError) as error:
            raise HTTPException(502, f"Champions unavailable: {error}") from error
    REPORTS.mkdir(exist_ok=True)
    (REPORTS / "simulation.md").write_text(simulator.markdown(report), encoding="utf-8")
    return report


@app.get("/api/profile/{persona}")
def profile(persona: str):
    data = get_profile(_persona(persona))
    return {
        "profile": data,
        "fields": [{"name": n, "label": label, "class": cls} for n, (cls, label) in FIELDS.items()],
        "consents": consents.all_for(persona),
        "purposes": PURPOSES,
    }


@app.post("/api/consent")
def grant(body: ConsentIn):
    try:
        return consents.grant(_persona(body.persona), body.purpose, body.fields)
    except ValueError as error:
        raise HTTPException(400, str(error)) from error


@app.delete("/api/consent/{persona}/{purpose}")
def revoke(persona: str, purpose: str):
    return {"revoked": consents.revoke(_persona(persona), purpose)}


@app.post("/api/chat")
async def chat(body: ChatIn):
    if not body.message.strip():
        raise HTTPException(400, "empty message")
    return await agent.run_turn(_persona(body.persona), body.message[:1000], consents)


@app.get("/api/champions/audit")
async def champions_audit():
    """What Champions recorded about this client (its own audit view)."""

    try:
        return {"entries": await ChampionsClient(Wire()).audit()}
    except (ChampionsError, OSError) as error:
        raise HTTPException(502, f"Champions unavailable: {error}") from error


@app.get("/api/health")
async def health():
    import httpx

    try:
        async with httpx.AsyncClient(timeout=3, verify=tls_context()) as http:
            champions = (await http.get(f"{CHAMPIONS_URL}/health")).json()
    except httpx.HTTPError:
        champions = {"status": "unavailable"}
    return {"status": "ok", "agent": "personal", "champions": champions}
