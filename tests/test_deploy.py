"""Hosted deployment (Cloudflare Containers): public URL, password-protected Lab,
and agent-to-agent traffic that stays inside the container."""

import asyncio
import base64

import httpx
from fastapi.testclient import TestClient

from champions.app import create_app
from common import auth
from personal import agent, champions_client
from personal.profile import ConsentStore

PUBLIC = "https://champions-a2a.example.workers.dev"
QUESTION = "Find mid-size healthcare companies in Europe that are switching HR platforms"
HOSTED_SECRET = "a-real-secret-set-by-the-worker"


def _hosted(monkeypatch):
    """Hosted mode with a real (non-default) client secret, as the Worker sets it."""
    monkeypatch.setenv("CHAMPIONS_PUBLIC_URL", PUBLIC)
    monkeypatch.setitem(auth.CLIENTS["personal-agent-demo"], "secret", HOSTED_SECRET)
    monkeypatch.setattr(champions_client, "CLIENT_SECRET", HOSTED_SECRET)


def _basic(user, password):
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()}


def _remote(tmp_path):
    """A caller that is not on this machine, as the Cloudflare Worker is to the container."""
    return TestClient(create_app(log_path=tmp_path / "q.db"), base_url=PUBLIC,
                      client=("10.0.0.7", 5000))


# ------------------------------------------------------------------ Lab password

def test_lab_with_password_asks_remote_callers_to_log_in(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAMPIONS_LAB_PASSWORD", "s3cret-lab")
    with _remote(tmp_path) as remote:
        response = remote.get("/lab")
        assert response.status_code == 401
        assert response.headers["www-authenticate"].startswith("Basic")
        assert remote.get("/lab/api/stats", headers=_basic("admin", "wrong")).status_code == 401
        assert remote.get("/lab/api/stats", headers=_basic("admin", "s3cret-lab")).status_code == 200
        assert remote.get("/lab", headers=_basic("admin", "s3cret-lab")).status_code == 200


def test_lab_clear_still_needs_the_custom_header_with_a_password(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAMPIONS_LAB_PASSWORD", "s3cret-lab")
    with _remote(tmp_path) as remote:
        auth = _basic("admin", "s3cret-lab")
        assert remote.post("/lab/api/clear", headers=auth).status_code == 403
        assert remote.post("/lab/api/clear", headers={**auth, "X-Requested-With": "lab"}).status_code == 200


def test_lab_without_password_stays_local_only(tmp_path, monkeypatch):
    monkeypatch.delenv("CHAMPIONS_LAB_PASSWORD", raising=False)
    with _remote(tmp_path) as remote:
        assert remote.get("/lab/api/stats", headers=_basic("admin", "anything")).status_code == 403


def test_hosted_lab_without_password_fails_closed(tmp_path, monkeypatch):
    # Even a caller that looks local (spoofed forwarding headers) gets no Lab when hosted.
    monkeypatch.setenv("CHAMPIONS_PUBLIC_URL", PUBLIC)
    monkeypatch.delenv("CHAMPIONS_LAB_PASSWORD", raising=False)
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url="http://127.0.0.1:9100") as local:
        assert local.get("/lab/api/stats").status_code == 403


# ------------------------------------------------------------------ public URL

def test_agent_card_advertises_the_public_url(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAMPIONS_PUBLIC_URL", PUBLIC + "/")
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url=PUBLIC) as client:
        card = client.get("/.well-known/agent-card.json").json()
    assert card["supportedInterfaces"][0]["url"] == PUBLIC + "/a2a"
    assert PUBLIC + "/oauth/token" in card["securitySchemes"]["bearer"]["httpAuthSecurityScheme"]["description"]


def test_mcp_accepts_the_public_host(tmp_path, monkeypatch):
    _hosted(monkeypatch)
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url=PUBLIC) as client:
        token = client.post("/oauth/token", data={
            "grant_type": "client_credentials", "client_id": "personal-agent-demo",
            "client_secret": HOSTED_SECRET, "scope": "catalog:read"}).json()["access_token"]
        response = client.post("/mcp", headers={
            "Authorization": f"Bearer {token}", "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json"},
            json={"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
    assert response.status_code == 200, response.text


# ------------------------------------------------------------------ internal traffic

class _HostRecorder(httpx.AsyncBaseTransport):
    def __init__(self, inner):
        self.inner = inner
        self.hosts = []

    async def handle_async_request(self, request):
        self.hosts.append(request.url.host)
        return await self.inner.handle_async_request(request)


def test_personal_agent_keeps_a2a_on_its_configured_endpoint(monkeypatch):
    # The card advertises the public URL, but inside the container the Personal
    # Agent must keep talking to Champions over 127.0.0.1, not via the internet.
    _hosted(monkeypatch)
    store = ConsentStore()
    store.grant("priya", "market_insights", ["industry", "role"])

    async def turn():
        app = create_app()
        recorder = _HostRecorder(httpx.ASGITransport(app=app))
        async with app.router.lifespan_context(app):
            result = await agent.run_turn("priya", QUESTION, store, transport=recorder)
        return result, recorder.hosts

    result, hosts = asyncio.run(turn())
    assert result["status"] == "ok", result
    assert set(hosts) == {"127.0.0.1"}, hosts


# ------------------------------------------------------------------ client secret

def test_hosted_champions_refuses_the_public_demo_secret(tmp_path, monkeypatch):
    # The default secret is in the public repo, so a hosted deployment must not accept it.
    monkeypatch.setenv("CHAMPIONS_PUBLIC_URL", PUBLIC)
    monkeypatch.setitem(auth.CLIENTS["personal-agent-demo"], "secret", auth.DEMO_CLIENT_SECRET)
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url=PUBLIC) as client:
        response = client.post("/oauth/token", data={
            "grant_type": "client_credentials", "client_id": "personal-agent-demo",
            "client_secret": auth.DEMO_CLIENT_SECRET})
    assert response.status_code == 401


def test_local_demo_still_accepts_the_demo_secret(tmp_path, monkeypatch):
    monkeypatch.delenv("CHAMPIONS_PUBLIC_URL", raising=False)
    monkeypatch.setitem(auth.CLIENTS["personal-agent-demo"], "secret", auth.DEMO_CLIENT_SECRET)
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url="http://champions") as client:
        response = client.post("/oauth/token", data={
            "grant_type": "client_credentials", "client_id": "personal-agent-demo",
            "client_secret": auth.DEMO_CLIENT_SECRET})
    assert response.status_code == 200
