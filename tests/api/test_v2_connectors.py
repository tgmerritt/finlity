"""Stateless v2 connector routes (design 6.1, 8.2, 8.4; plan Task A7).

Every provider request goes through ``httpx.MockTransport`` injected with the
route's transport factory dependency. Name resolution and socket connects fail
loudly here too, as in ``tests/connectors/conftest.py``.
"""

from __future__ import annotations

import base64
import json
import logging
import socket
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote

import httpx
import pytest
from fastapi.testclient import TestClient

from src.api.v2 import connectors as api
from src.api.smart_import import ApplyRequest, ApplyStatement
from src.connectors import quota
from src.connectors import simplefin as sf
from src.connectors.limits import PROVIDER_CALL_SECONDS
from src.connectors.normalize import account_key_for
from src.connectors.simplefin import parse_access_url
from src.liabilities import clock
from src.main import app
from src.services.rate_limiter import reset_rate_limiter
from src.smart_import.normalize import merchant_key
from tests.connectors.apply_contract import as_apply
from tests.smart_import.db_guard import forbid_database

TODAY = date(2026, 10, 4)
STATUS = "/api/v2/connectors/status"
CLAIM = "/api/v2/connectors/simplefin/claim"

PLANT_USER = "zqplanteduser"
PLANT_PASS = "Zq9PlantedPassw0rd"
ACCESS_URL = f"https://{PLANT_USER}:{PLANT_PASS}@beta-bridge.simplefin.org/simplefin"
CLAIM_URL = "https://beta-bridge.simplefin.org/simplefin/claim/ZQPLANTEDCLAIM123"
SETUP_TOKEN = base64.b64encode(CLAIM_URL.encode()).decode()
USER_TOKEN = "user_token_ZqPlantedUser123"
APP_TOKEN = "app_token_ZqPlantedApp456"
PLANT_NAME = "ZQ Planted Account"
PLANT_INST = "ZQ Planted Bank"
PLANT_MERCHANT = "ZQXPLANTED WIDGETS"
PLANT_AMOUNT = "7777.77"
SECRETS = (
    PLANT_USER,
    PLANT_PASS,
    USER_TOKEN,
    APP_TOKEN,
    "ZQPLANTEDCLAIM123",
    SETUP_TOKEN,
)
CONTENT = (PLANT_NAME, PLANT_INST, PLANT_MERCHANT, PLANT_AMOUNT)

SF_ACCOUNT = "ACT-PLANTED-1"
AK_ACCOUNT = "acc_planted0001"
START = TODAY - timedelta(days=29)


def _ts(day: date) -> int:
    return int(
        datetime(day.year, day.month, day.day, 12, tzinfo=timezone.utc).timestamp()
    )


# --- network guard and environment ----------------------------------------------


def _no_network(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("a connector API test tried to use the network")


@pytest.fixture(autouse=True)
def no_network(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(socket, "getaddrinfo", _no_network)
    monkeypatch.setattr(socket, "create_connection", _no_network)


@pytest.fixture(autouse=True)
def env(monkeypatch: pytest.MonkeyPatch):
    for name in (
        "DYNO",
        "MULTI_USER_MODE",
        "PROTECT_DEMO_DATA",
        "CONNECTORS_ENABLED",
        "CONNECTORS_SIMPLEFIN_EXTRA_HOSTS",
        "TRUSTED_PROXY_COUNT",
        "RATE_LIMIT_ENABLED",
        "RATE_LIMIT_SECRET_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(clock, "today", lambda: TODAY)
    monkeypatch.setattr(sf, "today", lambda: TODAY)
    monkeypatch.setattr(api, "_QUOTA", quota.ProcessQuota())
    # The limiter singleton reads the environment once; start and end clean.
    reset_rate_limiter()
    yield monkeypatch
    monkeypatch.undo()
    reset_rate_limiter()


def _limiter_on(env: pytest.MonkeyPatch) -> None:
    """An active rate limiter: the Heroku prerequisite for real providers."""
    env.setenv("RATE_LIMIT_ENABLED", "true")
    env.setenv("RATE_LIMIT_SECRET_KEY", "r" * 40)
    reset_rate_limiter()


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


# --- fake providers -------------------------------------------------------------


class Fake:
    """A MockTransport handler standing in for the bridge and Akahu."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []
        self.status: int | None = None
        self.errors: list[Any] = []
        self.claim_body = ACCESS_URL
        self.errlist: list[Any] = []
        self.akahu_status: Any = "ACTIVE"

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        if self.status is not None:
            return httpx.Response(self.status, json={})
        host = request.url.host
        path = request.url.path
        if host.endswith("simplefin.org"):
            if request.method == "POST" and "/claim/" in path:
                return httpx.Response(200, text=self.claim_body)
            if path.endswith("/accounts"):
                balances_only = request.url.params.get("balances-only") == "1"
                return httpx.Response(200, json=self._simplefin(balances_only))
        if host == "api.akahu.io":
            if path == "/v1/accounts":
                return httpx.Response(200, json=self._akahu_accounts())
            if path == "/v1/transactions":
                return httpx.Response(200, json=self._akahu_txns())
        return httpx.Response(404, json={})

    def _simplefin(self, balances_only: bool) -> dict[str, Any]:
        acct: dict[str, Any] = {
            "id": SF_ACCOUNT,
            "name": PLANT_NAME,
            "conn_id": "CON-PLANTED",
            "currency": "USD",
            "balance": "1234.56",
            "balance-date": _ts(TODAY),
        }
        if not balances_only:
            acct["transactions"] = [
                {
                    "id": "T-PLANT-1",
                    "posted": _ts(TODAY - timedelta(days=3)),
                    "amount": f"-{PLANT_AMOUNT}",
                    "description": PLANT_MERCHANT,
                    "payee": PLANT_MERCHANT,
                },
                {
                    "id": "T-PLANT-2",
                    "posted": _ts(TODAY - timedelta(days=2)),
                    "amount": "-42.00",
                    "description": "Grocery store",
                    "payee": "Grocery store",
                },
            ]
        doc: dict[str, Any] = {
            "errlist": list(self.errlist),
            "connections": [{"conn_id": "CON-PLANTED", "name": PLANT_INST}],
            "accounts": [acct],
        }
        if self.errors:
            doc["errors"] = list(self.errors)
        return doc

    def _akahu_accounts(self) -> dict[str, Any]:
        return {
            "success": True,
            "items": [
                {
                    "_id": AK_ACCOUNT,
                    "connection": {"_id": "conn_planted01", "name": PLANT_INST},
                    "name": PLANT_NAME,
                    "status": self.akahu_status,
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
                    "_id": "trans_planted01",
                    "_account": AK_ACCOUNT,
                    "date": f"{day}T00:00:00.000Z",
                    "description": PLANT_MERCHANT,
                    "amount": -7777.77,
                }
            ],
            "cursor": {"next": None},
        }


@pytest.fixture
def fake():
    handler = Fake()
    app.dependency_overrides[api.transport_factory] = lambda: (
        lambda provider_id: httpx.MockTransport(handler)
    )
    try:
        yield handler
    finally:
        app.dependency_overrides.pop(api.transport_factory, None)


# --- helpers --------------------------------------------------------------------


def _creds(provider: str) -> dict[str, str]:
    if provider == "simplefin":
        return {"access_url": ACCESS_URL}
    if provider == "akahu":
        return {"user_token": USER_TOKEN, "app_token": APP_TOKEN}
    return {}


def _account(provider: str, **over: Any) -> dict[str, Any]:
    ids = {"simplefin": SF_ACCOUNT, "akahu": AK_ACCOUNT, "demo": "demo-chk"}
    pid = ids[provider]
    body = {
        "provider_account_id": pid,
        "since": START.isoformat(),
        "account_key": account_key_for(provider, pid),
        "kind": "checking",
        "flip_balance": False,
    }
    body.update(over)
    return body


def _sync_body(provider: str, **over: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "credentials": _creds(provider),
        "start": START.isoformat(),
        "end": TODAY.isoformat(),
        "accounts": [_account(provider)],
        "context": {"rules": [], "categories": []},
    }
    body.update(over)
    return body


def _sync(client, provider: str, **over: Any):
    return client.post(
        f"/api/v2/connectors/{provider}/sync", json=_sync_body(provider, **over)
    )


def _accounts(client, provider: str, creds: dict[str, str] | None = None):
    return client.post(
        f"/api/v2/connectors/{provider}/accounts",
        json={"credentials": _creds(provider) if creds is None else creds},
    )


def _assert_fixed_error(resp, status: int, error_type: str) -> None:
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert set(body) == {"error_type", "detail"}
    assert body["error_type"] == error_type
    for secret in SECRETS + CONTENT:
        assert secret not in resp.text


def _assert_no_secret(resp) -> None:
    for secret in SECRETS:
        assert secret not in resp.text
    assert "simplefin.org/simplefin" not in resp.text or resp.request.url.path == CLAIM


# --- status ---------------------------------------------------------------------


def test_status_on_a_single_user_server_enables_every_provider(client):
    resp = client.get(STATUS)
    assert resp.status_code == 200
    body = resp.json()
    assert body["enabled"] == ["simplefin", "akahu", "demo"]
    by_id = {p["id"]: p for p in body["providers"]}
    assert set(by_id) == {"simplefin", "akahu", "demo"}
    assert by_id["simplefin"]["enabled"] is True
    assert by_id["simplefin"]["daily_request_budget"] == 20
    assert by_id["akahu"]["daily_request_budget"] == 48
    assert by_id["demo"]["daily_request_budget"] is None
    assert by_id["simplefin"]["max_window_days"] == 90
    assert by_id["simplefin"]["allowed_hosts"] == [
        "beta-bridge.simplefin.org",
        "bridge.simplefin.org",
    ]
    assert by_id["akahu"]["allowed_hosts"] == ["api.akahu.io"]
    assert by_id["demo"]["allowed_hosts"] == []
    assert body["limits"] == {
        "max_window_days": 90,
        "max_windows_per_sync": 4,
        "max_accounts": 50,
        "max_connections": 10,
    }


@pytest.mark.parametrize("flag", ["DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA"])
def test_status_on_a_shared_deployment_needs_the_opt_in(client, env, flag):
    env.setenv(flag, "web.1" if flag == "DYNO" else "true")
    body = client.get(STATUS).json()
    assert body["enabled"] == ["demo"]
    assert {p["id"]: p["enabled"] for p in body["providers"]} == {
        "simplefin": False,
        "akahu": False,
        "demo": True,
    }
    env.setenv("CONNECTORS_ENABLED", "true")
    if flag == "DYNO":
        _limiter_on(env)
    assert client.get(STATUS).json()["enabled"] == ["simplefin", "akahu", "demo"]


def test_on_heroku_real_providers_also_need_the_rate_limiter(client, fake, env):
    env.setenv("DYNO", "web.1")
    env.setenv("CONNECTORS_ENABLED", "true")
    assert api.real_connectors_allowed() is False
    body = client.get(STATUS).json()
    assert body["enabled"] == ["demo"]
    assert {p["id"]: p["enabled"] for p in body["providers"]} == {
        "simplefin": False,
        "akahu": False,
        "demo": True,
    }
    for provider in ("simplefin", "akahu"):
        _assert_fixed_error(_sync(client, provider), 503, "connector_disabled")
        _assert_fixed_error(_accounts(client, provider), 503, "connector_disabled")
    _assert_fixed_error(
        client.post(CLAIM, json={"setup_token": SETUP_TOKEN}), 503, "connector_disabled"
    )
    assert fake.requests == []
    # The demo needs neither the opt-in nor the limiter.
    assert _sync(client, "demo").status_code == 200
    # A limiter key that is too short does not count as active.
    env.setenv("RATE_LIMIT_ENABLED", "true")
    env.setenv("RATE_LIMIT_SECRET_KEY", "short")
    reset_rate_limiter()
    assert client.get(STATUS).json()["enabled"] == ["demo"]
    _limiter_on(env)
    assert api.real_connectors_allowed() is True
    assert client.get(STATUS).json()["enabled"] == ["simplefin", "akahu", "demo"]
    assert _sync(client, "simplefin").status_code == 200


def test_an_active_limiter_alone_does_not_enable_real_providers(client, fake, env):
    env.setenv("DYNO", "web.1")
    _limiter_on(env)
    assert api.real_connectors_allowed() is False
    assert client.get(STATUS).json()["enabled"] == ["demo"]
    _assert_fixed_error(_sync(client, "simplefin"), 503, "connector_disabled")


@pytest.mark.parametrize("flag", ["MULTI_USER_MODE", "PROTECT_DEMO_DATA"])
def test_off_heroku_the_opt_in_is_enough(client, fake, env, flag):
    env.setenv(flag, "true")
    env.setenv("CONNECTORS_ENABLED", "true")
    assert api.real_connectors_allowed() is True
    assert client.get(STATUS).json()["enabled"] == ["simplefin", "akahu", "demo"]


def test_a_single_user_server_needs_neither(client, env):
    assert api.real_connectors_allowed() is True


def test_status_ignores_extra_hosts_on_a_shared_deployment(client, env):
    env.setenv("CONNECTORS_SIMPLEFIN_EXTRA_HOSTS", "sfin.example.org")
    hosts = {
        p["id"]: p["allowed_hosts"] for p in client.get(STATUS).json()["providers"]
    }
    assert "sfin.example.org" in hosts["simplefin"]
    env.setenv("DYNO", "web.1")
    hosts = {
        p["id"]: p["allowed_hosts"] for p in client.get(STATUS).json()["providers"]
    }
    assert "sfin.example.org" not in hosts["simplefin"]


# --- claim ----------------------------------------------------------------------


def test_claim_returns_the_access_url_once(client, fake):
    resp = client.post(CLAIM, json={"setup_token": SETUP_TOKEN})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"access_url": ACCESS_URL}
    assert "no-store" in resp.headers.get("cache-control", "")
    (request,) = fake.requests
    assert request.method == "POST"
    assert str(request.url) == CLAIM_URL


def test_claim_round_trips_a_password_that_needs_escaping(client, fake):
    password = "p@ss:w/rd%2F?#"
    fake.claim_body = f"https://{PLANT_USER}:{quote(password, safe='')}@bridge.simplefin.org/simplefin"
    resp = client.post(CLAIM, json={"setup_token": SETUP_TOKEN})
    assert resp.status_code == 200, resp.text
    creds = parse_access_url(resp.json()["access_url"])
    assert creds.username == PLANT_USER
    assert creds.password == password
    assert creds.base_url == "https://bridge.simplefin.org/simplefin"


def test_claim_refused_and_bad_tokens_use_the_catalog(client, fake):
    fake.status = 403
    _assert_fixed_error(
        client.post(CLAIM, json={"setup_token": SETUP_TOKEN}), 422, "claim_refused"
    )
    fake.status = None
    _assert_fixed_error(
        client.post(CLAIM, json={"setup_token": "not base64 !!"}),
        422,
        "bad_setup_token",
    )
    evil = base64.b64encode(b"https://evil.example.com/simplefin/claim/x").decode()
    _assert_fixed_error(
        client.post(CLAIM, json={"setup_token": evil}), 422, "bad_setup_token"
    )
    assert len(fake.requests) == 1


@pytest.mark.parametrize("flag", ["DYNO", "MULTI_USER_MODE"])
def test_claim_is_disabled_on_a_shared_deployment_without_the_flag(
    client, fake, env, flag
):
    env.setenv(flag, "web.1" if flag == "DYNO" else "true")
    _assert_fixed_error(
        client.post(CLAIM, json={"setup_token": SETUP_TOKEN}), 503, "connector_disabled"
    )
    assert fake.requests == []
    env.setenv("CONNECTORS_ENABLED", "true")
    if flag == "DYNO":
        _limiter_on(env)
    assert client.post(CLAIM, json={"setup_token": SETUP_TOKEN}).status_code == 200


# --- accounts -------------------------------------------------------------------


def test_simplefin_accounts(client, fake):
    resp = _accounts(client, "simplefin")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["errors"] == []
    (acct,) = body["accounts"]
    assert acct == {
        "provider_account_id": SF_ACCOUNT,
        "name": PLANT_NAME,
        "institution": PLANT_INST,
        "currency": "USD",
        "balance": 1234.56,
        "balance_date": TODAY.isoformat(),
        "kind_guess": "checking",
        "account_key": account_key_for("simplefin", SF_ACCOUNT),
        "error": None,
    }
    (request,) = fake.requests
    assert request.url.params.get("balances-only") == "1"
    assert request.headers["authorization"].startswith("Basic ")
    assert PLANT_PASS not in str(request.url)
    _assert_no_secret(resp)


def test_akahu_accounts(client, fake):
    resp = _accounts(client, "akahu")
    assert resp.status_code == 200, resp.text
    (acct,) = resp.json()["accounts"]
    assert acct["provider_account_id"] == AK_ACCOUNT
    assert acct["kind_guess"] == "checking"
    assert acct["currency"] == "NZD"
    (request,) = fake.requests
    assert request.headers["X-Akahu-Id"] == APP_TOKEN
    _assert_no_secret(resp)


def test_a_simplefin_errlist_account_carries_its_error_code(client, fake):
    fake.errlist = [
        {"code": "act.failed", "msg": PLANT_NAME, "account_id": SF_ACCOUNT}
    ]
    resp = _accounts(client, "simplefin")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["errors"] == ["connector_account_error"]
    (acct,) = body["accounts"]
    assert acct["error"] == "connector_account_error"
    assert "act.failed" not in resp.text


@pytest.mark.parametrize("status", ["INACTIVE", None, "SOMETHING_NEW"])
def test_an_akahu_account_that_is_not_active_carries_its_error_code(
    client, fake, status
):
    fake.akahu_status = status
    body = _accounts(client, "akahu").json()
    assert body["errors"] == ["connector_account_error"]
    (acct,) = body["accounts"]
    assert acct["error"] == "connector_account_error"


def test_an_active_akahu_account_has_no_error(client, fake):
    (acct,) = _accounts(client, "akahu").json()["accounts"]
    assert acct["error"] is None


def test_demo_accounts_work_on_a_shared_deployment(client, env):
    env.setenv("DYNO", "web.1")
    resp = _accounts(client, "demo")
    assert resp.status_code == 200, resp.text
    ids = [a["provider_account_id"] for a in resp.json()["accounts"]]
    assert ids == ["demo-chk", "demo-card"]


@pytest.mark.parametrize(
    "provider,creds",
    [
        ("simplefin", {}),
        ("simplefin", {"user_token": USER_TOKEN, "app_token": APP_TOKEN}),
        ("simplefin", {"access_url": ACCESS_URL, "user_token": USER_TOKEN}),
        ("akahu", {"user_token": USER_TOKEN}),
        ("akahu", {"access_url": ACCESS_URL}),
        ("demo", {"access_url": ACCESS_URL}),
        ("akahu", {"user_token": "not a token!", "app_token": APP_TOKEN}),
        ("akahu", {"user_token": APP_TOKEN, "app_token": APP_TOKEN}),
    ],
)
def test_credentials_must_match_the_provider(client, fake, provider, creds):
    _assert_fixed_error(_accounts(client, provider, creds), 422, "bad_request")
    assert fake.requests == []


def test_an_access_url_off_the_allowlist_is_refused_before_any_call(client, fake):
    creds = {
        "access_url": f"https://{PLANT_USER}:{PLANT_PASS}@evil.example.com/simplefin"
    }
    _assert_fixed_error(_accounts(client, "simplefin", creds), 422, "host_not_allowed")
    assert fake.requests == []


# --- sync -----------------------------------------------------------------------


def test_simplefin_sync(client, fake):
    resp = _sync(client, "simplefin")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert set(body) == {"statements", "account_errors", "window"}
    assert body["account_errors"] == []
    assert body["window"] == {"start": START.isoformat(), "end": TODAY.isoformat()}
    (stmt,) = body["statements"]
    assert stmt["origin"] == "connector"
    assert stmt["parser"] == "connector:simplefin"
    assert stmt["account"]["key"] == account_key_for("simplefin", SF_ACCOUNT)
    assert len(stmt["transactions"]) == 2
    (request,) = fake.requests
    assert request.url.params.get("balances-only") is None
    assert request.url.params.get_list("account") == [SF_ACCOUNT]
    _assert_no_secret(resp)


def test_akahu_sync(client, fake):
    resp = _sync(client, "akahu")
    assert resp.status_code == 200, resp.text
    (stmt,) = resp.json()["statements"]
    assert stmt["parser"] == "connector:akahu"
    assert len(stmt["transactions"]) == 1
    _assert_no_secret(resp)


@pytest.mark.parametrize("provider", ["simplefin", "akahu", "demo"])
def test_sync_output_is_a_valid_apply_request(client, fake, provider):
    """The /sync statements, converted the way the wizard does, validate as
    an Apply request (the server-side half of the PR C wizard contract)."""
    resp = _sync(client, provider)
    assert resp.status_code == 200, resp.text
    statements = resp.json()["statements"]
    assert statements and all(st["transactions"] for st in statements)
    converted = [as_apply(st) for st in statements]
    for st in converted:
        ApplyStatement.model_validate(st)
        assert st["origin"] == "connector" and st["format"] == "connector"
        assert st["parser"] == f"connector:{provider}"
    ApplyRequest.model_validate({"batch_id": f"sync-{provider}", "statements": converted})
    keys = [t["dedupe_key"] for st in converted for t in st["transactions"]]
    assert len(keys) == len(set(keys))


def test_demo_sync_works_with_dyno_and_no_flag(client, env):
    env.setenv("DYNO", "web.1")
    resp = _sync(client, "demo")
    assert resp.status_code == 200, resp.text
    (stmt,) = resp.json()["statements"]
    assert stmt["parser"] == "connector:demo"
    assert stmt["transactions"]


@pytest.mark.parametrize("flag", ["DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA"])
@pytest.mark.parametrize("provider", ["simplefin", "akahu"])
def test_real_sync_is_disabled_on_a_shared_deployment(
    client, fake, env, flag, provider
):
    env.setenv(flag, "web.1" if flag == "DYNO" else "true")
    _assert_fixed_error(_sync(client, provider), 503, "connector_disabled")
    _assert_fixed_error(_accounts(client, provider), 503, "connector_disabled")
    assert fake.requests == []


def test_real_sync_on_a_shared_deployment_with_the_flag(client, fake, env):
    env.setenv("DYNO", "web.1")
    env.setenv("CONNECTORS_ENABLED", "true")
    _limiter_on(env)
    assert _sync(client, "simplefin").status_code == 200


@pytest.mark.parametrize(
    "start,end",
    [
        (TODAY - timedelta(days=90), TODAY),  # 91 days
        (TODAY, TODAY - timedelta(days=1)),  # start after end
        (TODAY + timedelta(days=1), TODAY + timedelta(days=2)),  # ends after tomorrow
    ],
)
@pytest.mark.parametrize("provider", ["simplefin", "demo"])
def test_window_rules(client, fake, provider, start, end):
    resp = _sync(client, provider, start=start.isoformat(), end=end.isoformat())
    _assert_fixed_error(resp, 422, "window_too_long")
    assert fake.requests == []


@pytest.mark.parametrize("provider", ["simplefin", "demo"])
def test_window_of_exactly_90_days_ending_tomorrow_is_allowed(client, fake, provider):
    end = TODAY + timedelta(days=1)
    start = end - timedelta(days=89)
    resp = _sync(
        client,
        provider,
        start=start.isoformat(),
        end=end.isoformat(),
        accounts=[_account(provider, since=start.isoformat())],
    )
    assert resp.status_code == 200, resp.text


def test_a_user_rule_wins_over_the_seed_rules(client, fake):
    categories = [
        {"id": "c-custom", "name": "My Widgets"},
        {"id": "c-groceries", "name": "Groceries"},
    ]
    key = merchant_key("Grocery store")
    rules = [{"merchant_key": key, "category_id": "c-custom"}]
    resp = _sync(
        client, "simplefin", context={"rules": rules, "categories": categories}
    )
    assert resp.status_code == 200, resp.text
    rows = resp.json()["statements"][0]["transactions"]
    grocery = next(r for r in rows if r["merchant_key"] == key)
    assert grocery["category_id"] == "c-custom"
    assert grocery["category_source"] == "rule"


def test_rules_as_a_mapping_are_accepted(client, fake):
    key = merchant_key("Grocery store")
    context = {
        "rules": {key: {"category_id": "c-custom"}},
        "categories": [{"id": "c-custom", "name": "My Widgets"}],
    }
    resp = _sync(client, "simplefin", context=context)
    assert resp.status_code == 200, resp.text
    rows = resp.json()["statements"][0]["transactions"]
    assert (
        next(r for r in rows if r["merchant_key"] == key)["category_id"] == "c-custom"
    )


def test_bad_context_is_a_fixed_error(client, fake):
    _assert_fixed_error(
        _sync(client, "simplefin", context={"rules": 5, "categories": []}),
        422,
        "bad_request",
    )
    _assert_fixed_error(
        _sync(client, "simplefin", context={"rules": [], "categories": [{"id": "x"}]}),
        422,
        "bad_request",
    )
    _assert_fixed_error(
        _sync(client, "simplefin", context={"rules": ["not a rule"], "categories": []}),
        422,
        "bad_request",
    )
    # Context problems are refused before any provider call, so none is counted.
    assert fake.requests == []


def test_account_errors_include_dropped_accounts_and_result_codes(client, fake):
    missing = _account(
        "simplefin",
        provider_account_id="ACT-NOT-RETURNED",
        account_key=account_key_for("simplefin", "ACT-NOT-RETURNED"),
    )
    resp = _sync(client, "simplefin", accounts=[_account("simplefin"), missing])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["account_errors"] == [
        {"provider_account_id": "ACT-NOT-RETURNED", "code": "connector_account_error"}
    ]
    assert len(body["statements"]) == 1


def test_a_general_provider_problem_is_reported_without_an_account(client, fake):
    fake.errors = ["Something about the bank. Please check."]
    body = _sync(client, "simplefin").json()
    assert body["account_errors"] == [
        {"provider_account_id": None, "code": "connector_account_error"}
    ]
    assert len(body["statements"]) == 1
    assert "Something about the bank" not in json.dumps(body)


def test_a_simplefin_rate_limit_warning_is_surfaced_and_data_kept(client, fake):
    fake.errors = ["You have exceeded the rate limit for this token."]
    body = _sync(client, "simplefin").json()
    assert {"provider_account_id": None, "code": "provider_rate_limited"} in body[
        "account_errors"
    ]
    assert len(body["statements"]) == 1
    accounts = _accounts(client, "simplefin").json()
    assert "provider_rate_limited" in accounts["errors"]


@pytest.mark.parametrize(
    "status,code,error_type",
    [
        (401, 409, "reconnect_needed"),
        (403, 409, "reconnect_needed"),
        (402, 409, "payment_required"),
        (429, 429, "provider_rate_limited"),
        (500, 502, "provider_unavailable"),
    ],
)
def test_provider_status_errors_use_the_catalog(client, fake, status, code, error_type):
    fake.status = status
    _assert_fixed_error(_sync(client, "simplefin"), code, error_type)
    _assert_fixed_error(_accounts(client, "simplefin"), code, error_type)


def test_an_unexpected_provider_exception_is_a_fixed_502(
    client, fake, monkeypatch, caplog
):
    def boom(self, *args, **kwargs):
        raise RuntimeError(f"boom {ACCESS_URL} {PLANT_MERCHANT}")

    monkeypatch.setattr(sf.SimpleFinProvider, "fetch", boom)
    with caplog.at_level(logging.DEBUG):
        resp = _sync(client, "simplefin")
    _assert_fixed_error(resp, 502, "provider_bad_response")
    blob = caplog.text + " ".join(r.getMessage() for r in caplog.records)
    assert "RuntimeError" in blob
    for secret in SECRETS + CONTENT:
        assert secret not in blob
    assert all(r.exc_info is None for r in caplog.records)



@pytest.mark.parametrize("call", ["accounts", "sync", "claim"])
def test_each_provider_call_runs_under_one_overall_deadline(
    client, fake, monkeypatch, call
):
    seen: list[float | None] = []
    real = api.SafeClient

    def spy(provider_id: str, **kwargs: Any) -> Any:
        seen.append(kwargs.get("deadline"))
        return real(provider_id, **kwargs)

    monkeypatch.setattr(api, "SafeClient", spy)
    before = api.time.monotonic()
    if call == "accounts":
        resp = _accounts(client, "akahu")
    elif call == "sync":
        resp = _sync(client, "akahu")
    else:
        resp = client.post(CLAIM, json={"setup_token": SETUP_TOKEN})
    after = api.time.monotonic()
    assert resp.status_code == 200, resp.text
    assert len(seen) == 1 and seen[0] is not None
    assert before + PROVIDER_CALL_SECONDS <= seen[0] <= after + PROVIDER_CALL_SECONDS

# --- quota backstop -------------------------------------------------------------


def test_the_21st_simplefin_call_for_one_credential_is_refused(client, fake):
    for _ in range(20):
        assert _sync(client, "simplefin").status_code == 200
    _assert_fixed_error(_sync(client, "simplefin"), 429, "quota_reached")
    _assert_fixed_error(_accounts(client, "simplefin"), 429, "quota_reached")
    assert len(fake.requests) == 20
    other = {
        "access_url": "https://otheruser:otherpass@beta-bridge.simplefin.org/simplefin"
    }
    assert _accounts(client, "simplefin", other).status_code == 200


def test_the_bridge_host_does_not_reset_the_quota(client, fake):
    for _ in range(20):
        assert _accounts(client, "simplefin").status_code == 200
    other_host = {"access_url": ACCESS_URL.replace("beta-bridge.", "bridge.")}
    _assert_fixed_error(
        _accounts(client, "simplefin", other_host), 429, "quota_reached"
    )


def test_a_claim_counts_against_the_claimed_credential(client, fake):
    assert client.post(CLAIM, json={"setup_token": SETUP_TOKEN}).status_code == 200
    for _ in range(19):
        assert _accounts(client, "simplefin").status_code == 200
    _assert_fixed_error(_accounts(client, "simplefin"), 429, "quota_reached")


def test_failed_provider_calls_count_too(client, fake):
    fake.status = 500
    for _ in range(20):
        assert _accounts(client, "simplefin").status_code == 502
    _assert_fixed_error(_accounts(client, "simplefin"), 429, "quota_reached")


def test_a_refused_request_makes_no_provider_call_and_is_not_counted(client, fake):
    for _ in range(25):
        _sync(client, "simplefin", start="2026-01-01", end=TODAY.isoformat())
    assert fake.requests == []
    assert _sync(client, "simplefin").status_code == 200


def test_demo_has_no_quota(client):
    for _ in range(25):
        assert _sync(client, "demo").status_code == 200


def test_the_quota_key_and_fingerprints_never_leave_the_server(client, fake, caplog):
    with caplog.at_level(logging.DEBUG):
        responses = [
            client.get(STATUS),
            client.post(CLAIM, json={"setup_token": SETUP_TOKEN}),
            _accounts(client, "simplefin"),
            _sync(client, "simplefin"),
        ]
    from src.connectors.simplefin import parse_access_url as parse

    fp = quota.fingerprint(parse(ACCESS_URL))
    assert fp is not None
    key_forms = (
        quota._KEY.hex(),
        base64.b64encode(quota._KEY).decode(),
        base64.urlsafe_b64encode(quota._KEY).decode().rstrip("="),
    )
    blob = caplog.text + " ".join(r.getMessage() for r in caplog.records)
    for resp in responses:
        assert resp.status_code == 200
        for form in (fp, *key_forms):
            assert form not in resp.text
            assert form not in str(dict(resp.headers))
    for form in (fp, *key_forms):
        assert form not in blob


# --- request bodies -------------------------------------------------------------


def _chunked(total: int):
    def body():
        yield b'{"setup_token": "'
        sent = 0
        piece = b"A" * (1024 * 1024)
        while sent < total:
            yield piece
            sent += len(piece)
        yield b'"}'

    return body()


def test_a_body_over_the_cap_is_request_too_large(client, fake):
    from src.api.v2.smart_import import MAX_JSON_BODY_BYTES

    resp = client.post(
        CLAIM,
        content=_chunked(MAX_JSON_BODY_BYTES + 1024 * 1024),
        headers={"content-type": "application/json"},
    )
    _assert_fixed_error(resp, 413, "request_too_large")
    assert fake.requests == []


@pytest.mark.parametrize(
    "path,body",
    [
        (CLAIM, {"setup_token": "A" * 5000}),
        (CLAIM, {"setup_token": SETUP_TOKEN, "extra": PLANT_PASS}),
        (CLAIM, {}),
        (
            "/api/v2/connectors/demo/accounts",
            {"credentials": {}, "planted": PLANT_PASS},
        ),
        (
            "/api/v2/connectors/simplefin/accounts",
            {"credentials": {"access_url": ACCESS_URL + "/" + "x" * 5000}},
        ),
        ("/api/v2/connectors/evil/sync", _sync_body("demo")),
        ("/api/v2/connectors/DEMO/sync", _sync_body("demo")),
        ("/api/v2/connectors/demo/sync", _sync_body("demo", accounts=[])),
        (
            "/api/v2/connectors/demo/sync",
            _sync_body("demo", accounts=[_account("demo")] * 51),
        ),
        (
            "/api/v2/connectors/demo/sync",
            _sync_body("demo", accounts=[_account("demo", kind="brokerage")]),
        ),
        (
            "/api/v2/connectors/demo/sync",
            _sync_body("demo", accounts=[_account("demo", account_key="bad key")]),
        ),
        (
            "/api/v2/connectors/demo/sync",
            _sync_body("demo", accounts=[_account("demo", flip_balance=PLANT_PASS)]),
        ),
        ("/api/v2/connectors/demo/sync", _sync_body("demo", start="not-a-date")),
        (
            "/api/v2/connectors/simplefin/sync",
            _sync_body("simplefin", context={"rules": [], "extra": PLANT_PASS}),
        ),
    ],
)
def test_validation_errors_are_bad_request_with_no_echo(client, fake, path, body):
    resp = client.post(path, json=body)
    _assert_fixed_error(resp, 422, "bad_request")
    assert "evil" not in resp.text and "brokerage" not in resp.text
    assert fake.requests == []


def test_an_oversized_context_is_bad_context(client, fake):
    rules = [
        {"merchant_key": f"M{i:06d}" + "X" * 100, "category_id": "c"}
        for i in range(3000)
    ]
    resp = _sync(client, "simplefin", context={"rules": rules, "categories": []})
    _assert_fixed_error(resp, 422, "bad_context")
    assert fake.requests == []


# --- privacy --------------------------------------------------------------------


def test_no_route_opens_a_database(client, fake, monkeypatch):
    forbid_database(monkeypatch)
    assert client.get(STATUS).status_code == 200
    assert client.post(CLAIM, json={"setup_token": SETUP_TOKEN}).status_code == 200
    for provider in ("simplefin", "akahu", "demo"):
        assert _accounts(client, provider).status_code == 200
        assert _sync(client, provider).status_code == 200


def test_caplog_carries_no_secret_or_content(client, fake):
    loggers = [
        "",
        "httpx",
        "httpcore",
        "httpcore.connection",
        "httpcore.http11",
        "src",
        "src.api.v2.connectors",
        "src.connectors",
    ]
    previous = {name: logging.getLogger(name).level for name in loggers}
    handler_records: list[logging.LogRecord] = []

    class Grab(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            handler_records.append(record)

    grab = Grab(level=logging.DEBUG)
    root = logging.getLogger()
    root.addHandler(grab)
    try:
        for name in loggers:
            logging.getLogger(name).setLevel(logging.DEBUG)
        client.get(STATUS)
        client.post(CLAIM, json={"setup_token": SETUP_TOKEN})
        for provider in ("simplefin", "akahu", "demo"):
            _accounts(client, provider)
            _sync(client, provider)
        fake.status = 403
        _sync(client, "simplefin")
        _accounts(client, "akahu")
        fake.status = 500
        _sync(client, "akahu")
        client.post(CLAIM, json={"setup_token": SETUP_TOKEN})
        fake.status = None
        _sync(client, "simplefin", start="2025-01-01")
    finally:
        root.removeHandler(grab)
        for name, level in previous.items():
            logging.getLogger(name).setLevel(level)
    assert handler_records, "the routes should log their events"
    texts = []
    for record in handler_records:
        texts.append(record.getMessage())
        texts.append(repr(record.args))
        assert record.exc_info is None
    blob = "\n".join(texts)
    assert "connector_sync" in blob
    for secret in SECRETS + CONTENT + ("simplefin.org/simplefin", "1234.56", "7777"):
        assert secret not in blob


def test_responses_never_contain_the_credential_except_claim(client, fake):
    responses = []
    for provider in ("simplefin", "akahu", "demo"):
        responses.append(_accounts(client, provider))
        responses.append(_sync(client, provider))
    for status in (401, 402, 429, 500):
        fake.status = status
        responses.append(_sync(client, "simplefin"))
        responses.append(_accounts(client, "akahu"))
    fake.status = None
    for resp in responses:
        _assert_no_secret(resp)
        assert ACCESS_URL not in resp.text
    claim = client.post(CLAIM, json={"setup_token": SETUP_TOKEN})
    assert claim.json() == {"access_url": ACCESS_URL}
    assert SETUP_TOKEN not in claim.text and "ZQPLANTEDCLAIM123" not in claim.text


def test_new_files_have_no_em_dash():
    root = Path(__file__).resolve().parents[2]
    for rel in (
        "src/api/v2/connectors.py",
        "src/connectors/quota.py",
        "tests/api/test_v2_connectors.py",
        "src/middleware/rate_limit.py",
    ):
        assert "\u2014" not in (root / rel).read_text(encoding="utf-8"), rel
