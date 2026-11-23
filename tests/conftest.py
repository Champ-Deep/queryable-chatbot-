import os
import sys
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

# Tests never touch the real query log.
os.environ["CHAMPIONS_QUERY_LOG"] = os.path.join(tempfile.mkdtemp(), "q.db")
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from champions.app import create_app  # noqa: E402
from common import auth  # noqa: E402

CLIENT_ID = "personal-agent-demo"
SECRET = auth.CLIENTS[CLIENT_ID]["secret"]


@pytest.fixture()
def champions(tmp_path):
    with TestClient(create_app(log_path=tmp_path / "q.db"), base_url="http://champions") as client:
        yield client


def token(client, scope=""):
    response = client.post("/oauth/token", data={
        "grant_type": "client_credentials", "client_id": CLIENT_ID,
        "client_secret": SECRET, "scope": scope})
    assert response.status_code == 200, response.text
    return response.json()["access_token"]


@pytest.fixture()
def bearer(champions):
    return {"Authorization": f"Bearer {token(champions)}"}
