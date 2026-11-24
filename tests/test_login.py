"""Username + password logins for the local demo page (:9200) and the Agent Lab (:9100/lab)."""

import base64

from fastapi.testclient import TestClient

from champions.app import create_app
from personal.app import app as personal_app


def _basic(user, password):
    return {"Authorization": "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()}


# ------------------------------------------------------------------ Agent Lab

def test_lab_username_is_configurable(tmp_path, monkeypatch):
    monkeypatch.setenv("CHAMPIONS_LAB_USER", "lab-operator")
    monkeypatch.setenv("CHAMPIONS_LAB_PASSWORD", "lab-pw")
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url="http://127.0.0.1:9100") as lab:
        assert lab.get("/lab").status_code == 401
        assert lab.get("/lab", headers=_basic("admin", "lab-pw")).status_code == 401
        assert lab.get("/lab", headers=_basic("lab-operator", "lab-pw")).status_code == 200


def test_lab_username_defaults_to_admin(tmp_path, monkeypatch):
    monkeypatch.delenv("CHAMPIONS_LAB_USER", raising=False)
    monkeypatch.setenv("CHAMPIONS_LAB_PASSWORD", "lab-pw")
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url="http://127.0.0.1:9100") as lab:
        assert lab.get("/lab/api/stats", headers=_basic("admin", "lab-pw")).status_code == 200


# ------------------------------------------------------------------ demo page

def _demo():
    return TestClient(personal_app, base_url="http://127.0.0.1:9200")


def test_demo_is_open_without_a_password(monkeypatch):
    monkeypatch.delenv("PERSONAL_DEMO_PASSWORD", raising=False)
    assert _demo().get("/").status_code == 200


def test_demo_with_a_password_asks_for_a_login(monkeypatch):
    monkeypatch.setenv("PERSONAL_DEMO_USER", "demo-user")
    monkeypatch.setenv("PERSONAL_DEMO_PASSWORD", "demo-pw")
    demo = _demo()
    response = demo.get("/")
    assert response.status_code == 401
    assert response.headers["www-authenticate"].startswith("Basic")
    assert demo.get("/api/personas").status_code == 401
    assert demo.get("/", headers=_basic("demo-user", "wrong")).status_code == 401
    assert demo.get("/", headers=_basic("demo-user", "demo-pw")).status_code == 200
    assert demo.get("/api/personas", headers=_basic("demo-user", "demo-pw")).status_code == 200


def test_demo_health_check_stays_open_for_the_launcher(monkeypatch):
    monkeypatch.setenv("PERSONAL_DEMO_PASSWORD", "demo-pw")
    assert _demo().get("/api/health").status_code == 200


def test_lab_can_still_start_a_simulation_with_the_demo_login(monkeypatch):
    # The Lab page calls :9200/api/simulate cross-origin; the browser sends the demo login
    # only when the CORS response allows credentials.
    monkeypatch.setenv("PERSONAL_DEMO_PASSWORD", "demo-pw")
    response = _demo().options("/api/simulate", headers={
        "Origin": "http://127.0.0.1:9100", "Access-Control-Request-Method": "POST"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-credentials"] == "true"
    denied = _demo().post("/api/simulate", headers={"Origin": "http://127.0.0.1:9100"})
    assert denied.status_code == 401
    assert denied.headers["access-control-allow-origin"] == "http://127.0.0.1:9100"
