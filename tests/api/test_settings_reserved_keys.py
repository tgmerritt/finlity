"""The generic API key routes never touch the connection store's rows
(``connections`` and ``connection_secret:<id>``), and saving a key honours
demo data protection like deleting one does."""

from __future__ import annotations

from pathlib import Path

import pytest
from cryptography.fernet import Fernet

from src.database import get_database

CID = "6f1c2b9e-3d4a-4b5c-8d7e-9f0a1b2c3d4e"
RESERVED = ["connections", "CONNECTIONS", "connection_secret:" + CID, "Connection_Secret:x"]


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.setenv("SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))


@pytest.fixture()
def rows():
    db = get_database()
    db.set_setting("connections", '{"version":1,"items":{}}')
    db.set_setting("connection_secret:" + CID, "fernet:placeholder", encrypted=True)
    yield db
    db.delete_setting("connections")
    db.delete_setting("connection_secret:" + CID)


def _unchanged(db) -> None:
    assert db.get_setting("connections").value == '{"version":1,"items":{}}'
    assert db.get_setting("connection_secret:" + CID).value == "fernet:placeholder"


@pytest.mark.parametrize("name", RESERVED)
def test_reserved_names_are_refused(client, rows, name: str):
    for response in (
        client.get(f"/api/settings/api-key/{name}"),
        client.delete(f"/api/settings/api-key/{name}"),
        client.post("/api/settings/api-key", json={"key": name, "value": "x"}),
    ):
        assert response.status_code == 400
        assert response.json() == {"detail": "This key name is reserved."}
    _unchanged(rows)


def test_saving_a_key_honours_demo_protection(client, monkeypatch: pytest.MonkeyPatch):
    import src.services.demo_mode as demo_mode

    monkeypatch.setenv("PORTFOLIO_TEST_MODE", "false")
    monkeypatch.setattr(demo_mode, "is_demo_data_protected", lambda: True)
    response = client.post("/api/settings/api-key", json={"key": "probe_api_key", "value": "x"})
    assert response.status_code == 403
    assert get_database().get_setting("probe_api_key") is None
