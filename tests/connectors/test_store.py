"""Server connection store and secrets (plan B1, design 7.1 and 7.2).

Every test runs on a temp database with a fixed ``SECRET_KEY`` and a fake home
directory, so nothing reads or writes the real key and salt files.
"""

from __future__ import annotations

import ast
import json
import logging
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import pytest
from cryptography.fernet import Fernet

from src.connectors import store
from src.connectors.errors import ConnectorError
from src.connectors.types import AkahuCredentials, DemoCredentials, SimpleFinCredentials
from src.database import Database
from src.database.models import AppSettings
from src.services.secrets import SecretsManager, SecretUnreadable

ROOT = Path(__file__).resolve().parents[2]
NOW = datetime(2026, 10, 6, 12, 0, 0, tzinfo=timezone.utc)
CID = "6f1c2b9e-3d4a-4b5c-8d7e-9f0a1b2c3d4e"
CID2 = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d"
KEY_A = "acct:" + "a" * 64
PLANTED_PASSWORD = "planted-sfin-password-91c4"
PLANTED_USER = "planted-sfin-user-7e21"
PLANTED_USER_TOKEN = "user_token_planted_5d0b"
PLANTED_APP_TOKEN = "app_token_planted_88aa"
SIMPLEFIN = SimpleFinCredentials(
    base_url="https://beta-bridge.simplefin.org/simplefin",
    username=PLANTED_USER,
    password=PLANTED_PASSWORD,
)
AKAHU = AkahuCredentials(user_token=PLANTED_USER_TOKEN, app_token=PLANTED_APP_TOKEN)
SHARED_VARS = ("DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA", "CONNECTORS_ENABLED")


@pytest.fixture()
def home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    fake = tmp_path / "home"
    fake.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake))
    return fake


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch, home: Path) -> pytest.MonkeyPatch:
    for name in SHARED_VARS:
        monkeypatch.delenv(name, raising=False)
    # A 44-character Fernet key is used as is: no key file, no salt file.
    monkeypatch.setenv("SECRET_KEY", Fernet.generate_key().decode())
    return monkeypatch


@pytest.fixture()
def db(tmp_path: Path) -> Any:
    database = Database(str(tmp_path / "store.db"))
    yield database
    database.engine.dispose()


def _account(**overrides: Any) -> dict[str, Any]:
    entry = {
        "name": "Visa",
        "institution": "Bank",
        "currency": "USD",
        "kind": "credit_card",
        "role": "debt",
        "label": "Visa",
        "account_key": KEY_A,
        "liability_id": None,
        "flip_balance": False,
        "same_as_key": None,
    }
    entry.update(overrides)
    return entry


def _connection(**overrides: Any) -> dict[str, Any]:
    entry = {
        "provider": "simplefin",
        "label": "My SimpleFIN",
        "created_at": "2026-10-01T09:00:00Z",
        "status": "ok",
        "status_at": "2026-10-01T09:00:00Z",
        "last_synced_at": None,
        "first_sync_days": 90,
        "requests": [],
        "accounts": {"ACT-1": _account()},
    }
    entry.update(overrides)
    return entry


def _doc(items: dict[str, Any]) -> dict[str, Any]:
    return {"version": 1, "items": items}


def _uuid(n: int) -> str:
    return f"00000000-0000-4000-8000-{n:012d}"


def _row(db: Any, key: str) -> Any:
    return db.get_setting(key)


# --- sanitize ------------------------------------------------------------------


def test_sanitize_keeps_a_valid_document_unchanged():
    doc = _doc({CID: _connection()})
    assert store.sanitize(doc, now=NOW) == doc


@pytest.mark.parametrize("raw", [None, [], "x", 3, {"items": []}, {"version": 1}])
def test_sanitize_non_documents_give_empty(raw: Any):
    assert store.sanitize(raw, now=NOW) == {"version": 1, "items": {}}


def test_sanitize_drops_unknown_keys_at_every_level():
    conn = _connection(secret="x", access_url="https://u:p@h/simplefin")
    conn["accounts"]["ACT-1"]["balance"] = 12.5
    doc = {"version": 1, "items": {CID: conn}, "connection_secret": "x"}
    clean = store.sanitize(doc, now=NOW)
    assert set(clean) == {"version", "items"}
    assert "secret" not in clean["items"][CID]
    assert "access_url" not in clean["items"][CID]
    assert "balance" not in clean["items"][CID]["accounts"]["ACT-1"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"status": "broken"},
        {"status": None},
        {"provider": "plaid"},
        {"label": "x" * 121},
        {"label": ""},
        {"label": "bad\nlabel"},
        {"created_at": "yesterday"},
        {"created_at": "2026-10-01T09:00:00"},  # no offset
    ],
)
def test_sanitize_drops_an_invalid_connection(overrides: dict[str, Any]):
    doc = _doc({CID: _connection(**overrides), CID2: _connection()})
    assert list(store.sanitize(doc, now=NOW)["items"]) == [CID2]


def test_sanitize_accepts_a_120_character_label():
    doc = _doc({CID: _connection(label="x" * 120)})
    assert store.sanitize(doc, now=NOW)["items"][CID]["label"] == "x" * 120


@pytest.mark.parametrize("bad_id", ["not-a-uuid", CID.upper(), "connections", "../x", ""])
def test_sanitize_drops_non_uuid_connection_ids(bad_id: str):
    assert store.sanitize(_doc({bad_id: _connection()}), now=NOW)["items"] == {}


def test_sanitize_keeps_ten_connections_and_drops_the_eleventh():
    items = {_uuid(i): _connection(label=f"c{i}") for i in range(11)}
    clean = store.sanitize(_doc(items), now=NOW)["items"]
    assert list(clean) == [_uuid(i) for i in range(10)]


def test_sanitize_keeps_fifty_accounts_and_drops_the_fifty_first():
    accounts = {f"ACT-{i}": _account(label=f"a{i}") for i in range(51)}
    clean = store.sanitize(_doc({CID: _connection(accounts=accounts)}), now=NOW)
    assert list(clean["items"][CID]["accounts"]) == [f"ACT-{i}" for i in range(50)]


@pytest.mark.parametrize(
    "overrides",
    [
        {"role": "spend"},
        {"kind": "brokerage"},
        {"label": "x" * 121},
        {"label": ""},
        {"currency": "usd"},
        {"account_key": "acct:short"},
        {"account_key": "label:Visa"},
        {"liability_id": "not-a-uuid"},
        {"same_as_key": "bad"},
        {"name": None},
        {"institution": 7},
    ],
)
def test_sanitize_drops_an_invalid_account(overrides: dict[str, Any]):
    accounts = {"BAD": _account(**overrides), "GOOD": _account()}
    clean = store.sanitize(_doc({CID: _connection(accounts=accounts)}), now=NOW)
    assert list(clean["items"][CID]["accounts"]) == ["GOOD"]


def test_sanitize_account_optional_fields():
    accounts = {
        "A": _account(flip_balance="yes", same_as_key="label:Visa card", liability_id=CID2),
        "B": _account(institution=None),
    }
    clean = store.sanitize(_doc({CID: _connection(accounts=accounts)}), now=NOW)
    a = clean["items"][CID]["accounts"]["A"]
    assert a["flip_balance"] is False
    assert a["same_as_key"] == "label:Visa card"
    assert a["liability_id"] == CID2
    assert clean["items"][CID]["accounts"]["B"]["institution"] is None


def test_sanitize_connection_defaults():
    conn = _connection(status_at="soon", last_synced_at="nope", first_sync_days=45)
    clean = store.sanitize(_doc({CID: conn}), now=NOW)["items"][CID]
    assert clean["status_at"] == conn["created_at"]
    assert clean["last_synced_at"] is None
    assert clean["first_sync_days"] == 90
    conn = _connection(first_sync_days=True)
    assert store.sanitize(_doc({CID: conn}), now=NOW)["items"][CID]["first_sync_days"] == 90
    conn = _connection(first_sync_days=30)
    assert store.sanitize(_doc({CID: conn}), now=NOW)["items"][CID]["first_sync_days"] == 30


def _iso(when: datetime) -> str:
    return when.strftime("%Y-%m-%dT%H:%M:%SZ")


def test_sanitize_trims_requests_to_24_hours():
    old = _iso(NOW - timedelta(hours=24))  # exactly 24 hours: out
    recent = _iso(NOW - timedelta(hours=23, minutes=59))
    future = _iso(NOW + timedelta(minutes=1))
    requests = [recent, old, future, "garbage", "2026-10-06T11:00:00", 5, _iso(NOW)]
    clean = store.sanitize(_doc({CID: _connection(requests=requests)}), now=NOW)
    assert clean["items"][CID]["requests"] == [recent, _iso(NOW)]


def test_sanitize_keeps_the_newest_64_requests_oldest_first():
    stamps = [_iso(NOW - timedelta(minutes=i)) for i in range(70)]
    clean = store.sanitize(_doc({CID: _connection(requests=stamps)}), now=NOW)
    kept = clean["items"][CID]["requests"]
    assert len(kept) == 64
    assert kept == sorted(stamps[:64])


def test_now_iso_format():
    assert store.now_iso(lambda: NOW) == "2026-10-06T12:00:00Z"
    assert store.sanitize(
        _doc({CID: _connection(requests=[store.now_iso(lambda: NOW)])}), now=NOW
    )["items"][CID]["requests"] == ["2026-10-06T12:00:00Z"]


# --- connections row -------------------------------------------------------------


def test_read_without_a_row_is_empty_and_writes_nothing(db: Any):
    assert store.read_connections(db, now=NOW) == {"version": 1, "items": {}}
    assert _row(db, store.CONNECTIONS_KEY) is None


def test_read_a_corrupt_row_gives_empty(db: Any):
    db.set_setting(store.CONNECTIONS_KEY, "{not json")
    assert store.read_connections(db, now=NOW)["items"] == {}


def test_write_sanitizes_and_round_trips(db: Any):
    doc = _doc({CID: _connection(extra="dropped"), "bad": _connection()})
    stored = store.write_connections(db, doc, now=NOW)
    assert list(stored["items"]) == [CID]
    assert "extra" not in stored["items"][CID]
    row = _row(db, store.CONNECTIONS_KEY)
    assert row.encrypted is False
    assert json.loads(row.value) == stored
    assert store.read_connections(db, now=NOW) == stored


def test_connection_and_secret_commit_or_roll_back_together(db: Any):
    doc = _doc({CID: _connection(status="accounts_pending")})
    with db.get_session() as session:
        store.write_connections(db, doc, session=session, now=NOW)
        store.save_secret(db, CID, SIMPLEFIN, session=session)
        session.rollback()
    assert _row(db, store.CONNECTIONS_KEY) is None
    assert _row(db, store.secret_key(CID)) is None

    with db.get_session() as session:
        store.write_connections(db, doc, session=session, now=NOW)
        store.save_secret(db, CID, SIMPLEFIN, session=session)
        session.commit()
    assert store.read_connections(db, now=NOW)["items"][CID]["status"] == "accounts_pending"
    assert store.load_secret(db, CID) == SIMPLEFIN


def test_a_failed_write_inside_the_store_commits_nothing(db: Any, monkeypatch: pytest.MonkeyPatch):
    def boom(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("disk full")

    with monkeypatch.context() as patch:
        patch.setattr(store, "_upsert", boom)
        with pytest.raises(RuntimeError):
            store.write_connections(db, _doc({CID: _connection()}), now=NOW)
    assert _row(db, store.CONNECTIONS_KEY) is None


# --- secrets ---------------------------------------------------------------------


@pytest.mark.parametrize("creds", [SIMPLEFIN, AKAHU, DemoCredentials()])
def test_secret_round_trip_is_fernet_encrypted(db: Any, creds: Any):
    store.save_secret(db, CID, creds)
    row = _row(db, store.secret_key(CID))
    assert row.key == "connection_secret:" + CID
    assert row.encrypted is True
    assert row.value.startswith("fernet:")
    for planted in (PLANTED_PASSWORD, PLANTED_USER, PLANTED_USER_TOKEN, PLANTED_APP_TOKEN):
        assert planted not in row.value
    assert store.load_secret(db, CID) == creds


def test_save_replaces_the_secret(db: Any):
    store.save_secret(db, CID, SIMPLEFIN)
    store.save_secret(db, CID, AKAHU)
    assert store.load_secret(db, CID) == AKAHU


def test_secret_manager_db_only_methods(db: Any):
    manager = SecretsManager(db)
    assert manager.get_stored_secret("connection_secret:" + CID) is None
    manager.set_stored_secret("connection_secret:" + CID, "value-1")
    row = _row(db, "connection_secret:" + CID)
    assert row.encrypted is True and row.value.startswith("fernet:")
    assert manager.get_stored_secret("connection_secret:" + CID) == "value-1"
    assert manager.delete_stored_secret("connection_secret:" + CID) is True
    assert manager.delete_stored_secret("connection_secret:" + CID) is False
    assert manager.get_stored_secret("connection_secret:" + CID) is None


@pytest.mark.parametrize("name", ["connection_secret:x", "probe_secret"])
def test_get_stored_secret_ignores_environment_and_config_yaml(
    db: Any, tmp_path: Path, env: pytest.MonkeyPatch, name: str
):
    reserved = name.startswith("connection_secret:")
    env.setenv(name.upper(), "from-env")
    work = tmp_path / "cwd"
    work.mkdir()
    (work / "config.yaml").write_text(f"api_keys:\n  '{name}': from-config\n")
    env.chdir(work)
    manager = SecretsManager(db)
    # The general lookup finds the environment value for an ordinary name and
    # nothing for a reserved one; the DB-only lookup never does.
    assert manager.get_api_key(name) == (None if reserved else "from-env")
    assert manager.get_stored_secret(name) is None
    env.delenv(name.upper())
    assert SecretsManager(db).get_api_key(name) == (None if reserved else "from-config")
    assert manager.get_stored_secret(name) is None


def test_wrong_secret_key_is_unreadable(db: Any, env: pytest.MonkeyPatch):
    store.save_secret(db, CID, SIMPLEFIN)
    env.setenv("SECRET_KEY", Fernet.generate_key().decode())
    with pytest.raises(SecretUnreadable):
        SecretsManager(db).get_stored_secret(store.secret_key(CID))
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)


def test_missing_key_file_is_unreadable(db: Any, env: pytest.MonkeyPatch, home: Path):
    env.delenv("SECRET_KEY")
    store.save_secret(db, CID, AKAHU)
    key_file = home / ".investment_dashboard_key"
    assert key_file.exists()  # created in the fake home, never the real one
    assert store.load_secret(db, CID) == AKAHU
    key_file.unlink()
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)


def test_corrupt_key_file_is_unreadable(db: Any, env: pytest.MonkeyPatch, home: Path):
    env.delenv("SECRET_KEY")
    store.save_secret(db, CID, AKAHU)
    (home / ".investment_dashboard_key").write_bytes(b"not a fernet key")
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)


@pytest.mark.parametrize(
    ("value", "encrypted"),
    [
        ("wc1:AAAAAAAAAAAAAAAA:BBBBBBBB", True),  # a browser-sealed value
        ("fernet:not-a-token", True),
        (json.dumps({"provider": "akahu", "user_token": "u", "app_token": "a"}), False),
        ("eyJwcm92aWRlciI6ICJkZW1vIn0=", True),  # legacy base64, no fernet prefix
        ("", True),
    ],
)
def test_non_fernet_values_are_unreadable(db: Any, value: str, encrypted: bool):
    db.set_setting(store.secret_key(CID), value, encrypted=encrypted)
    with pytest.raises(SecretUnreadable):
        SecretsManager(db).get_stored_secret(store.secret_key(CID))
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)


def test_a_missing_secret_row_is_unreadable(db: Any):
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)


@pytest.mark.parametrize(
    "plaintext",
    [
        "{not json " + PLANTED_PASSWORD,
        json.dumps({"provider": "plaid", "token": PLANTED_PASSWORD}),
        json.dumps({"provider": "simplefin", "base_url": "https://x", "username": "u"}),
        json.dumps({"provider": "akahu", "user_token": "", "app_token": "a"}),
        json.dumps(["simplefin"]),
    ],
)
def test_unknown_plaintext_is_unreadable_and_carries_nothing(db: Any, plaintext: str):
    manager = SecretsManager(db)
    db.set_setting(store.secret_key(CID), manager.encrypt_for_storage(plaintext), encrypted=True)
    with pytest.raises(SecretUnreadable) as info:
        store.load_secret(db, CID)
    err = info.value
    assert err.__context__ is None and err.__cause__ is None
    assert PLANTED_PASSWORD not in str(err) and PLANTED_PASSWORD not in repr(err)
    assert str(err) == "stored secret could not be read"


def test_delete_secret(db: Any):
    store.save_secret(db, CID, SIMPLEFIN)
    assert store.delete_secret(db, CID) is True
    assert store.delete_secret(db, CID) is False
    assert _row(db, store.secret_key(CID)) is None


@pytest.mark.parametrize("bad", ["connections", "../x", CID.upper(), "", "x" * 36])
def test_secret_key_accepts_only_uuids(db: Any, bad: str):
    with pytest.raises(ConnectorError) as info:
        store.secret_key(bad)
    assert info.value.error_type == "connection_not_found"
    with pytest.raises(ConnectorError):
        store.load_secret(db, bad)
    with pytest.raises(ConnectorError):
        store.delete_secret(db, bad)
    with pytest.raises(ConnectorError):
        store.save_secret(db, bad, SIMPLEFIN)


def test_save_secret_refuses_unknown_credential_types(db: Any):
    class Other(SimpleFinCredentials.__mro__[1]):  # plain Credentials subclass
        pass

    with pytest.raises(ConnectorError):
        store.save_secret(db, CID, Other())
    assert _row(db, store.secret_key(CID)) is None


# --- shared deployments ----------------------------------------------------------


@pytest.mark.parametrize(
    ("name", "value"),
    [("DYNO", "web.1"), ("MULTI_USER_MODE", "true"), ("PROTECT_DEMO_DATA", "true")],
)
def test_shared_deployments_refuse_to_store(
    db: Any, env: pytest.MonkeyPatch, name: str, value: str
):
    store.save_secret(db, CID, SIMPLEFIN)  # stored while single-user
    env.setenv(name, value)
    env.setenv("CONNECTORS_ENABLED", "true")  # the opt-in does not unlock storage
    for call in (
        lambda: store.save_secret(db, CID2, SIMPLEFIN),
        lambda: store.write_connections(db, _doc({CID: _connection()}), now=NOW),
        lambda: store.load_secret(db, CID),
    ):
        with pytest.raises(ConnectorError) as info:
            call()
        assert info.value.error_type == "connections_unavailable"
        assert info.value.status == 403
        assert info.value.detail == "Connected accounts are not available on this deployment."
    assert _row(db, store.secret_key(CID2)) is None
    assert _row(db, store.CONNECTIONS_KEY) is None
    # Cleanup stays possible.
    assert store.delete_secret(db, CID) is True


# --- logging and exports ---------------------------------------------------------


def test_nothing_logs_credentials(db: Any, env: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture):
    caplog.set_level(logging.DEBUG)
    for name in ("httpx", "httpcore", "src"):
        caplog.set_level(logging.DEBUG, logger=name)
    store.save_secret(db, CID, SIMPLEFIN)
    store.load_secret(db, CID)
    store.save_secret(db, CID2, AKAHU)
    env.setenv("SECRET_KEY", Fernet.generate_key().decode())
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID2)
    store.delete_secret(db, CID)
    text = caplog.text + " ".join(repr(r.__dict__) for r in caplog.records)
    for planted in (PLANTED_PASSWORD, PLANTED_USER, PLANTED_USER_TOKEN, PLANTED_APP_TOKEN):
        assert planted not in text
    events = {r.getMessage() for r in caplog.records if r.name == "src.connectors.store"}
    assert {"connection_secret_saved", "connection_secret_unreadable"} <= events


def test_json_export_carries_no_connection_rows(db: Any, tmp_path: Path):
    store.write_connections(db, _doc({CID: _connection()}), now=NOW)
    store.save_secret(db, CID, SIMPLEFIN)
    out = tmp_path / "export.json"
    data = db.export_database(str(out))
    text = out.read_text()
    assert data["settings"] == []
    assert "connection" not in text
    assert PLANTED_PASSWORD not in text


def test_store_is_not_reachable_from_the_stateless_core():
    """Only the server data layer (store.py and the B2 service.py, which
    reaches the database only through store) may import store.py or
    service.py; the stateless core and the v2 routes import neither."""
    data_layer = {"store.py", "service.py"}
    paths = [
        p for p in (ROOT / "src" / "connectors").rglob("*.py") if p.name not in data_layer
    ]
    paths.append(ROOT / "src" / "api" / "v2" / "connectors.py")
    for path in paths:
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.ImportFrom):
                mod = node.module or ""
                names = {a.name for a in node.names}
                for banned in ("store", "service"):
                    assert not mod.endswith(banned), path.name
                    assert banned not in names, path.name
            if isinstance(node, ast.Import):
                assert not any(
                    a.name.endswith((".store", ".service")) for a in node.names
                ), path.name


# --- crafted rows ----------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides",
    [{"status": {}}, {"status": []}, {"provider": {}}, {"provider": ["demo"]}],
)
def test_sanitize_drops_unhashable_connection_fields(overrides: dict[str, Any]):
    doc = _doc({CID: _connection(**overrides), CID2: _connection()})
    assert list(store.sanitize(doc, now=NOW)["items"]) == [CID2]


@pytest.mark.parametrize(
    "overrides",
    [{"role": []}, {"role": {}}, {"kind": {}}, {"kind": ["loan"]}, {"currency": []}],
)
def test_sanitize_drops_unhashable_account_fields(overrides: dict[str, Any]):
    accounts = {"BAD": _account(**overrides), "GOOD": _account()}
    clean = store.sanitize(_doc({CID: _connection(accounts=accounts)}), now=NOW)
    assert list(clean["items"][CID]["accounts"]) == ["GOOD"]


def test_sanitize_requires_an_int_first_sync_days():
    for bad in (30.0, "30", [30], {}):
        conn = _connection(first_sync_days=bad)
        assert store.sanitize(_doc({CID: conn}), now=NOW)["items"][CID]["first_sync_days"] == 90


def test_crafted_rows_keep_reads_working(db: Any):
    good = _connection()
    crafted = {
        "version": 1,
        "items": {
            CID: good,
            CID2: _connection(status={}, accounts={"X": _account(role=[])}),
            _uuid(1): _connection(accounts={"X": _account(role=[])}),
        },
    }
    db.set_setting(store.CONNECTIONS_KEY, json.dumps(crafted))
    items = store.read_connections(db, now=NOW)["items"]
    assert list(items) == [CID, _uuid(1)]
    assert items[_uuid(1)]["accounts"] == {}

    deep = '{"items": {"' + CID + '": ' + "[" * 100_000 + "]" * 100_000 + "}}"
    db.set_setting(store.CONNECTIONS_KEY, deep)
    assert store.read_connections(db, now=NOW)["items"] == {}


def test_deeply_nested_secret_plaintext_is_unreadable(db: Any):
    manager = SecretsManager(db)
    nested = "[" * 100_000 + "]" * 100_000
    db.set_setting(store.secret_key(CID), manager.encrypt_for_storage(nested), encrypted=True)
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)


# --- binding and credential checks -----------------------------------------------


def test_a_secret_moved_to_another_connection_is_unreadable(db: Any):
    store.save_secret(db, CID, SIMPLEFIN)
    store.save_secret(db, CID2, AKAHU)
    first = _row(db, store.secret_key(CID)).value
    second = _row(db, store.secret_key(CID2)).value
    db.set_setting(store.secret_key(CID), second, encrypted=True)
    db.set_setting(store.secret_key(CID2), first, encrypted=True)
    for cid in (CID, CID2):
        with pytest.raises(SecretUnreadable):
            store.load_secret(db, cid)


def test_plaintext_names_its_connection(db: Any):
    store.save_secret(db, CID, DemoCredentials())
    plain = SecretsManager(db).get_stored_secret(store.secret_key(CID))
    assert json.loads(plain) == {"id": CID, "provider": "demo"}


def test_simplefin_host_is_checked_again_on_load(db: Any):
    manager = SecretsManager(db)
    for base_url in (
        "https://evil.example/simplefin",
        "http://beta-bridge.simplefin.org/simplefin",
        "https://beta-bridge.simplefin.org/other",
        "https://x:y@beta-bridge.simplefin.org/simplefin",
    ):
        plain = json.dumps(
            {"id": CID, "provider": "simplefin", "base_url": base_url, "username": "u", "password": "p"}
        )
        db.set_setting(store.secret_key(CID), manager.encrypt_for_storage(plain), encrypted=True)
        with pytest.raises(SecretUnreadable):
            store.load_secret(db, CID)


def test_credential_fields_are_capped(db: Any):
    manager = SecretsManager(db)
    at_cap = "a" * store.MAX_CREDENTIAL_CHARS
    for token, readable in ((at_cap, True), (at_cap + "a", False)):
        plain = json.dumps({"id": CID, "provider": "akahu", "user_token": token, "app_token": "t"})
        db.set_setting(store.secret_key(CID), manager.encrypt_for_storage(plain), encrypted=True)
        if readable:
            assert store.load_secret(db, CID) == AkahuCredentials(user_token=token, app_token="t")
        else:
            with pytest.raises(SecretUnreadable):
                store.load_secret(db, CID)


# --- shared deployments: cleanup and the secrets manager ---------------------------


def test_shared_deployment_allows_removing_connections_only(db: Any, env: pytest.MonkeyPatch):
    both = _doc({CID: _connection(), CID2: _connection(label="second")})
    store.write_connections(db, both, now=NOW)
    env.setenv("DYNO", "web.1")
    # Adding, or changing a kept entry, is refused.
    for doc in (
        _doc({CID: _connection(), CID2: _connection(label="second"), _uuid(3): _connection()}),
        _doc({CID: _connection(label="renamed")}),
    ):
        with pytest.raises(ConnectorError) as info:
            store.write_connections(db, doc, now=NOW)
        assert info.value.error_type == "connections_unavailable"
    assert store.read_connections(db, now=NOW) == both
    # Removing one is allowed, then removing the rest.
    assert list(store.write_connections(db, _doc({CID: _connection()}), now=NOW)["items"]) == [CID]
    assert store.write_connections(db, store.empty(), now=NOW)["items"] == {}
    assert store.read_connections(db, now=NOW)["items"] == {}


@pytest.mark.parametrize("name", ["DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA"])
def test_secrets_manager_stored_methods_refuse_shared(
    db: Any, env: pytest.MonkeyPatch, name: str
):
    from src.services.secrets import StoredSecretsUnavailable

    manager = SecretsManager(db)
    manager.set_stored_secret("connection_secret:" + CID, "v")
    env.setenv(name, "true" if name != "DYNO" else "web.1")
    for call in (
        lambda: manager.set_stored_secret("connection_secret:" + CID2, "v"),
        lambda: manager.get_stored_secret("connection_secret:" + CID),
        lambda: manager.encrypt_for_storage("v"),
        lambda: manager.decrypt_stored("fernet:x", True),
    ):
        with pytest.raises(StoredSecretsUnavailable):
            call()
    assert _row(db, "connection_secret:" + CID2) is None
    assert manager.delete_stored_secret("connection_secret:" + CID) is True


def test_only_the_store_calls_the_stored_secret_methods():
    methods = {
        "set_stored_secret",
        "get_stored_secret",
        "delete_stored_secret",
        "encrypt_for_storage",
        "decrypt_stored",
    }
    allowed = {
        ROOT / "src" / "connectors" / "store.py",
        ROOT / "src" / "services" / "secrets.py",
    }
    seen = 0
    for path in (ROOT / "src").rglob("*.py"):
        if path in allowed or "web" in path.relative_to(ROOT / "src").parts[:1]:
            continue
        seen += 1
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute):
                assert node.attr not in methods, f"{path.name} uses {node.attr}"
            if isinstance(node, ast.Name):
                assert node.id not in methods, f"{path.name} uses {node.id}"
    assert seen > 50


# --- the generic API key methods never touch the store's rows --------------------


@pytest.mark.parametrize(
    "name",
    ["connections", "CONNECTIONS", " connections ", "connection_secret:" + CID, "Connection_Secret:x"],
)
def test_api_key_methods_refuse_reserved_names(db: Any, env: pytest.MonkeyPatch, name: str):
    store.write_connections(db, _doc({CID: _connection()}), now=NOW)
    store.save_secret(db, CID, SIMPLEFIN)
    env.setenv(name.strip().upper(), "from-env")
    manager = SecretsManager(db)
    assert manager.get_api_key(name) is None
    assert manager.has_api_key(name) is False
    assert manager.get_key_source(name) is None
    assert manager.set_api_key(name, "x") is False
    assert manager.delete_api_key(name) is False
    assert store.read_connections(db, now=NOW)["items"][CID]["label"] == "My SimpleFIN"
    assert store.load_secret(db, CID) == SIMPLEFIN


# --- the key file is never regenerated -------------------------------------------


def test_save_with_a_corrupt_key_is_save_failed(db: Any, env: pytest.MonkeyPatch, home: Path):
    env.delenv("SECRET_KEY")
    key_file = home / ".investment_dashboard_key"
    key_file.write_bytes(b"not a fernet key")
    with pytest.raises(ConnectorError) as info:
        store.save_secret(db, CID, SIMPLEFIN)
    assert info.value.error_type == "save_failed"
    assert info.value.__context__ is None
    assert key_file.read_bytes() == b"not a fernet key"
    assert _row(db, store.secret_key(CID)) is None


@pytest.fixture()
def unreadable(home: Path):
    """Make a file unreadable for the test, then restore it for cleanup."""
    made: list[Path] = []

    def _make(path: Path) -> None:
        path.chmod(0)
        made.append(path)

    yield _make
    for path in made:
        path.chmod(0o600)


def test_an_unreadable_key_file_is_left_untouched(
    db: Any, env: pytest.MonkeyPatch, home: Path, unreadable: Any
):
    env.delenv("SECRET_KEY")
    store.save_secret(db, CID, AKAHU)
    SecretsManager(db).set_api_key("probe_api_key", "probe-value")
    key_file = home / ".investment_dashboard_key"
    original = key_file.read_bytes()
    unreadable(key_file)
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)
    with pytest.raises(ConnectorError) as info:
        store.save_secret(db, CID2, AKAHU)
    assert info.value.error_type == "save_failed"
    manager = SecretsManager(db)
    assert manager.get_api_key("probe_api_key") is None
    assert manager.set_api_key("probe_api_key", "new") is False
    key_file.chmod(0o600)
    assert key_file.read_bytes() == original
    # Once readable again, everything stored before still decrypts.
    assert store.load_secret(db, CID) == AKAHU
    assert SecretsManager(db).get_api_key("probe_api_key") == "probe-value"


def test_loads_never_create_a_key_file(db: Any, env: pytest.MonkeyPatch, home: Path):
    store.save_secret(db, CID, AKAHU)  # under the fixed SECRET_KEY
    SecretsManager(db).set_api_key("probe_api_key", "probe-value")
    env.delenv("SECRET_KEY")
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)
    assert SecretsManager(db).get_api_key("probe_api_key") is None
    assert not (home / ".investment_dashboard_key").exists()
    assert not (home / ".investment_dashboard_salt").exists()


def test_an_existing_key_file_keeps_working(db: Any, env: pytest.MonkeyPatch, home: Path):
    env.delenv("SECRET_KEY")
    key = Fernet.generate_key()
    (home / ".investment_dashboard_key").write_bytes(key + b"\n")
    SecretsManager(db).set_api_key("probe_api_key", "probe-value")
    store.save_secret(db, CID, SIMPLEFIN)
    assert SecretsManager(db).get_api_key("probe_api_key") == "probe-value"
    assert store.load_secret(db, CID) == SIMPLEFIN
    assert (home / ".investment_dashboard_key").read_bytes() == key + b"\n"


def test_password_secret_key_salt_rules(db: Any, env: pytest.MonkeyPatch, home: Path, unreadable: Any):
    from src.services import secrets as secrets_module

    env.setenv("SECRET_KEY", "a password, not a fernet key")
    salt = home / ".investment_dashboard_salt"
    # A value written before the per-install salt existed (legacy salt) still
    # reads, and reading creates no salt file.
    legacy = Fernet(secrets_module._get_legacy_fernet_key())
    db.set_setting("probe_api_key", "fernet:" + legacy.encrypt(b"legacy-value").decode(), encrypted=True)
    assert SecretsManager(db).get_api_key("probe_api_key") == "legacy-value"
    assert not salt.exists()
    # A save creates the salt; both values then read.
    store.save_secret(db, CID, AKAHU)
    assert salt.exists()
    original = salt.read_bytes()
    assert store.load_secret(db, CID) == AKAHU
    assert SecretsManager(db).get_api_key("probe_api_key") == "legacy-value"
    # An unreadable salt is never regenerated.
    unreadable(salt)
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)
    with pytest.raises(ConnectorError):
        store.save_secret(db, CID2, AKAHU)
    salt.chmod(0o600)
    assert salt.read_bytes() == original
    # A truncated salt is refused, not replaced.
    salt.write_bytes(b"short")
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)
    assert salt.read_bytes() == b"short"


@pytest.mark.parametrize("raw_salt", [b"\n" + b"s" * 15, b"s" * 15 + b" ", b"\t" + b"s" * 14 + b"\r"])
def test_an_older_salt_with_surrounding_whitespace_still_reads(
    db: Any, env: pytest.MonkeyPatch, home: Path, raw_salt: bytes
):
    """Older code wrote 16 raw bytes and stripped them on read; values
    encrypted with the raw salt must still decrypt, and the file is kept."""
    from src.services import secrets as secrets_module

    phrase = "a password, not a fernet key"
    env.setenv("SECRET_KEY", phrase)
    salt = home / ".investment_dashboard_salt"
    salt.write_bytes(raw_salt)
    fernet = Fernet(secrets_module._derive_fernet_key(phrase, raw_salt))
    db.set_setting("probe_api_key", "fernet:" + fernet.encrypt(b"raw-salt-value").decode(), encrypted=True)
    assert SecretsManager(db).get_api_key("probe_api_key") == "raw-salt-value"
    store.save_secret(db, CID, AKAHU)
    assert store.load_secret(db, CID) == AKAHU
    assert salt.read_bytes() == raw_salt


def test_a_stripped_salt_that_is_not_16_raw_bytes_is_refused(db: Any, env: pytest.MonkeyPatch, home: Path):
    env.setenv("SECRET_KEY", "a password, not a fernet key")
    salt = home / ".investment_dashboard_salt"
    raw = b"\n" + b"s" * 14 + b"\n\n"  # 17 raw bytes, 14 once stripped
    salt.write_bytes(raw)
    with pytest.raises(SecretUnreadable):
        store.load_secret(db, CID)
    with pytest.raises(ConnectorError):
        store.save_secret(db, CID, AKAHU)
    assert salt.read_bytes() == raw


def _race_the_salt_create(monkeypatch: pytest.MonkeyPatch, home: Path, partial: bytes) -> list[float]:
    """Make the exclusive create lose to another process that has written
    only ``partial`` so far. Returns the list of sleeps taken."""
    from src.services import secrets as secrets_module

    salt = home / ".investment_dashboard_salt"
    real_open = secrets_module.os.open
    sleeps: list[float] = []

    def fake_open(path: Any, flags: int, *args: Any) -> int:
        if Path(path) == salt and flags & secrets_module.os.O_EXCL:
            salt.write_bytes(partial)
            raise FileExistsError(path)
        return real_open(path, flags, *args)

    monkeypatch.setattr(secrets_module.os, "open", fake_open)
    monkeypatch.setattr(secrets_module.time, "sleep", sleeps.append)
    return sleeps


def test_a_salt_create_waits_for_the_other_writer(monkeypatch: pytest.MonkeyPatch, home: Path):
    from src.services import secrets as secrets_module

    sleeps = _race_the_salt_create(monkeypatch, home, b"")
    salt = home / ".investment_dashboard_salt"
    finished = b"\n" + b"w" * 15  # an older raw salt: whitespace first

    def finish_on_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        salt.write_bytes(finished)

    monkeypatch.setattr(secrets_module.time, "sleep", finish_on_sleep)
    assert secrets_module._load_or_create_salt(create=True) == finished
    assert len(sleeps) == 1
    assert salt.read_bytes() == finished


def test_a_salt_create_that_never_completes_fails_clearly(
    monkeypatch: pytest.MonkeyPatch, home: Path, caplog: pytest.LogCaptureFixture
):
    from src.services import secrets as secrets_module

    sleeps = _race_the_salt_create(monkeypatch, home, b"half")
    with caplog.at_level(logging.ERROR), pytest.raises(secrets_module.EncryptionKeyUnavailable):
        secrets_module._load_or_create_salt(create=True)
    assert 1 < len(sleeps) <= 10
    assert sum(sleeps) < 2
    assert "incomplete" in caplog.text
    assert (home / ".investment_dashboard_salt").read_bytes() == b"half"


def test_new_salts_survive_the_strip_on_read(monkeypatch: pytest.MonkeyPatch):
    from src.services import secrets as secrets_module

    draws = iter([b"\n" + b"a" * 15, b"a" * 15 + b" ", b"b" * 16])
    monkeypatch.setattr(secrets_module._pysecrets, "token_bytes", lambda n: next(draws))
    assert secrets_module._new_salt() == b"b" * 16


# --- which connections exist (plan B3; shared with the browser) -----------------

EXISTS_CASES = json.loads(
    (Path(__file__).resolve().parents[1] / "fixtures" / "connections_exists_cases.json").read_text(
        encoding="utf-8"
    )
)["cases"]


@pytest.mark.parametrize("case", EXISTS_CASES, ids=[c["name"] for c in EXISTS_CASES])
def test_connections_the_document_keeps(tmp_path: Path, case: dict[str, Any]) -> None:
    """The browser's ``connectionIds`` answers the same fixture."""
    db = Database(str(tmp_path / "exists.db"))
    if case["value"] is not None:
        with db.get_session() as s:
            s.add(AppSettings(key="connections", value=case["value"], encrypted=False))
            s.commit()
    assert list(store.read_connections(db)["items"]) == case["ids"]
    with db.get_session() as s:
        assert list(store.read_connections(None, session=s)["items"]) == case["ids"]
    db.engine.dispose()
