"""Server-mode connection routes and service (design 6.2, 8.3, 8.4, 9.1; plan B2).

Every test runs on a temp database with a fixed ``SECRET_KEY`` and a fake home
directory, a pinned clock, and an ``httpx.MockTransport`` injected through
the v2 transport factory dependency. Name resolution and socket connects fail
loudly, so nothing can reach the network.
"""

from __future__ import annotations

import ast
import base64
import json
import logging
import socket
import threading
import time
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException
from fastapi.testclient import TestClient

from src.api.dependencies import get_db
from src.api.v2 import connectors as v2api
from src.connectors import service, store
from src.connectors.errors import ConnectorError
from src.connectors import simplefin as sf
from src.connectors.normalize import account_key_for
from src.connectors.types import AkahuCredentials
from src.database import Database
from src.database.models import (
    BankStatementImport,
    BudgetExpenseCategory,
    ImportTransaction,
    Liability,
    SmartImportMeta,
)
from src.liabilities import clock
from src.main import app
from src.services.secrets import EncryptionKeyUnavailable, SecretsManager
from tests.connectors.apply_contract import as_apply

ROOT = Path(__file__).resolve().parents[2]
TODAY = date(2026, 10, 4)
NOW = datetime(2026, 10, 4, 12, 0, 0, tzinfo=timezone.utc)
BASE = "/api/connections"

PLANT_USER = "zqconnuser"
PLANT_PASS = "Zq9ConnPassw0rdPlanted"
ACCESS_URL = f"https://{PLANT_USER}:{PLANT_PASS}@beta-bridge.simplefin.org/simplefin"
NEW_PASS = "Zq9ConnNewPassw0rdPasted"  # nosec B105 - synthetic test value
NEW_ACCESS_URL = f"https://{PLANT_USER}:{NEW_PASS}@beta-bridge.simplefin.org/simplefin"
CLAIM_URL = "https://beta-bridge.simplefin.org/simplefin/claim/ZQCONNCLAIM123"
SETUP_TOKEN = base64.b64encode(CLAIM_URL.encode()).decode()
USER_TOKEN = "user_token_ZqConnUser123"
APP_TOKEN = "app_token_ZqConnApp456"
PLANT_NAME = "ZQ Conn Everyday"
PLANT_CARD = "ZQ Conn Rewards VISA"
PLANT_INST = "ZQ Conn Bank"
PLANT_MERCHANT = "ZQXCONN WIDGETS"
PLANT_AMOUNT = "6543.21"
SECRETS = (PLANT_USER, PLANT_PASS, NEW_PASS, USER_TOKEN, APP_TOKEN, "ZQCONNCLAIM123", SETUP_TOKEN)
CONTENT = (PLANT_NAME, PLANT_CARD, PLANT_INST, PLANT_MERCHANT, PLANT_AMOUNT)

SF_CHK = "ACT-CONN-CHK"
SF_CARD = "ACT-CONN-CARD"
SF_NEW = "ACT-CONN-NEW"
AK_ACCOUNT = "acc_conn0001"
LIABILITY_ID = "11111111-2222-4333-8444-555555555555"
DEMO_LIABILITY_ID = "22222222-3333-4444-8555-666666666666"


def _ts(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, 12, tzinfo=timezone.utc).timestamp())


# --- environment ----------------------------------------------------------------


def _no_network(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("a connection API test tried to use the network")


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setattr(socket, "getaddrinfo", _no_network)
    monkeypatch.setattr(socket, "create_connection", _no_network)
    for name in (
        "DYNO",
        "MULTI_USER_MODE",
        "PROTECT_DEMO_DATA",
        "CONNECTORS_ENABLED",
        "CONNECTORS_SIMPLEFIN_EXTRA_HOSTS",
        "RATE_LIMIT_ENABLED",
        "RATE_LIMIT_SECRET_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setenv("PORTFOLIO_TEST_MODE", "true")
    monkeypatch.setattr(clock, "today", lambda: TODAY)
    monkeypatch.setattr(sf, "today", lambda: TODAY)
    monkeypatch.setattr(service, "utcnow", lambda: NOW)
    return monkeypatch


@pytest.fixture()
def db(tmp_path: Path) -> Any:
    database = Database(str(tmp_path / "connections.db"))
    with database.get_session() as s:
        for i, name in enumerate(["Groceries", "Dining", "Other"]):
            s.add(BudgetExpenseCategory(id=f"cat-{name}", name=name, sort_order=i))
        s.add(
            Liability(
                id=LIABILITY_ID,
                name="Rewards card",
                liability_type="credit_card",
                lender=PLANT_INST,
                current_balance=100.0,
                balance_as_of=date(2026, 9, 1),
                is_amortizing=False,
            )
        )
        s.add(
            Liability(
                id=DEMO_LIABILITY_ID,
                name="Demo card",
                liability_type="credit_card",
                lender="Demo Bank",
                current_balance=50.0,
                balance_as_of=date(2026, 9, 1),
                is_amortizing=False,
            )
        )
        s.commit()
    yield database
    database.engine.dispose()


class Fake:
    """A MockTransport handler standing in for the bridge and Akahu."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status: int | None = None  # every non-claim request
        self.claim_status: int | None = None
        self.extra_account = False
        self.on_accounts: Any = None
        self.errlist: list[Any] = []
        self.v1_errors: list[Any] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        host, path = request.url.host, request.url.path
        if host.endswith("simplefin.org"):
            if request.method == "POST" and "/claim/" in path:
                if self.claim_status is not None:
                    return httpx.Response(self.claim_status, text="")
                return httpx.Response(200, text=ACCESS_URL)
            if path.endswith("/accounts"):
                balances_only = request.url.params.get("balances-only") == "1"
                if balances_only and self.on_accounts is not None:
                    self.on_accounts()
                if self.status is not None:
                    return httpx.Response(self.status, json={})
                return httpx.Response(200, json=self._simplefin(balances_only))
        if host == "api.akahu.io":
            if self.status is not None:
                return httpx.Response(self.status, json={})
            if path == "/v1/accounts":
                return httpx.Response(200, json=self._akahu_accounts())
            if path == "/v1/transactions":
                return httpx.Response(200, json=self._akahu_txns())
        return httpx.Response(404, json={})

    def _simplefin(self, balances_only: bool) -> dict[str, Any]:
        accounts: list[dict[str, Any]] = [
            {
                "id": SF_CHK,
                "name": PLANT_NAME,
                "conn_id": "CON-ZQ",
                "currency": "USD",
                "balance": "1234.56",
                "balance-date": _ts(TODAY),
            },
            {
                "id": SF_CARD,
                "name": PLANT_CARD,
                "conn_id": "CON-ZQ",
                "currency": "USD",
                "balance": "-321.00",
                "balance-date": _ts(TODAY),
            },
        ]
        if self.extra_account:
            accounts.append(
                {
                    "id": SF_NEW,
                    "name": "ZQ Conn Savings",
                    "conn_id": "CON-ZQ",
                    "currency": "USD",
                    "balance": "10.00",
                    "balance-date": _ts(TODAY),
                }
            )
        if not balances_only:
            accounts[0]["transactions"] = [
                {
                    "id": "T-ZQ-1",
                    "posted": _ts(TODAY - timedelta(days=3)),
                    "amount": f"-{PLANT_AMOUNT}",
                    "description": PLANT_MERCHANT,
                    "payee": PLANT_MERCHANT,
                }
            ]
            accounts[1]["transactions"] = []
        doc: dict[str, Any] = {
            "errlist": list(self.errlist),
            "connections": [{"conn_id": "CON-ZQ", "name": PLANT_INST}],
            "accounts": accounts,
        }
        if self.v1_errors:
            doc["errors"] = list(self.v1_errors)
        return doc

    def _akahu_accounts(self) -> dict[str, Any]:
        return {
            "success": True,
            "items": [
                {
                    "_id": AK_ACCOUNT,
                    "connection": {"_id": "conn_zq01", "name": PLANT_INST},
                    "name": PLANT_NAME,
                    "status": "ACTIVE",
                    "type": "CHECKING",
                    "balance": {"currency": "NZD", "current": 1500.25},
                }
            ],
        }

    def _akahu_txns(self) -> dict[str, Any]:
        day = (TODAY - timedelta(days=3)).isoformat()
        return {
            "success": True,
            "items": [
                {
                    "_id": "trans_zq01",
                    "_account": AK_ACCOUNT,
                    "date": f"{day}T00:00:00.000Z",
                    "description": PLANT_MERCHANT,
                    "amount": -6543.21,
                }
            ],
            "cursor": {"next": None},
        }


@pytest.fixture()
def fake() -> Any:
    return Fake()


@pytest.fixture()
def client(db: Any, fake: Fake) -> Any:
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[v2api.transport_factory] = lambda: (
        lambda provider_id: httpx.MockTransport(fake)
    )
    try:
        yield TestClient(app)
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(v2api.transport_factory, None)


# --- helpers --------------------------------------------------------------------


def _create(client: Any, **body: Any) -> Any:
    return client.post(BASE, json=body)


def _created(client: Any, **body: Any) -> dict[str, Any]:
    resp = _create(client, **body)
    assert resp.status_code == 200, resp.text
    return resp.json()


def _simplefin(client: Any, **extra: Any) -> dict[str, Any]:
    return _created(client, provider="simplefin", setup_token=SETUP_TOKEN, **extra)


def _doc(db: Any) -> dict[str, Any]:
    return store.read_connections(db, now=NOW)


def _conn(db: Any, cid: str) -> dict[str, Any]:
    return _doc(db)["items"][cid]


def _accounts_by_id(detail: dict[str, Any]) -> dict[str, dict[str, Any]]:
    return {a["provider_account_id"]: a for a in detail["accounts"]}


def _assert_fixed_error(resp: Any, status: int, error_type: str) -> None:
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert body["error_type"] == error_type
    assert set(body) == {"error_type", "detail"}
    for secret in SECRETS + CONTENT:
        assert secret not in resp.text


def _assert_no_secret(resp: Any) -> None:
    for secret in SECRETS:
        assert secret not in resp.text
    assert "simplefin.org/simplefin" not in resp.text


def _add_meta(
    db: Any,
    *,
    account_key: str,
    period_end: date,
    connection_id: str | None,
    import_id: str | None = None,
) -> str:
    iid = import_id or str(uuid.uuid4())
    with db.get_session() as s:
        s.add(
            BankStatementImport(
                id=iid, file_name="x", content_hash=iid.replace("-", ""), row_count=0, status="applied"
            )
        )
        s.add(
            SmartImportMeta(
                import_id=iid,
                batch_id="b1",
                origin="connector" if connection_id else "file",
                format="connector" if connection_id else "csv",
                parser="connector:simplefin" if connection_id else "csv",
                account_kind="checking",
                account_key=account_key,
                period_start=period_end - timedelta(days=30),
                period_end=period_end,
                connection_id=connection_id,
            )
        )
        s.commit()
    return iid


def _add_txn(db: Any, *, account_key: str, posted: date) -> None:
    with db.get_session() as s:
        s.add(
            ImportTransaction(
                import_id="imp-file",
                account_key=account_key,
                posted_date=posted,
                amount=-1.0,
                description="x",
                merchant_key="x",
                kind="expense",
                category_source="none",
                dedupe_key=f"{account_key}|{posted.isoformat()}",
            )
        )
        s.commit()


def _delete_meta(db: Any, import_id: str) -> None:
    with db.get_session() as s:
        s.query(SmartImportMeta).filter_by(import_id=import_id).delete()
        s.commit()


def _all_routes(cid: str) -> list[tuple[str, str, Any]]:
    return [
        ("GET", BASE, None),
        ("POST", BASE, {"provider": "demo"}),
        ("GET", f"{BASE}/{cid}", None),
        ("PUT", f"{BASE}/{cid}", {"label": "x"}),
        ("POST", f"{BASE}/{cid}/credentials", {}),
        ("POST", f"{BASE}/{cid}/accounts", None),
        ("POST", f"{BASE}/{cid}/sync", {"window_index": 0}),
        ("DELETE", f"{BASE}/{cid}?remove_data=true", None),
    ]


def _call(client: Any, method: str, path: str, body: Any) -> Any:
    return client.request(method, path, json=body) if body is not None else client.request(method, path)


# --- deployment gating and demo protection -----------------------------------------


@pytest.mark.parametrize(
    "flag, value",
    [("DYNO", "web.1"), ("MULTI_USER_MODE", "true"), ("PROTECT_DEMO_DATA", "true")],
)
def test_every_route_refuses_a_shared_deployment(client, db, fake, env, flag, value):
    cid = _created(client, provider="demo")["id"]
    before = _doc(db)
    env.setenv(flag, value)
    env.setenv("CONNECTORS_ENABLED", "true")  # the v2 opt-in does not unlock storage
    for method, path, body in _all_routes(cid):
        _assert_fixed_error(_call(client, method, path, body), 403, "connections_unavailable")
    # Refused before the body is read: an invalid body gets the same answer.
    _assert_fixed_error(
        client.post(BASE, content=b"{not json", headers={"content-type": "application/json"}),
        403,
        "connections_unavailable",
    )
    assert fake.requests == []
    env.delenv(flag)
    assert _doc(db) == before


def test_writes_call_check_demo_data_protection(client, db, fake, env):
    cid = _created(client, provider="demo")["id"]
    before = _doc(db)
    calls: list[int] = []

    def protected() -> None:
        calls.append(1)
        raise HTTPException(status_code=403, detail="Demo data is protected.")

    env.setattr("src.services.demo_mode.check_demo_data_protection", protected)
    for method, path, body in _all_routes(cid):
        resp = _call(client, method, path, body)
        if method == "GET":
            assert resp.status_code == 200, (path, resp.text)
        else:
            assert resp.status_code == 403, (method, path, resp.text)
    assert len(calls) == 6
    assert _doc(db) == before


# --- create ------------------------------------------------------------------------


def test_create_with_a_setup_token_claims_commits_then_lists_accounts(client, db, fake):
    seen_at_accounts: dict[str, Any] = {}

    def at_accounts() -> None:
        # The credential is committed before the account call (design 8.3).
        items = _doc(db)["items"]
        (cid,) = items
        seen_at_accounts["status"] = items[cid]["status"]
        row = db.get_setting(store.secret_key(cid))
        seen_at_accounts["encrypted"] = row.encrypted
        seen_at_accounts["prefix"] = row.value.split(":", 1)[0]

    fake.on_accounts = at_accounts
    resp = _create(client, provider="simplefin", setup_token=SETUP_TOKEN, label="My bridge")
    assert resp.status_code == 200, resp.text
    _assert_no_secret(resp)
    detail = resp.json()
    assert seen_at_accounts == {"status": "accounts_pending", "encrypted": True, "prefix": "fernet"}
    assert str(uuid.UUID(detail["id"])) == detail["id"]
    assert detail["provider"] == "simplefin"
    assert detail["label"] == "My bridge"
    assert detail["status"] == "ok"
    assert detail["accounts_error"] is None
    assert detail["account_errors"] == []
    assert detail["last_synced_at"] is None
    assert detail["quota_budget"] == 20
    assert detail["quota_left"] == 18  # the claim and the account listing
    claim, listing = fake.requests
    assert claim.method == "POST" and str(claim.url) == CLAIM_URL
    assert listing.method == "GET"
    assert listing.url.params.get("balances-only") == "1"
    assert PLANT_PASS not in str(listing.url)
    accounts = _accounts_by_id(detail)
    assert set(accounts) == {SF_CHK, SF_CARD}
    chk, card = accounts[SF_CHK], accounts[SF_CARD]
    assert (chk["kind"], chk["role"], chk["liability_id"]) == ("checking", "cash_flow", None)
    assert (card["kind"], card["role"], card["liability_id"]) == ("credit_card", "debt", LIABILITY_ID)
    assert chk["account_key"] == account_key_for("simplefin", SF_CHK)
    assert chk["label"] == PLANT_NAME and chk["institution"] == PLANT_INST
    assert chk["same_as_key"] is None and chk["flip_balance"] is False
    assert chk["next_since"] == (TODAY - timedelta(days=89)).isoformat()
    assert detail["windows"] == [
        {"start": (TODAY - timedelta(days=89)).isoformat(), "end": TODAY.isoformat()}
    ]
    stored = store.load_secret(db, detail["id"])
    assert stored.password == PLANT_PASS  # type: ignore[attr-defined]


def test_an_account_failure_after_the_claim_keeps_the_credential(client, db, fake):
    fake.status = 500
    resp = _create(client, provider="simplefin", setup_token=SETUP_TOKEN)
    assert resp.status_code == 200, resp.text
    _assert_no_secret(resp)
    detail = resp.json()
    cid = detail["id"]
    assert detail["status"] == "accounts_pending"
    assert detail["accounts_error"] == "provider_unavailable"
    assert detail["account_errors"] == []
    assert detail["accounts"] == [] and detail["windows"] == []
    assert db.get_setting(store.secret_key(cid)) is not None
    # Sync has nothing to do until accounts are loaded.
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync", json={}), 422, "bad_request")
    fake.status = None
    resp = client.post(f"{BASE}/{cid}/accounts")
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    assert detail["status"] == "ok"
    accounts = _accounts_by_id(detail)
    # The first successful listing still gets the defaults by kind.
    assert accounts[SF_CHK]["role"] == "cash_flow"
    assert accounts[SF_CARD]["role"] == "debt"
    claims = [r for r in fake.requests if r.method == "POST"]
    assert len(claims) == 1


def test_create_with_an_access_url_skips_the_claim(client, db, fake):
    detail = _created(client, provider="simplefin", access_url=ACCESS_URL)
    assert detail["status"] == "ok"
    assert [r.method for r in fake.requests] == ["GET"]
    assert detail["quota_left"] == 19


def test_create_akahu_with_both_tokens(client, db, fake):
    detail = _created(client, provider="akahu", user_token=USER_TOKEN, app_token=APP_TOKEN)
    assert detail["status"] == "ok" and detail["quota_budget"] == 48
    (acct,) = detail["accounts"]
    assert acct["provider_account_id"] == AK_ACCOUNT and acct["currency"] == "NZD"
    assert fake.requests[0].headers["authorization"] == f"Bearer {USER_TOKEN}"
    stored = store.load_secret(db, detail["id"])
    assert isinstance(stored, AkahuCredentials)


def test_create_demo_needs_no_credentials_and_no_network(client, db, fake):
    detail = _created(client, provider="demo", first_sync_days=30)
    assert detail["label"] == "Demo"
    assert detail["status"] == "ok"
    assert detail["quota_budget"] is None and detail["quota_left"] is None
    assert db.get_setting(store.secret_key(detail["id"])) is None
    assert fake.requests == []
    accounts = _accounts_by_id(detail)
    assert accounts["demo-chk"]["role"] == "cash_flow"
    assert accounts["demo-card"]["role"] == "debt"
    assert accounts["demo-card"]["liability_id"] == DEMO_LIABILITY_ID
    assert accounts["demo-chk"]["next_since"] == (TODAY - timedelta(days=29)).isoformat()


@pytest.mark.parametrize(
    "body",
    [
        {"provider": "simplefin"},
        {"provider": "simplefin", "user_token": USER_TOKEN, "app_token": APP_TOKEN},
        {"provider": "simplefin", "setup_token": SETUP_TOKEN, "access_url": ACCESS_URL},
        {"provider": "akahu", "user_token": USER_TOKEN},
        {"provider": "akahu", "access_url": ACCESS_URL},
        {"provider": "demo", "access_url": ACCESS_URL},
        {"provider": "plaid"},
        {"provider": "demo", "label": ""},
        {"provider": "demo", "label": "bad\nlabel"},
        {"provider": "demo", "first_sync_days": 45},
        {"provider": "demo", "extra": 1},
    ],
)
def test_create_refuses_a_wrong_body(client, db, fake, body):
    _assert_fixed_error(client.post(BASE, json=body), 422, "bad_request")
    assert _doc(db)["items"] == {}
    assert fake.requests == []


def test_an_access_url_off_the_allowlist_stores_nothing(client, db, fake):
    resp = _create(client, provider="simplefin", access_url="https://u:p@evil.example.com/simplefin")
    _assert_fixed_error(resp, 422, "host_not_allowed")
    assert _doc(db)["items"] == {}
    assert fake.requests == []


def test_a_refused_claim_stores_nothing(client, db, fake):
    fake.claim_status = 403
    _assert_fixed_error(
        _create(client, provider="simplefin", setup_token=SETUP_TOKEN), 422, "claim_refused"
    )
    assert _doc(db)["items"] == {}
    assert len(fake.requests) == 1


def test_an_unusable_key_refuses_before_the_claim(client, db, fake, env):
    def broken(self, value):
        raise EncryptionKeyUnavailable()

    env.setattr(SecretsManager, "encrypt_for_storage", broken)
    _assert_fixed_error(
        _create(client, provider="simplefin", setup_token=SETUP_TOKEN), 500, "save_failed"
    )
    assert fake.requests == []  # the one-time token was not spent
    assert _doc(db)["items"] == {}


def test_the_eleventh_connection_is_refused(client, db, fake):
    for _ in range(10):
        _created(client, provider="demo")
    _assert_fixed_error(_create(client, provider="demo"), 422, "connection_limit")
    assert len(_doc(db)["items"]) == 10


def test_claim_and_accounts_share_one_deadline(client, db, fake, env):
    deadlines: list[float | None] = []
    real = service.SafeClient

    class Spy(real):  # type: ignore[misc, valid-type]
        def __init__(self, provider_id, *, transport=None, deadline=None):
            deadlines.append(deadline)
            super().__init__(provider_id, transport=transport, deadline=deadline)

    env.setattr(service, "SafeClient", Spy)
    _simplefin(client)
    assert len(deadlines) == 2 and deadlines[0] is not None
    assert deadlines[0] == deadlines[1]


# --- list, detail, unknown ids ---------------------------------------------------


def test_list_and_detail_never_carry_a_secret(client, db, fake):
    sf_id = _simplefin(client)["id"]
    ak_id = _created(client, provider="akahu", user_token=USER_TOKEN, app_token=APP_TOKEN)["id"]
    listing = client.get(BASE)
    assert listing.status_code == 200
    _assert_no_secret(listing)
    summaries = listing.json()
    # Same created_at (pinned clock): ties go by id.
    assert [s["id"] for s in summaries] == sorted([sf_id, ak_id])
    assert set(summaries[0]) == {
        "id",
        "provider",
        "label",
        "status",
        "status_at",
        "created_at",
        "last_synced_at",
        "first_sync_days",
        "accounts_count",
        "accounts_enabled",
        "quota_budget",
        "quota_left",
        "quota_resets_at",
    }
    by_id = {s["id"]: s for s in summaries}
    assert by_id[sf_id]["accounts_count"] == 2 and by_id[sf_id]["accounts_enabled"] == 2
    for cid in (sf_id, ak_id):
        resp = client.get(f"{BASE}/{cid}")
        assert resp.status_code == 200
        _assert_no_secret(resp)
        assert "connection_secret" not in resp.text and "fernet" not in resp.text


@pytest.mark.parametrize("cid", [str(uuid.uuid4()), "not-a-uuid", "ABCDEF00-0000-4000-8000-000000000000"])
def test_an_unknown_id_is_404(client, db, fake, cid):
    _created(client, provider="demo")
    for method, path, body in _all_routes(cid)[2:]:
        _assert_fixed_error(_call(client, method, path, body), 404, "connection_not_found")
    assert fake.requests == []


# --- update (mapping) --------------------------------------------------------------


def test_update_changes_the_label_range_and_mapping(client, db, fake):
    cid = _simplefin(client)["id"]
    resp = client.put(
        f"{BASE}/{cid}",
        json={
            "label": "Renamed",
            "first_sync_days": 60,
            "accounts": {
                SF_CHK: {"label": "Everyday", "kind": "savings", "flip_balance": True},
                SF_CARD: {"liability_id": None, "role": "ignore"},
            },
        },
    )
    assert resp.status_code == 200, resp.text
    detail = resp.json()
    assert detail["label"] == "Renamed" and detail["first_sync_days"] == 60
    accounts = _accounts_by_id(detail)
    assert accounts[SF_CHK]["label"] == "Everyday"
    assert accounts[SF_CHK]["kind"] == "savings"
    assert accounts[SF_CHK]["flip_balance"] is True
    assert accounts[SF_CHK]["role"] == "cash_flow"  # not sent, unchanged
    assert accounts[SF_CARD]["liability_id"] is None
    assert accounts[SF_CARD]["role"] == "ignore"
    assert accounts[SF_CARD]["next_since"] is None
    assert accounts[SF_CHK]["next_since"] == (TODAY - timedelta(days=59)).isoformat()
    # Linking back to an existing debt works.
    resp = client.put(f"{BASE}/{cid}", json={"accounts": {SF_CARD: {"liability_id": LIABILITY_ID}}})
    assert _accounts_by_id(resp.json())[SF_CARD]["liability_id"] == LIABILITY_ID
    assert fake.requests[-1].url.params.get("balances-only") == "1"  # no provider call since


def test_update_links_a_debt_whose_id_is_not_a_uuid(client, db, fake):
    """The demo's debts have ids such as ``demo-card``; Apply links them, so the
    mapping must too, and the link survives the sanitizer on read."""
    with db.get_session() as s:
        s.add(
            Liability(
                id="demo-card",
                name="Credit card",
                liability_type="credit_card",
                lender="Chase Sapphire",
                current_balance=10.0,
                balance_as_of=date(2026, 9, 1),
                is_amortizing=False,
            )
        )
        s.commit()
    cid = _simplefin(client)["id"]
    resp = client.put(f"{BASE}/{cid}", json={"accounts": {SF_CARD: {"liability_id": "demo-card"}}})
    assert resp.status_code == 200
    detail = client.get(f"{BASE}/{cid}").json()
    assert _accounts_by_id(detail)[SF_CARD]["liability_id"] == "demo-card"


@pytest.mark.parametrize(
    "accounts, status, error_type",
    [
        ({SF_CHK: {"kind": "brokerage"}}, 422, "bad_request"),
        ({SF_CHK: {"role": "owner"}}, 422, "bad_request"),
        ({SF_CHK: {"kind": None}}, 422, "bad_request"),
        ({SF_CHK: {"label": ""}}, 422, "bad_request"),
        ({SF_CHK: {"flip_balance": "yes"}}, 422, "bad_request"),
        ({SF_CHK: {"liability_id": str(uuid.uuid4())}}, 404, "liability_not_found"),
        ({SF_CHK: {"liability_id": "L1"}}, 404, "liability_not_found"),
        ({SF_CHK: {"same_as_key": "label:never-imported"}}, 422, "bad_request"),
        ({SF_CHK: {"same_as_key": account_key_for("simplefin", SF_CHK)}}, 422, "bad_request"),
        ({"ACT-UNKNOWN": {"label": "x"}}, 422, "bad_request"),
        ({SF_CHK: {"other": 1}}, 422, "bad_request"),
    ],
)
def test_update_validates_the_mapping(client, db, fake, accounts, status, error_type):
    cid = _simplefin(client)["id"]
    before = _conn(db, cid)
    _assert_fixed_error(client.put(f"{BASE}/{cid}", json={"accounts": accounts}), status, error_type)
    assert _conn(db, cid) == before


def test_same_as_accepts_a_key_a_stored_import_uses(client, db, fake):
    cid = _simplefin(client)["id"]
    _add_meta(db, account_key="label:everyday", period_end=TODAY - timedelta(days=40), connection_id=None)
    resp = client.put(f"{BASE}/{cid}", json={"accounts": {SF_CHK: {"same_as_key": "label:everyday"}}})
    assert resp.status_code == 200, resp.text
    assert _accounts_by_id(resp.json())[SF_CHK]["same_as_key"] == "label:everyday"
    # Another connected account's key is known too.
    resp = client.put(
        f"{BASE}/{cid}",
        json={"accounts": {SF_CARD: {"same_as_key": account_key_for("simplefin", SF_CHK)}}},
    )
    assert resp.status_code == 200, resp.text
    resp = client.put(f"{BASE}/{cid}", json={"accounts": {SF_CHK: {"same_as_key": None}}})
    assert _accounts_by_id(resp.json())[SF_CHK]["same_as_key"] is None


# --- refresh -----------------------------------------------------------------------


def test_refresh_keeps_the_mapping_and_adds_new_accounts_as_ignore(client, db, fake):
    cid = _simplefin(client)["id"]
    client.put(f"{BASE}/{cid}", json={"accounts": {SF_CHK: {"label": "Mine", "kind": "savings"}}})
    fake.extra_account = True
    resp = client.post(f"{BASE}/{cid}/accounts")
    assert resp.status_code == 200, resp.text
    _assert_no_secret(resp)
    accounts = _accounts_by_id(resp.json())
    assert set(accounts) == {SF_CHK, SF_CARD, SF_NEW}
    assert accounts[SF_CHK]["label"] == "Mine" and accounts[SF_CHK]["kind"] == "savings"
    assert accounts[SF_NEW]["role"] == "ignore"
    assert accounts[SF_NEW]["next_since"] is None
    assert resp.json()["quota_left"] == 17


# --- plan (next_since and windows) -------------------------------------------------


@pytest.mark.parametrize("days", [30, 60, 90])
def test_first_sync_starts_at_the_chosen_range(client, db, fake, days):
    detail = _created(client, provider="demo", first_sync_days=days)
    for acct in detail["accounts"]:
        assert acct["next_since"] == (TODAY - timedelta(days=days - 1)).isoformat()
    assert detail["windows"] == [
        {"start": (TODAY - timedelta(days=days - 1)).isoformat(), "end": TODAY.isoformat()}
    ]


def test_later_syncs_start_five_days_before_the_newest_synced_end(client, db, fake):
    cid = _created(client, provider="demo")["id"]
    key = account_key_for("demo", "demo-chk")
    _add_meta(db, account_key=key, period_end=TODAY - timedelta(days=20), connection_id=cid)
    newest = _add_meta(db, account_key=key, period_end=TODAY - timedelta(days=10), connection_id=cid)
    # Another connection's import of the same key does not count.
    _add_meta(db, account_key=key, period_end=TODAY, connection_id=str(uuid.uuid4()))
    detail = client.get(f"{BASE}/{cid}").json()
    accounts = _accounts_by_id(detail)
    assert accounts["demo-chk"]["next_since"] == (TODAY - timedelta(days=15)).isoformat()
    assert accounts["demo-card"]["next_since"] == (TODAY - timedelta(days=89)).isoformat()
    # Undo deletes the meta row, so the plan rewinds.
    _delete_meta(db, newest)
    detail = client.get(f"{BASE}/{cid}").json()
    assert _accounts_by_id(detail)["demo-chk"]["next_since"] == (TODAY - timedelta(days=25)).isoformat()


def test_applying_a_sync_with_its_connection_moves_the_plan_and_undo_rewinds_it(client, db, fake):
    """End to end (plan B3): sync, Apply with ``connection_id``, the next plan
    starts five days before the applied period end; Undo rewinds it."""
    cid = _created(client, provider="demo", first_sync_days=30)["id"]
    body = client.post(f"{BASE}/{cid}/sync").json()
    chk_key = account_key_for("demo", "demo-chk")
    statements = [as_apply(st, cid) for st in body["statements"]]
    chk = next(st for st in statements if st["account"]["key"] == chk_key)
    applied = client.post(
        "/api/smart-import/apply", json={"batch_id": "sync-1", "statements": [chk]}
    )
    assert applied.status_code == 200, applied.text
    import_id = applied.json()["imports"][0]["import_id"]
    listed = client.get("/api/smart-import/imports").json()
    assert [(r["import_id"], r["connection_id"]) for r in listed] == [(import_id, cid)]
    end = date.fromisoformat(chk["period"]["end"])
    accounts = _accounts_by_id(client.get(f"{BASE}/{cid}").json())
    assert accounts["demo-chk"]["next_since"] == (end - timedelta(days=5)).isoformat()
    assert accounts["demo-card"]["next_since"] == (TODAY - timedelta(days=29)).isoformat()
    assert client.delete(f"/api/smart-import/imports/{import_id}").status_code == 200
    accounts = _accounts_by_id(client.get(f"{BASE}/{cid}").json())
    assert accounts["demo-chk"]["next_since"] == (TODAY - timedelta(days=29)).isoformat()


def test_same_as_starts_the_day_after_the_newest_stored_row(client, db, fake):
    cid = _created(client, provider="demo")["id"]
    _add_meta(db, account_key="label:everyday", period_end=TODAY - timedelta(days=30), connection_id=None)
    _add_txn(db, account_key="label:everyday", posted=TODAY - timedelta(days=20))
    _add_txn(db, account_key="label:everyday", posted=TODAY - timedelta(days=40))
    resp = client.put(
        f"{BASE}/{cid}", json={"accounts": {"demo-chk": {"same_as_key": "label:everyday"}}}
    )
    assert _accounts_by_id(resp.json())["demo-chk"]["next_since"] == (
        TODAY - timedelta(days=19)
    ).isoformat()
    # Once this connection has synced into that key, rule 1 wins.
    _add_meta(db, account_key="label:everyday", period_end=TODAY - timedelta(days=2), connection_id=cid)
    detail = client.get(f"{BASE}/{cid}").json()
    assert _accounts_by_id(detail)["demo-chk"]["next_since"] == (TODAY - timedelta(days=7)).isoformat()


def test_windows_split_at_90_days_and_stop_at_four(client, db, fake):
    cid = _created(client, provider="demo")["id"]
    _add_meta(db, account_key="label:old", period_end=TODAY - timedelta(days=500), connection_id=None)
    _add_txn(db, account_key="label:old", posted=TODAY - timedelta(days=400))
    client.put(f"{BASE}/{cid}", json={"accounts": {"demo-chk": {"same_as_key": "label:old"}}})
    detail = client.get(f"{BASE}/{cid}").json()
    start = TODAY - timedelta(days=399)
    expected = []
    for i in range(4):
        s = start + timedelta(days=90 * i)
        expected.append({"start": s.isoformat(), "end": (s + timedelta(days=89)).isoformat()})
    assert detail["windows"] == expected


def test_windows_for_and_window_requests():
    windows = service.windows_for(TODAY - timedelta(days=200), TODAY, 90)
    assert windows == [
        (TODAY - timedelta(days=200), TODAY - timedelta(days=111)),
        (TODAY - timedelta(days=110), TODAY - timedelta(days=21)),
        (TODAY - timedelta(days=20), TODAY),
    ]
    for start, end in windows:
        assert (end - start).days + 1 <= 90
    assert service.windows_for(TODAY + timedelta(days=1), TODAY, 90) == []
    plan = service.SyncPlan(
        accounts=[
            service.PlannedAccount("a", TODAY - timedelta(days=200), "acct:a", "checking", False),
            service.PlannedAccount("b", TODAY - timedelta(days=50), "acct:b", "credit_card", True),
        ],
        windows=windows,
        quota_left=None,
    )
    first = service.window_requests(plan, windows[0])
    assert [r.provider_account_id for r in first] == ["a"]
    second = service.window_requests(plan, windows[1])
    assert [(r.provider_account_id, r.since) for r in second] == [
        ("a", windows[1][0]),
        ("b", TODAY - timedelta(days=50)),
    ]
    assert second[1].flip_balance is True and second[1].kind == "credit_card"


# --- sync --------------------------------------------------------------------------


def test_demo_sync_returns_statements_and_applies_nothing(client, db, fake):
    cid = _created(client, provider="demo", first_sync_days=30)["id"]
    resp = client.post(f"{BASE}/{cid}/sync")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"statements", "account_errors", "window"}
    assert body["window"] == {
        "start": (TODAY - timedelta(days=29)).isoformat(),
        "end": TODAY.isoformat(),
    }
    assert body["account_errors"] == []
    keys = {st["account"]["key"] for st in body["statements"]}
    assert keys == {account_key_for("demo", "demo-chk"), account_key_for("demo", "demo-card")}
    for st in body["statements"]:
        assert st["origin"] == "connector" and st["format"] == "connector"
        assert st["transactions"]
    # Categorized with the profile's categories (seed rules map to these names).
    with db.get_session() as s:
        assert s.query(BankStatementImport).count() == 0
        assert s.query(ImportTransaction).count() == 0
    conn = _conn(db, cid)
    assert conn["status"] == "ok"
    assert conn["last_synced_at"] == "2026-10-04T12:00:00Z"
    assert fake.requests == []


def test_sync_uses_the_mapping_and_the_profile_rules(client, db, fake):
    cid = _simplefin(client, first_sync_days=30)["id"]
    client.put(f"{BASE}/{cid}", json={"accounts": {SF_CARD: {"role": "ignore"}}})
    with db.get_session() as s:
        from src.database.models import MerchantRule

        s.add(MerchantRule(merchant_key="ZQXCONN WIDGETS", category_id="cat-Dining", kind="expense", source="user"))
        s.commit()
    resp = client.post(f"{BASE}/{cid}/sync", json={"window_index": 0})
    assert resp.status_code == 200, resp.text
    (st,) = resp.json()["statements"]
    assert st["account"]["key"] == account_key_for("simplefin", SF_CHK)
    request = fake.requests[-1]
    assert request.url.params.get_list("account") == [SF_CHK]
    assert request.url.params.get("start-date") == str(
        int(datetime(2026, 9, 5, tzinfo=timezone.utc).timestamp())
    )
    assert PLANT_PASS not in str(request.url)
    (txn,) = st["transactions"]
    assert txn["merchant_key"] == "ZQXCONN WIDGETS"
    assert txn["category_id"] == "cat-Dining" and txn["category_source"] == "rule"
    assert _conn(db, cid)["last_synced_at"] == "2026-10-04T12:00:00Z"
    assert len(_conn(db, cid)["requests"]) == 3


def test_the_default_first_sync_is_one_90_day_window_every_provider_accepts(client, db, fake):
    start = TODAY - timedelta(days=89)
    expected = {"start": start.isoformat(), "end": TODAY.isoformat()}
    demo = _created(client, provider="demo")
    assert demo["first_sync_days"] == 90 and demo["windows"] == [expected]
    resp = client.post(f"{BASE}/{demo['id']}/sync")
    assert resp.status_code == 200, resp.text
    assert resp.json()["window"] == expected
    bridge = _simplefin(client)
    assert bridge["windows"] == [expected]
    resp = client.post(f"{BASE}/{bridge['id']}/sync")
    assert resp.status_code == 200, resp.text
    assert resp.json()["window"] == expected
    request = fake.requests[-1]
    assert request.url.params.get("start-date") == str(
        int(datetime(start.year, start.month, start.day, tzinfo=timezone.utc).timestamp())
    )
    akahu = _created(client, provider="akahu", user_token=USER_TOKEN, app_token=APP_TOKEN)
    resp = client.post(f"{BASE}/{akahu['id']}/sync")
    assert resp.status_code == 200, resp.text
    assert resp.json()["window"] == expected


def test_a_listing_reports_flagged_accounts_without_storing_them(client, db, fake):
    fake.errlist = [{"code": "act.failed", "account_id": SF_CARD, "msg": "x"}]
    detail = _simplefin(client)
    assert detail["status"] == "ok"
    assert {"provider_account_id": SF_CARD, "code": "connector_account_error"} in detail[
        "account_errors"
    ]
    assert set(_accounts_by_id(detail)) == {SF_CHK, SF_CARD}
    resp = client.post(f"{BASE}/{detail['id']}/accounts")
    assert resp.status_code == 200
    assert resp.json()["account_errors"] == detail["account_errors"]
    plain = client.get(f"{BASE}/{detail['id']}").json()
    assert "account_errors" not in plain and "accounts_error" not in plain
    fake.errlist = []
    assert client.post(f"{BASE}/{detail['id']}/accounts").json()["account_errors"] == []


def test_a_rate_limit_warning_sets_rate_limited_and_keeps_the_data(client, db, fake):
    cid = _simplefin(client)["id"]
    fake.v1_errors = ["Rate limit warning: slow down"]
    resp = client.post(f"{BASE}/{cid}/sync")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["statements"]
    assert {"provider_account_id": None, "code": "provider_rate_limited"} in body["account_errors"]
    conn = _conn(db, cid)
    assert conn["status"] == "rate_limited"
    assert conn["last_synced_at"] == "2026-10-04T12:00:00Z"
    fake.v1_errors = []
    assert client.post(f"{BASE}/{cid}/sync").status_code == 200
    assert _conn(db, cid)["status"] == "ok"


def test_sync_window_index_must_name_a_plan_window(client, db, fake):
    cid = _created(client, provider="demo")["id"]
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync", json={"window_index": 1}), 422, "bad_request")
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync", json={"window_index": -1}), 422, "bad_request")
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync", json={"window_index": "0"}), 422, "bad_request")
    assert _conn(db, cid)["last_synced_at"] is None


def test_a_revoked_token_sets_reconnect_needed_and_reconnect_restores(client, db, fake):
    cid = _simplefin(client)["id"]
    client.put(f"{BASE}/{cid}", json={"accounts": {SF_CHK: {"label": "Kept"}}})
    fake.status = 401
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 409, "reconnect_needed")
    conn = _conn(db, cid)
    assert conn["status"] == "reconnect_needed"
    assert conn["status_at"] == "2026-10-04T12:00:00Z"
    assert conn["last_synced_at"] is None
    assert len(conn["requests"]) == 3  # the bridge counted the failed call
    sent = len(fake.requests)
    # Sync and refresh stay off until Reconnect, without calling the provider.
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 409, "reconnect_needed")
    _assert_fixed_error(client.post(f"{BASE}/{cid}/accounts"), 409, "reconnect_needed")
    assert len(fake.requests) == sent
    fake.status = None
    resp = client.post(f"{BASE}/{cid}/credentials", json={"setup_token": SETUP_TOKEN})
    assert resp.status_code == 200, resp.text
    _assert_no_secret(resp)
    detail = resp.json()
    assert detail["id"] == cid and detail["status"] == "ok" and detail["accounts_error"] is None
    assert _accounts_by_id(detail)[SF_CHK]["label"] == "Kept"
    assert client.post(f"{BASE}/{cid}/sync").status_code == 200


@pytest.mark.parametrize(
    "status, code, error_type, conn_status",
    [
        (402, 409, "payment_required", "payment_required"),
        (429, 429, "provider_rate_limited", "rate_limited"),
        (500, 502, "provider_unavailable", "ok"),
    ],
)
def test_provider_errors_set_the_status(client, db, fake, status, code, error_type, conn_status):
    cid = _simplefin(client)["id"]
    fake.status = status
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), code, error_type)
    conn = _conn(db, cid)
    assert conn["status"] == conn_status
    assert conn["last_synced_at"] is None
    fake.status = None
    assert client.post(f"{BASE}/{cid}/sync").status_code == 200
    assert _conn(db, cid)["status"] == "ok"


def test_the_quota_is_checked_before_any_provider_call(client, db, fake):
    cid = _simplefin(client)["id"]
    doc = _doc(db)
    stamps = [
        store.now_iso(lambda i=i: NOW - timedelta(minutes=10 * (i + 1))) for i in range(20)
    ]
    doc["items"][cid]["requests"] = sorted(stamps)
    store.write_connections(db, doc, now=NOW)
    sent = len(fake.requests)
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 429, "quota_reached")
    _assert_fixed_error(client.post(f"{BASE}/{cid}/accounts"), 429, "quota_reached")
    assert len(fake.requests) == sent
    detail = client.get(f"{BASE}/{cid}").json()
    assert detail["quota_left"] == 0
    assert detail["quota_resets_at"] == store.now_iso(lambda: NOW - timedelta(minutes=200) + timedelta(hours=24))
    assert _conn(db, cid)["status"] == "ok"


def test_a_sync_judges_future_balances_by_the_service_clock(client, db, fake, env):
    cid = _simplefin(client, first_sync_days=30)["id"]
    # Balances are dated TODAY. Two days before it by the service clock they
    # start more than 24 hours ahead and are dropped, whatever the real date.
    env.setattr(service, "utcnow", lambda: NOW - timedelta(days=2))
    resp = client.post(f"{BASE}/{cid}/sync")
    assert resp.status_code == 200, resp.text
    statements = resp.json()["statements"]
    assert statements and all(s["closing_balance"] is None for s in statements)
    env.setattr(service, "utcnow", lambda: NOW)
    resp = client.post(f"{BASE}/{cid}/sync")
    assert resp.status_code == 200, resp.text
    assert all(s["closing_balance"] is not None for s in resp.json()["statements"])


def test_the_demo_has_no_quota(client, db, fake):
    cid = _created(client, provider="demo", first_sync_days=30)["id"]
    for _ in range(25):
        assert client.post(f"{BASE}/{cid}/sync").status_code == 200


def test_an_unreadable_secret_means_reconnect(client, db, fake):
    cid = _simplefin(client)["id"]
    db.set_setting(store.secret_key(cid), "wc1:aaaa:bbbb", encrypted=True)
    sent = len(fake.requests)
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 409, "reconnect_needed")
    assert len(fake.requests) == sent
    conn = _conn(db, cid)
    assert conn["status"] == "reconnect_needed"
    assert len(conn["requests"]) == 2  # nothing was sent


def test_a_secret_for_another_provider_means_reconnect(client, db, fake):
    cid = _simplefin(client)["id"]
    store.save_secret(db, cid, AkahuCredentials(user_token=USER_TOKEN, app_token=APP_TOKEN))
    _assert_fixed_error(client.post(f"{BASE}/{cid}/accounts"), 409, "reconnect_needed")
    assert _conn(db, cid)["status"] == "reconnect_needed"


def test_a_missing_secret_means_reconnect(client, db, fake):
    cid = _simplefin(client)["id"]
    store.delete_secret(db, cid)
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 409, "reconnect_needed")


def test_reconnect_must_match_the_provider(client, db, fake):
    cid = _simplefin(client)["id"]
    _assert_fixed_error(
        client.post(f"{BASE}/{cid}/credentials", json={"user_token": USER_TOKEN, "app_token": APP_TOKEN}),
        422,
        "bad_request",
    )
    assert store.load_secret(db, cid).password == PLANT_PASS  # type: ignore[attr-defined]


def _password(db: Any, cid: str) -> str:
    return store.load_secret(db, cid).password  # type: ignore[attr-defined]


def test_reconnect_with_an_access_url_verifies_then_replaces(client, db, fake):
    cid = _simplefin(client)["id"]
    client.put(f"{BASE}/{cid}", json={"accounts": {SF_CHK: {"label": "Kept"}}})
    sent = len(fake.requests)
    resp = client.post(f"{BASE}/{cid}/credentials", json={"access_url": NEW_ACCESS_URL})
    assert resp.status_code == 200, resp.text
    _assert_no_secret(resp)
    detail = resp.json()
    assert detail["id"] == cid and detail["status"] == "ok"
    assert detail["accounts_error"] is None and detail["account_errors"] == []
    assert _accounts_by_id(detail)[SF_CHK]["label"] == "Kept"
    assert [s["id"] for s in client.get(BASE).json()] == [cid]
    # One listing with the pasted credential, counted once, then the swap.
    assert len(fake.requests) == sent + 1
    auth = fake.requests[-1].headers["authorization"].split()[-1]
    assert base64.b64decode(auth).decode() == f"{PLANT_USER}:{NEW_PASS}"
    assert len(_conn(db, cid)["requests"]) == 3
    assert _password(db, cid) == NEW_PASS


@pytest.mark.parametrize("start", ["ok", "reconnect_needed"])
def test_a_wrong_pasted_credential_never_replaces_the_stored_one(client, db, fake, start):
    cid = _simplefin(client)["id"]
    if start == "reconnect_needed":
        fake.status = 401
        _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 409, "reconnect_needed")
    before = _conn(db, cid)
    assert before["status"] == start
    fake.status = 401
    resp = client.post(f"{BASE}/{cid}/credentials", json={"access_url": NEW_ACCESS_URL})
    assert resp.status_code == 200, resp.text
    _assert_no_secret(resp)
    detail = resp.json()
    assert detail["accounts_error"] == "reconnect_needed"
    assert detail["account_errors"] == []
    assert detail["status"] == start
    after = _conn(db, cid)
    # The call was made and counted; nothing else changed.
    assert after["requests"] == before["requests"] + ["2026-10-04T12:00:00Z"]
    assert {**after, "requests": before["requests"]} == before
    assert _password(db, cid) == PLANT_PASS


def test_a_pasted_credential_restores_a_reconnect_needed_connection(client, db, fake):
    cid = _simplefin(client)["id"]
    fake.status = 401
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 409, "reconnect_needed")
    fake.status = None
    resp = client.post(f"{BASE}/{cid}/credentials", json={"access_url": NEW_ACCESS_URL})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "ok" and resp.json()["accounts_error"] is None
    assert _password(db, cid) == NEW_PASS
    assert client.post(f"{BASE}/{cid}/sync").status_code == 200


def test_a_wrong_pasted_akahu_token_keeps_the_stored_one(client, db, fake):
    cid = _created(client, provider="akahu", user_token=USER_TOKEN, app_token=APP_TOKEN)["id"]
    fake.status = 401
    resp = client.post(
        f"{BASE}/{cid}/credentials",
        json={"user_token": "user_token_Wrong1", "app_token": "app_token_Wrong2"},  # nosec B105 - synthetic
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["accounts_error"] == "reconnect_needed"
    assert store.load_secret(db, cid) == AkahuCredentials(user_token=USER_TOKEN, app_token=APP_TOKEN)
    assert _conn(db, cid)["status"] == "ok"


def test_a_pasted_credential_is_refused_at_quota_without_a_call(client, db, fake):
    cid = _simplefin(client)["id"]
    doc = _doc(db)
    stamps = [
        store.now_iso(lambda i=i: NOW - timedelta(minutes=10 * (i + 1))) for i in range(20)
    ]
    doc["items"][cid]["requests"] = sorted(stamps)
    store.write_connections(db, doc, now=NOW)
    before = _conn(db, cid)
    sent = len(fake.requests)
    _assert_fixed_error(
        client.post(f"{BASE}/{cid}/credentials", json={"access_url": NEW_ACCESS_URL}), 429, "quota_reached"
    )
    assert len(fake.requests) == sent
    assert _conn(db, cid) == before
    assert _password(db, cid) == PLANT_PASS


def test_a_pasted_credential_that_cannot_be_saved_keeps_the_old_one(client, db, fake, env):
    cid = _simplefin(client)["id"]
    before = _conn(db, cid)

    def broken(*args: Any, **kwargs: Any) -> None:
        raise ConnectorError("save_failed")

    env.setattr(store, "save_secret", broken)
    _assert_fixed_error(
        client.post(f"{BASE}/{cid}/credentials", json={"access_url": NEW_ACCESS_URL}), 500, "save_failed"
    )
    after = _conn(db, cid)
    assert {**after, "requests": before["requests"]} == before
    assert _password(db, cid) == PLANT_PASS


# --- privacy -----------------------------------------------------------------------


def test_nothing_logs_a_credential_or_provider_content(client, db, fake, caplog):
    for name in ("httpx", "httpcore", "src"):
        caplog.set_level(logging.DEBUG, logger=name)
    bodies: list[str] = []
    with caplog.at_level(logging.DEBUG):
        sf_detail = _simplefin(client)
        cid = sf_detail["id"]
        ak = _create(client, provider="akahu", user_token=USER_TOKEN, app_token=APP_TOKEN)
        bodies.append(ak.text)
        for resp in (
            client.get(BASE),
            client.get(f"{BASE}/{cid}"),
            client.put(f"{BASE}/{cid}", json={"accounts": {SF_CHK: {"label": "x"}}}),
            client.post(f"{BASE}/{cid}/accounts"),
            client.post(f"{BASE}/{cid}/sync"),
            client.post(f"{BASE}/{ak.json()['id']}/sync"),
        ):
            assert resp.status_code == 200, resp.text
            bodies.append(resp.text)
        fake.status = 401
        client.post(f"{BASE}/{cid}/sync")
        # A pasted credential the bridge refuses: verified first, never stored.
        bodies.append(client.post(f"{BASE}/{cid}/credentials", json={"access_url": NEW_ACCESS_URL}).text)
        fake.status = None
        bodies.append(client.post(f"{BASE}/{cid}/credentials", json={"access_url": NEW_ACCESS_URL}).text)
        client.post(f"{BASE}/{cid}/credentials", json={"setup_token": SETUP_TOKEN})
        client.post(f"{BASE}/{cid}/credentials", json={"access_url": "https://u:" + PLANT_PASS + "@evil.example.com/simplefin"})
    blob = caplog.text + " ".join(r.getMessage() for r in caplog.records)
    for event in (
        "connection_created",
        "connection_sync ",
        "connection_status_changed",
        "connection_accounts ",
        "connection_accounts_failed",
        "connection_credentials_replaced",
    ):
        assert event in blob, event
    for planted in SECRETS + CONTENT:
        assert planted not in blob, planted
    assert all(r.exc_info is None for r in caplog.records)
    for text in bodies:
        for secret in SECRETS:
            assert secret not in text


# --- source hygiene ----------------------------------------------------------------


def test_routes_and_service_have_no_em_dash():
    for rel in ("src/api/connections.py", "src/connectors/service.py", "tests/api/test_connections_api.py"):
        assert chr(0x2014) not in (ROOT / rel).read_text(encoding="utf-8"), rel


def test_the_service_reaches_the_database_only_through_the_store():
    tree = ast.parse((ROOT / "src" / "connectors" / "service.py").read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        names: list[str] = []
        if isinstance(node, ast.Import):
            names = [a.name for a in node.names]
        elif isinstance(node, ast.ImportFrom):
            names = [("." * node.level) + (node.module or "")]
        for name in names:
            assert "database" not in name and "services" not in name, name
            assert "sqlalchemy" not in name, name
        if isinstance(node, ast.Attribute):
            assert node.attr not in ("get_session", "get_setting", "set_setting"), node.attr


def test_routes_are_registered_static_first():
    paths = [
        (sorted(r.methods)[0], r.path)
        for r in app.routes
        if getattr(r, "path", "").startswith(BASE)
    ]
    assert paths == [
        ("GET", BASE),
        ("POST", BASE),
        ("GET", BASE + "/{connection_id}"),
        ("PUT", BASE + "/{connection_id}"),
        ("POST", BASE + "/{connection_id}/credentials"),
        ("POST", BASE + "/{connection_id}/accounts"),
        ("POST", BASE + "/{connection_id}/sync"),
        ("DELETE", BASE + "/{connection_id}"),
    ]
    assert json.dumps(paths)  # plain data


# --- review round 1: atomic saves, claim loss, time budget, lock --------------------


def test_an_account_the_sanitizer_drops_rolls_the_whole_update_back(client, db, fake, env):
    cid = _simplefin(client)["id"]
    before = _conn(db, cid)
    # Let a liability id with a control character past validation: the store's
    # sanitizer would then drop the whole account.
    env.setattr(store, "liability_exists", lambda db, lid: True)
    resp = client.put(
        f"{BASE}/{cid}",
        json={"label": "Renamed", "accounts": {SF_CHK: {"liability_id": "L\x011"}}},
    )
    _assert_fixed_error(resp, 500, "save_failed")
    assert _conn(db, cid) == before  # nothing was committed, not even the label


def test_a_refresh_waiting_on_an_update_does_not_cause_a_false_save_failed(
    client, db, fake, env
):
    cid = _simplefin(client)["id"]
    fake.extra_account = True
    real = store.liability_exists
    results: dict[str, Any] = {}

    def refresh() -> None:
        results["refresh"] = TestClient(app).post(f"{BASE}/{cid}/accounts")

    def slow_exists(db_: Any, lid: str) -> bool:
        # Runs inside the update's transaction, under the lock.
        worker = threading.Thread(target=refresh)
        results["worker"] = worker
        worker.start()
        time.sleep(0.2)
        assert "refresh" not in results  # still waiting on the lock
        return real(db_, lid)

    env.setattr(store, "liability_exists", slow_exists)
    resp = client.put(
        f"{BASE}/{cid}", json={"accounts": {SF_CARD: {"liability_id": LIABILITY_ID, "label": "Card"}}}
    )
    results["worker"].join(timeout=10)
    assert resp.status_code == 200, resp.text
    assert results["refresh"].status_code == 200, results["refresh"].text
    accounts = _accounts_by_id(client.get(f"{BASE}/{cid}").json())
    assert set(accounts) == {SF_CHK, SF_CARD, SF_NEW}
    assert accounts[SF_CARD]["label"] == "Card"
    assert accounts[SF_NEW]["role"] == "ignore"


def test_a_failed_save_after_a_good_claim_is_claim_not_saved(client, db, fake, env, caplog):
    def broken(*args: Any, **kwargs: Any) -> None:
        raise ConnectorError("save_failed")

    env.setattr(store, "save_secret", broken)
    with caplog.at_level(logging.DEBUG):
        resp = _create(client, provider="simplefin", setup_token=SETUP_TOKEN)
    _assert_fixed_error(resp, 500, "claim_not_saved")
    assert "new setup token" in resp.json()["detail"]
    assert [r.method for r in fake.requests] == ["POST"]  # the claim happened
    assert _doc(db)["items"] == {}
    errors = [r.getMessage() for r in caplog.records if r.levelno >= logging.ERROR]
    assert "connection_claim_not_saved" in errors
    for planted in SECRETS:
        assert planted not in caplog.text


def test_a_failed_save_without_a_claim_keeps_its_own_error(client, db, fake, env):
    def broken(*args: Any, **kwargs: Any) -> None:
        raise ConnectorError("save_failed")

    env.setattr(store, "save_secret", broken)
    _assert_fixed_error(
        _create(client, provider="simplefin", access_url=ACCESS_URL), 500, "save_failed"
    )


def test_a_reconnect_save_failure_after_a_claim_is_claim_not_saved(client, db, fake, env):
    cid = _simplefin(client)["id"]
    before = _conn(db, cid)

    def broken(*args: Any, **kwargs: Any) -> None:
        raise ConnectorError("save_failed")

    env.setattr(store, "save_secret", broken)
    _assert_fixed_error(
        client.post(f"{BASE}/{cid}/credentials", json={"setup_token": SETUP_TOKEN}),
        500,
        "claim_not_saved",
    )
    assert _conn(db, cid) == before


def test_a_claim_timeout_says_the_token_may_be_spent(client, db, fake, env):
    def slow(self: Any, client_: Any, setup: str) -> Any:
        raise ConnectorError("provider_timeout")

    env.setattr(sf.SimpleFinProvider, "claim", slow)
    resp = _create(client, provider="simplefin", setup_token=SETUP_TOKEN)
    _assert_fixed_error(resp, 504, "claim_timeout")
    assert "may have been used" in resp.json()["detail"]
    assert _doc(db)["items"] == {}


def test_too_little_time_after_the_lock_refuses_before_the_claim(client, db, fake, env):
    env.setattr(service, "_deadline", lambda: time.monotonic() + 5.0)
    _assert_fixed_error(
        _create(client, provider="simplefin", setup_token=SETUP_TOKEN), 503, "request_time_short"
    )
    assert fake.requests == []
    assert _doc(db)["items"] == {}


def test_too_little_time_refuses_sync_and_refresh_without_using_quota(client, db, fake, env):
    cid = _simplefin(client)["id"]
    before = _conn(db, cid)
    sent = len(fake.requests)
    env.setattr(service, "_deadline", lambda: time.monotonic() + 5.0)
    _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 503, "request_time_short")
    _assert_fixed_error(client.post(f"{BASE}/{cid}/accounts"), 503, "request_time_short")
    _assert_fixed_error(
        client.post(f"{BASE}/{cid}/credentials", json={"setup_token": SETUP_TOKEN}),
        503,
        "request_time_short",
    )
    assert len(fake.requests) == sent
    assert _conn(db, cid) == before


@pytest.mark.parametrize("existing", [0, 9])
def test_a_second_create_waits_on_the_lock_and_rechecks_the_limit(
    client, db, fake, env, existing
):
    for _ in range(existing):
        _created(client, provider="demo")
    real_check = store.check_key
    results: dict[str, Any] = {}

    def second() -> None:
        results["second"] = TestClient(app).post(
            BASE, json={"provider": "simplefin", "access_url": ACCESS_URL}
        )

    def slow_check(db_: Any, **kwargs: Any) -> None:
        if "worker" not in results:
            worker = threading.Thread(target=second)
            results["worker"] = worker
            worker.start()
            time.sleep(0.2)
            assert "second" not in results  # waiting on the lock
        real_check(db_, **kwargs)

    env.setattr(store, "check_key", slow_check)
    first = _create(client, provider="simplefin", access_url=ACCESS_URL)
    results["worker"].join(timeout=10)
    assert first.status_code == 200, first.text
    second_resp = results["second"]
    if existing == 0:
        assert second_resp.status_code == 200, second_resp.text
        assert first.json()["id"] != second_resp.json()["id"]
        assert len(_doc(db)["items"]) == 2
    else:
        # The waiting create counts again under the lock and finds 10.
        _assert_fixed_error(second_resp, 422, "connection_limit")
        assert len(_doc(db)["items"]) == 10


def test_status_changes_are_logged_only_when_the_status_changes(client, db, fake, caplog):
    cid = _simplefin(client)["id"]
    fake.status = 402
    with caplog.at_level(logging.INFO):
        for _ in range(2):
            _assert_fixed_error(client.post(f"{BASE}/{cid}/sync"), 409, "payment_required")
    changes = [r for r in caplog.records if r.getMessage().startswith("connection_status_changed")]
    assert len(changes) == 1
