"""Agent Lab: the Champions operator's view of what partner agents ask.

It shows every partner's questions, so it only answers loopback callers
(production: put it behind the company's SSO instead). Clearing the log also
needs a custom header, so a cross-site form post cannot trigger it.
"""

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response

STATIC = Path(__file__).resolve().parent / "static"

# "testclient" is the host Starlette's TestClient reports; no real socket has it.
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}


def _local_only(request: Request):
    if request.client is None or request.client.host not in LOCAL_HOSTS:
        raise HTTPException(403, "the Agent Lab is only available on this machine")


def router(log):
    lab = APIRouter(tags=["Agent Lab"], dependencies=[Depends(_local_only)])

    @lab.get("/lab", include_in_schema=False)
    def page():
        return FileResponse(STATIC / "lab.html")

    @lab.get("/lab/api/stats")
    def stats():
        return log.stats()

    @lab.get("/lab/api/recent")
    def recent(limit: int = 50):
        return {"queries": log.recent(min(max(limit, 1), 500))}

    @lab.get("/lab/api/export.{fmt}")
    def export(fmt: str):
        if fmt not in ("csv", "jsonl"):
            raise HTTPException(404, "use export.csv or export.jsonl")
        media = "text/csv" if fmt == "csv" else "application/x-ndjson"
        return Response(log.export(fmt), media_type=media,
                        headers={"Content-Disposition": f'attachment; filename="champions_queries.{fmt}"'})

    @lab.post("/lab/api/clear")
    def clear(request: Request):
        if request.headers.get("x-requested-with") != "lab":
            raise HTTPException(403, "missing X-Requested-With: lab")
        log.clear()
        return {"cleared": True}

    return lab
