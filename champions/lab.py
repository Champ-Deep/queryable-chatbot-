"""Agent Lab: the Champions operator's view of what partner agents ask.

It shows every partner's questions, so by default it only answers loopback
callers that use a local host name (the Host check stops DNS-rebinding pages).
Set CHAMPIONS_LAB_PASSWORD (required when hosted) and the Lab asks for an HTTP
Basic login instead, user CHAMPIONS_LAB_USER (default "admin"); production would
use the company's SSO. Clearing the log
also needs a custom header, so a cross-site form post cannot trigger it.
"""

import os
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import FileResponse, Response

from common.basic_auth import challenge, credentials_ok

STATIC = Path(__file__).resolve().parent / "static"

# "testclient" is the host Starlette's TestClient reports; no real socket has it.
LOCAL_HOSTS = {"127.0.0.1", "::1", "localhost", "testclient"}
# Host header names the Lab answers to ("champions" is the test client's base URL).
LOCAL_HOST_NAMES = {"127.0.0.1", "[::1]", "localhost", "champions"}


def _host_name(host_header):
    host = host_header.strip().lower()
    if host.startswith("["):
        return host.split("]")[0] + "]"
    return host.split(":")[0]


def _local_only(request: Request):
    if request.client is None or request.client.host not in LOCAL_HOSTS:
        raise HTTPException(403, "the Agent Lab is only available on this machine")
    if _host_name(request.headers.get("host", "")) not in LOCAL_HOST_NAMES:
        raise HTTPException(403, "open the Agent Lab as http://127.0.0.1:9100/lab")


DEFAULT_LAB_USER = "admin"


def _password_login(request: Request, password):
    """HTTP Basic login; the user is CHAMPIONS_LAB_USER (default ``admin``)."""
    user = os.getenv("CHAMPIONS_LAB_USER") or DEFAULT_LAB_USER
    if not credentials_ok(request.headers.get("authorization"), user, password):
        raise HTTPException(401, "log in to the Agent Lab", headers=challenge("Champions Agent Lab"))


def _lab_access(request: Request):
    password = os.getenv("CHAMPIONS_LAB_PASSWORD")
    if password:
        _password_login(request, password)
    elif os.getenv("CHAMPIONS_PUBLIC_URL"):
        # Hosted without a password: fail closed instead of trusting "local" callers.
        raise HTTPException(403, "the Agent Lab needs CHAMPIONS_LAB_PASSWORD when hosted")
    else:
        _local_only(request)


def router(log):
    lab = APIRouter(tags=["Agent Lab"], dependencies=[Depends(_lab_access)])

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
