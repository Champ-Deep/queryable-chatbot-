"""Personal Agent web app: the demo page plus its JSON API.

    uvicorn personal.app:app --port 9200      ->  http://127.0.0.1:9200
"""

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from personal import agent
from personal.champions_client import CHAMPIONS_URL, ChampionsClient, ChampionsError, Wire
from personal.profile import FIELDS, PERSONAS, PURPOSES, ConsentStore, get_profile

STATIC = Path(__file__).resolve().parent / "static"

app = FastAPI(title="Personal Agent")
consents = ConsentStore()


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
    return [{"id": key, "display": value["display"]} for key, value in PERSONAS.items()]


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
        async with httpx.AsyncClient(timeout=3) as http:
            champions = (await http.get(f"{CHAMPIONS_URL}/health")).json()
    except httpx.HTTPError:
        champions = {"status": "unavailable"}
    return {"status": "ok", "agent": "personal", "champions": champions}
