"""Akahu personal app provider (design 2.2, 5.1, 8.1 to 8.3; plan Task A6).

Every request goes through ``httpx.MockTransport``; the connector conftest
makes any real name lookup or socket connect fail. The fixtures are synthetic,
written from Akahu's public docs (see the fixture README).
"""

from __future__ import annotations

import copy
import json
import logging
import re
import types
from collections.abc import Callable
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.connectors import akahu as ak
from src.connectors import http as http_mod
from src.connectors import registry
from src.connectors.akahu import AkahuProvider, parse_credentials
from src.connectors.errors import ConnectorError
from src.connectors.http import SafeClient
from src.connectors.limits import (
    AKAHU_PAGE_RESERVE_SECONDS,
    MAX_ACCOUNTS,
    MAX_AKAHU_PAGES,
    PROVIDER_CALL_SECONDS,
)
from src.connectors.normalize import account_key_for, to_statements
from src.connectors.types import (
    AccountRequest,
    AkahuCredentials,
    SimpleFinCredentials,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "akahu"
API = "https://api.akahu.io/v1"
USER_TOKEN = "user_token_PLANTEDuser0123456789abcdefXYZ"
APP_TOKEN = "app_token_PLANTEDapp0123456789abcdefXYZ"
TODAY = date(2026, 10, 4)
START = date(2026, 9, 1)
END = date(2026, 9, 30)

CHECK = "acc_exampleCheck0001"
SAVE = "acc_exampleSave0002"
CARD = "acc_exampleCard0003"
KIWI = "acc_exampleKiwi0004"
LOAN = "acc_exampleLoan0005"


def _load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _creds() -> AkahuCredentials:
    return AkahuCredentials(user_token=USER_TOKEN, app_token=APP_TOKEN)


def _req(
    account_id: str, since: date = START, kind: str = "checking"
) -> AccountRequest:
    return AccountRequest(
        provider_account_id=account_id,
        since=since,
        account_key=account_key_for("akahu", account_id),
        kind=kind,
    )


class Router:
    """Answers by path; records every request."""

    def __init__(
        self,
        accounts: Any = None,
        pages: list[Any] | None = None,
        *,
        accounts_status: int = 200,
        txn_status: dict[int, int] | None = None,
        txn_handler: Callable[[httpx.Request, int], httpx.Response] | None = None,
    ):
        self.requests: list[httpx.Request] = []
        self.accounts = _load("accounts.json") if accounts is None else accounts
        self.pages = (
            pages
            if pages is not None
            else [
                _load("transactions_page1.json"),
                _load("transactions_page2.json"),
            ]
        )
        self.accounts_status = accounts_status
        self.txn_status = txn_status or {}
        self.txn_handler = txn_handler
        self.txn_calls = 0

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/v1/accounts":
            if self.accounts_status != 200:
                return httpx.Response(
                    self.accounts_status, json={"success": False, "message": "no"}
                )
            return httpx.Response(200, json=self.accounts)
        if path == "/v1/transactions":
            index = self.txn_calls
            self.txn_calls += 1
            if self.txn_handler is not None:
                return self.txn_handler(request, index)
            if index in self.txn_status:
                return httpx.Response(
                    self.txn_status[index], json={"success": False, "message": "no"}
                )
            return httpx.Response(200, json=self.pages[index])
        return httpx.Response(404, json={"success": False})

    def txn_requests(self) -> list[httpx.Request]:
        return [r for r in self.requests if r.url.path == "/v1/transactions"]


def _client(router: Any) -> SafeClient:
    return SafeClient("akahu", transport=httpx.MockTransport(router))


def _err(info: pytest.ExceptionInfo[ConnectorError]) -> str:
    return info.value.error_type


@pytest.fixture(autouse=True)
def pinned_today(monkeypatch):
    monkeypatch.setattr(ak, "today", lambda: TODAY)
    return monkeypatch


def _fetch(router: Router, accounts: list[AccountRequest] | None = None, **kw: Any):
    start = kw.pop("start", START)
    end = kw.pop("end", END)
    with _client(router) as client:
        return AkahuProvider().fetch(
            client,
            _creds(),
            accounts or [_req(CHECK), _req(CARD, kind="credit_card")],
            start,
            end,
        )


def _by_id(result: Any) -> dict[str, Any]:
    return {a.provider_account_id: a for a in result.accounts}


# --- provider shape and registry -------------------------------------------------


def test_provider_attributes():
    p = AkahuProvider()
    assert p.id == "akahu"
    assert p.display_name == "Akahu"
    assert p.max_window_days == 90
    assert p.daily_request_budget == 48


def test_registry_returns_akahu_provider():
    assert isinstance(registry.get_provider("akahu"), AkahuProvider)


def test_claim_is_not_supported_and_makes_no_request():
    router = Router()
    with _client(router) as client, pytest.raises(ConnectorError) as info:
        AkahuProvider().claim(client, USER_TOKEN)
    assert _err(info) == "bad_request"
    assert router.requests == []


# --- credentials -----------------------------------------------------------------


def test_parse_credentials_accepts_both_tokens_and_hides_them():
    creds = parse_credentials("  " + USER_TOKEN + "\n", APP_TOKEN)
    assert isinstance(creds, AkahuCredentials)
    assert creds.user_token == USER_TOKEN
    assert creds.app_token == APP_TOKEN
    for text in (repr(creds), str(creds), f"{creds}", "%s" % (creds,)):
        assert text == "<credentials>"


BAD_TOKEN_PAIRS = [
    ("", APP_TOKEN),
    (USER_TOKEN, ""),
    ("   ", APP_TOKEN),
    (USER_TOKEN, USER_TOKEN),  # identical
    ("a" * 257, APP_TOKEN),  # over the length cap
    (USER_TOKEN, "a" * 257),
    ("user_token_abc def123", APP_TOKEN),
    ("user_token_abc\r\nX-Evil: 1", APP_TOKEN),
    (USER_TOKEN, "app_token_abc\ndef"),
    ("user_token_abc\u00e9def", APP_TOKEN),
    ("Bearer " + USER_TOKEN, APP_TOKEN),
    (USER_TOKEN, "app.token:abc"),
    (None, APP_TOKEN),
    (USER_TOKEN, 12345),
]
# The string pairs, which AkahuCredentials can hold directly.
BAD_STRING_PAIRS = [p for p in BAD_TOKEN_PAIRS if all(isinstance(x, str) for x in p)]


@pytest.mark.parametrize(
    ("user", "app"),
    [
        ("tok-" + "a" * 20, "id_" + "b" * 20),  # no Akahu prefix assumed
        (APP_TOKEN, USER_TOKEN),  # swapped is still two distinct valid shapes
        ("a" * 256, "b" * 256),  # at the length cap
        ("x", "y"),
    ],
)
def test_parse_credentials_accepts_any_prefix(user, app):
    creds = parse_credentials(user, app)
    assert (creds.user_token, creds.app_token) == (user, app)
    router = Router()
    with _client(router) as client:
        AkahuProvider().list_accounts(client, creds)
    assert router.requests[0].headers["Authorization"] == "Bearer " + user
    assert router.requests[0].headers["X-Akahu-Id"] == app


def test_identical_tokens_after_trimming_are_refused():
    with pytest.raises(ConnectorError) as info:
        parse_credentials(" " + USER_TOKEN, USER_TOKEN + "\n")
    assert _err(info) == "bad_request"


@pytest.mark.parametrize(("user", "app"), BAD_TOKEN_PAIRS)
def test_parse_credentials_refuses_bad_shapes(user, app):
    with pytest.raises(ConnectorError) as info:
        parse_credentials(user, app)
    assert _err(info) == "bad_request"
    assert info.value.__cause__ is None
    assert info.value.__context__ is None


@pytest.mark.parametrize(("user", "app"), BAD_STRING_PAIRS)
def test_bad_token_shapes_fail_before_any_request(user, app):
    creds = AkahuCredentials(user_token=user, app_token=app)
    router = Router()
    with _client(router) as client:
        with pytest.raises(ConnectorError) as info:
            AkahuProvider().list_accounts(client, creds)
        assert _err(info) == "bad_request"
        with pytest.raises(ConnectorError) as info:
            AkahuProvider().fetch(client, creds, [_req(CHECK)], START, END)
        assert _err(info) == "bad_request"
    assert router.requests == []


def test_other_provider_credentials_are_bad_request():
    creds = SimpleFinCredentials(
        base_url="https://beta-bridge.simplefin.org/simplefin",
        username="u",
        password="p",
    )
    router = Router()
    with _client(router) as client, pytest.raises(ConnectorError) as info:
        AkahuProvider().list_accounts(client, creds)
    assert _err(info) == "bad_request"
    assert router.requests == []


# --- headers and paths -----------------------------------------------------------


def test_every_request_carries_bearer_and_app_id_headers():
    router = Router()
    with _client(router) as client:
        AkahuProvider().list_accounts(client, _creds())
    _fetch(router)
    assert len(router.requests) == 4  # accounts; accounts + two pages
    for request in router.requests:
        assert request.method == "GET"
        assert request.headers["Authorization"] == "Bearer " + USER_TOKEN
        assert request.headers["X-Akahu-Id"] == APP_TOKEN
        assert request.url.host == "api.akahu.io"
        assert request.url.scheme == "https"
        assert not request.url.userinfo
        assert USER_TOKEN not in str(request.url)
        assert APP_TOKEN not in str(request.url)


_ALLOWED = re.compile(r"/v1/(?:accounts|transactions)")


def test_only_allowlisted_get_paths_and_never_pending_or_refresh():
    router = Router()
    with _client(router) as client:
        AkahuProvider().list_accounts(client, _creds())
    _fetch(router)
    for request in router.requests:
        assert request.method == "GET"
        assert _ALLOWED.fullmatch(request.url.path)
        assert "pending" not in str(request.url)
        assert "refresh" not in str(request.url)


def test_module_never_names_pending_refresh_or_write_endpoints():
    source = Path(ak.__file__).read_text(encoding="utf-8")
    code = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("#")
    )
    # Only the two GET collections appear as request paths.
    assert set(re.findall(r'"(/[a-z/]+)"', code)) <= {"/accounts", "/transactions"}
    for word in ("/pending", "/refresh", "/payments", "/transfers", "post_text"):
        assert word not in code


# --- list_accounts ---------------------------------------------------------------


def test_list_accounts_maps_fixture():
    router = Router()
    with _client(router) as client:
        result = AkahuProvider().list_accounts(client, _creds())
    assert [r.url.path for r in router.requests] == ["/v1/accounts"]
    assert not router.requests[0].url.query
    assert result.errors == []
    by_id = {a.provider_account_id: a for a in result.accounts}
    assert list(by_id) == [CHECK, SAVE, CARD, KIWI, LOAN]
    kinds = {k: a.kind_guess for k, a in by_id.items()}
    assert kinds == {
        CHECK: "checking",
        SAVE: "savings",
        CARD: "credit_card",
        KIWI: "unknown",
        LOAN: "loan",
    }
    check = by_id[CHECK]
    assert check.name == "Example Everyday"
    assert check.institution == "Example Bank NZ"
    assert check.currency == "NZD"
    assert check.balance == Decimal("1520.35")
    assert check.balance_date == date(2026, 10, 3)
    assert check.account_key == account_key_for("akahu", CHECK)
    assert by_id[CARD].institution == "Example Cards NZ"
    assert by_id[CARD].balance == Decimal("-432.1")  # raw; owed sign is A4's
    assert by_id[SAVE].balance == Decimal(8000)
    assert by_id[KIWI].balance_date is None  # no refreshed.balance
    assert by_id[LOAN].balance == Decimal(-250000)
    for acct in result.accounts:
        assert isinstance(acct.balance, Decimal)
        # The formatted account number is never kept.
        assert "00-0000" not in repr(acct)
        assert "00-0000" not in str(vars(acct))


@pytest.mark.parametrize(
    ("akahu_type", "kind"),
    [
        ("CHECKING", "checking"),
        ("SAVINGS", "savings"),
        ("CREDITCARD", "credit_card"),
        ("LOAN", "loan"),
        ("KIWISAVER", "unknown"),
        ("INVESTMENT", "unknown"),
        ("TERMDEPOSIT", "unknown"),
        ("FOREIGN", "unknown"),
        ("TAX", "unknown"),
        ("REWARDS", "unknown"),
        ("WALLET", "unknown"),
        (None, "unknown"),
        (7, "unknown"),
    ],
)
def test_account_types_map_per_design(akahu_type, kind):
    doc = _load("accounts.json")
    doc["items"] = [doc["items"][0]]
    doc["items"][0]["type"] = akahu_type
    with _client(Router(accounts=doc)) as client:
        result = AkahuProvider().list_accounts(client, _creds())
    assert result.accounts[0].kind_guess == kind


def test_list_accounts_keeps_inactive_accounts_and_flags_the_problem():
    with _client(Router(accounts=_load("inactive.json"))) as client:
        result = AkahuProvider().list_accounts(client, _creds())
    assert [a.provider_account_id for a in result.accounts] == [CHECK, CARD]
    assert result.errors == ["connector_account_error"]
    assert [a.error for a in result.accounts] == [None, "connector_account_error"]


def test_list_accounts_institution_cut_and_missing_connection():
    doc = _load("accounts.json")
    doc["items"][0]["connection"]["name"] = "B" * 500
    del doc["items"][1]["connection"]
    doc["items"][2]["connection"] = "not an object"
    with _client(Router(accounts=doc)) as client:
        result = AkahuProvider().list_accounts(client, _creds())
    accts = result.accounts
    assert accts[0].institution == "B" * 120
    assert accts[1].institution is None
    assert accts[2].institution is None


@pytest.mark.parametrize(
    "balance",
    [
        {"currency": "NZD", "current": "abc"},
        {"currency": "NZD", "current": 1e11},
        {"currency": "NZD", "current": True},
        {"currency": "NZD"},
        "not an object",
        None,
    ],
)
def test_unusable_balance_is_dropped_with_its_date(balance):
    doc = _load("accounts.json")
    doc["items"] = [doc["items"][0]]
    if balance is None:
        del doc["items"][0]["balance"]
    else:
        doc["items"][0]["balance"] = balance
    with _client(Router(accounts=doc)) as client:
        acct = AkahuProvider().list_accounts(client, _creds()).accounts[0]
    assert acct.balance is None
    assert acct.balance_date is None


def test_missing_currency_is_empty_for_the_mapping_to_flag():
    doc = _load("accounts.json")
    doc["items"] = [doc["items"][0]]
    del doc["items"][0]["balance"]["currency"]
    with _client(Router(accounts=doc)) as client:
        acct = AkahuProvider().list_accounts(client, _creds()).accounts[0]
    assert acct.currency == ""


def test_repeated_account_id_keeps_first():
    doc = _load("accounts.json")
    dup = copy.deepcopy(doc["items"][0])
    dup["name"] = "Second copy"
    doc["items"].append(dup)
    with _client(Router(accounts=doc)) as client:
        result = AkahuProvider().list_accounts(client, _creds())
    names = [a.name for a in result.accounts if a.provider_account_id == CHECK]
    assert names == ["Example Everyday"]


def _bad_accounts_docs() -> list[Any]:
    base = _load("accounts.json")
    too_many = copy.deepcopy(base)
    too_many["items"] = [
        {**copy.deepcopy(base["items"][0]), "_id": f"acc_many{i:04d}"}
        for i in range(MAX_ACCOUNTS + 1)
    ]
    no_id = copy.deepcopy(base)
    del no_id["items"][0]["_id"]
    bad_id = copy.deepcopy(base)
    bad_id["items"][0]["_id"] = 42
    long_id = copy.deepcopy(base)
    long_id["items"][0]["_id"] = "acc_" + "a" * 300
    failed = copy.deepcopy(base)
    failed["success"] = False
    not_list = copy.deepcopy(base)
    not_list["items"] = {"a": 1}
    item_not_obj = copy.deepcopy(base)
    item_not_obj["items"][0] = "x"
    return [
        too_many,
        no_id,
        bad_id,
        long_id,
        failed,
        not_list,
        item_not_obj,
        {"success": True},
        [],
        "text",
    ]


@pytest.mark.parametrize("doc", _bad_accounts_docs())
def test_list_accounts_structural_problems_are_bad_response(doc):
    with _client(Router(accounts=doc)) as client, pytest.raises(ConnectorError) as info:
        AkahuProvider().list_accounts(client, _creds())
    assert _err(info) == "provider_bad_response"


@pytest.mark.parametrize(
    ("status", "error_type"),
    [
        (401, "reconnect_needed"),
        (403, "reconnect_needed"),
        (429, "provider_rate_limited"),
        (500, "provider_unavailable"),
    ],
)
def test_list_accounts_status_mapping(status, error_type):
    with (
        _client(Router(accounts_status=status)) as client,
        pytest.raises(ConnectorError) as info,
    ):
        AkahuProvider().list_accounts(client, _creds())
    assert _err(info) == error_type


# --- fetch -----------------------------------------------------------------------


def test_fetch_follows_cursor_until_null():
    router = Router()
    result = _fetch(router)
    paths = [r.url.path for r in router.requests]
    assert paths == ["/v1/accounts", "/v1/transactions", "/v1/transactions"]
    first, second = router.txn_requests()
    assert dict(first.url.params) == {
        "start": "2026-08-31T23:59:59.999Z",
        "end": "2026-09-30T23:59:59.999Z",
    }
    assert dict(second.url.params) == {
        "start": "2026-08-31T23:59:59.999Z",
        "end": "2026-09-30T23:59:59.999Z",
        "cursor": "cursor_examplePage2",
    }
    assert result.pages == 2
    assert result.end is None
    assert result.errors == []
    by_id = _by_id(result)
    assert list(by_id) == [CHECK, CARD]  # unrequested KIWI rows are dropped
    check = by_id[CHECK]
    assert [t.id for t in check.transactions] == [
        "trans_example000001",
        "trans_example000002",
        "trans_example000005",
    ]
    assert [t.posted for t in check.transactions] == [
        date(2026, 9, 1),
        date(2026, 9, 2),
        date(2026, 9, 10),
    ]
    assert [t.amount for t in check.transactions] == [
        Decimal(3200),
        Decimal("-85.4"),
        Decimal("-142.17"),
    ]
    for txn in check.transactions:
        assert isinstance(txn.amount, Decimal)
        assert txn.payee is None
    assert check.transactions[1].description == "EXAMPLE GROCER WELLINGTON"
    assert check.currency == "NZD"
    assert check.balance == Decimal("1520.35")
    assert check.balance_date == date(2026, 10, 3)
    assert check.error is None
    assert check.warnings == []
    assert check.institution == "Example Bank NZ"
    card = by_id[CARD]
    assert card.institution == "Example Cards NZ"
    assert [t.amount for t in card.transactions] == [Decimal("-5.5"), Decimal("-39.99")]
    assert card.balance == Decimal("-432.1")


def test_fetch_requested_account_without_rows_still_returned():
    result = _fetch(Router(), [_req(SAVE, kind="savings")])
    acct = _by_id(result)[SAVE]
    assert acct.transactions == []
    assert acct.balance == Decimal(8000)
    assert acct.error is None


def test_fetch_uses_utc_day_boundaries_for_a_single_day():
    router = Router()
    _fetch(router, start=date(2026, 9, 2), end=date(2026, 9, 2))
    params = dict(router.txn_requests()[0].url.params)
    assert params["start"] == "2026-09-01T23:59:59.999Z"
    assert params["end"] == "2026-09-02T23:59:59.999Z"


def test_rows_outside_the_window_are_dropped():
    pages = [_load("transactions_page1.json"), _load("transactions_page2.json")]
    early = copy.deepcopy(pages[0]["items"][0])
    early["_id"] = "trans_early"
    early["date"] = "2026-08-31T23:59:59.000Z"
    late = copy.deepcopy(pages[0]["items"][0])
    late["_id"] = "trans_late"
    late["date"] = "2026-10-01T00:00:00.000Z"
    pages[1]["items"] += [early, late]
    result = _fetch(Router(pages=pages))
    ids = [t.id for t in _by_id(result)[CHECK].transactions]
    assert "trans_early" not in ids and "trans_late" not in ids
    assert _by_id(result)[CHECK].warnings == []


def test_dates_with_offsets_are_read_as_utc_dates():
    pages = [_load("transactions_page2.json")]
    row = pages[0]["items"][0]
    row["date"] = "2026-09-10T08:30:00+13:00"  # 2026-09-09T19:30Z
    result = _fetch(Router(pages=pages))
    assert _by_id(result)[CHECK].transactions[0].posted == date(2026, 9, 9)


@pytest.mark.parametrize(
    "patch",
    [
        {"amount": "abc"},
        {"amount": 1e11},
        {"amount": True},
        {"amount": None},
        {"_id": None},
        {"_id": 5},
        {"_id": "t" * 300},
        {"date": "yesterday"},
        {"date": None},
        {"date": "2026-09-10" + "x" * 100},
    ],
)
def test_unusable_rows_are_skipped_with_a_warning(patch):
    pages = [_load("transactions_page2.json")]
    pages[0]["items"][0].update(patch)
    result = _fetch(Router(pages=pages))
    check = _by_id(result)[CHECK]
    assert check.transactions == []
    assert check.warnings == ["rows_skipped"]
    assert [t.id for t in _by_id(result)[CARD].transactions] == ["trans_example000006"]


def test_row_without_account_is_ignored_and_bad_description_is_blank():
    pages = [_load("transactions_page2.json")]
    pages[0]["items"][0]["description"] = {"x": 1}
    orphan = copy.deepcopy(pages[0]["items"][1])
    orphan["_id"] = "trans_orphan"
    orphan["_account"] = None
    pages[0]["items"].append(orphan)
    result = _fetch(Router(pages=pages))
    assert _by_id(result)[CHECK].transactions[0].description == ""
    assert [t.id for t in _by_id(result)[CARD].transactions] == ["trans_example000006"]


def test_repeated_transaction_id_keeps_first():
    pages = [_load("transactions_page1.json"), _load("transactions_page2.json")]
    dup = copy.deepcopy(pages[0]["items"][0])
    dup["amount"] = 1
    pages[1]["items"].append(dup)
    result = _fetch(Router(pages=pages))
    rows = [t for t in _by_id(result)[CHECK].transactions if t.id == dup["_id"]]
    assert [t.amount for t in rows] == [Decimal(3200)]


def test_inactive_account_is_an_account_error_and_others_sync():
    router = Router(accounts=_load("inactive.json"))
    result = _fetch(router)
    by_id = _by_id(result)
    assert by_id[CARD].error == "connector_account_error"
    assert by_id[CARD].transactions == []
    assert by_id[CARD].balance is None
    assert by_id[CHECK].error is None
    assert len(by_id[CHECK].transactions) == 3
    assert result.errors == ["connector_account_error"]


def _with_status(status: Any, *, drop: bool = False) -> dict[str, Any]:
    """accounts.json with the checking account's status replaced or removed."""
    doc = _load("accounts.json")
    acct = next(a for a in doc["items"] if a["_id"] == CHECK)
    if drop:
        del acct["status"]
    else:
        acct["status"] = status
    return doc


UNKNOWN_STATUSES = [
    pytest.param(None, True, id="missing"),
    pytest.param(None, False, id="null"),
    pytest.param("PAUSED", False, id="unknown"),
    pytest.param("active", False, id="lowercase"),
    pytest.param("", False, id="empty"),
    pytest.param(1, False, id="number"),
    pytest.param(True, False, id="bool"),
]


@pytest.mark.parametrize(("status", "drop"), UNKNOWN_STATUSES)
def test_fetch_treats_any_status_but_active_as_an_account_error(status, drop):
    router = Router(accounts=_with_status(status, drop=drop))
    result = _fetch(router)
    by_id = _by_id(result)
    assert by_id[CHECK].error == "connector_account_error"
    assert by_id[CHECK].transactions == []
    assert by_id[CARD].error is None
    assert result.errors == ["connector_account_error"]


@pytest.mark.parametrize(("status", "drop"), UNKNOWN_STATUSES)
def test_list_accounts_flags_any_status_but_active(status, drop):
    with _client(Router(accounts=_with_status(status, drop=drop))) as client:
        result = AkahuProvider().list_accounts(client, _creds())
    assert result.errors == ["connector_account_error"]
    by_id = {a.provider_account_id: a for a in result.accounts}
    assert by_id[CHECK].error == "connector_account_error"
    assert by_id[CARD].error is None


def test_requested_account_missing_from_accounts_is_an_account_error():
    result = _fetch(Router(), [_req(CHECK), _req("acc_gone9999")])
    by_id = _by_id(result)
    assert by_id["acc_gone9999"].error == "connector_account_error"
    assert by_id["acc_gone9999"].transactions == []
    assert result.errors == ["connector_account_error"]


def test_all_requested_accounts_inactive_skips_transactions_call():
    router = Router(accounts=_load("inactive.json"))
    result = _fetch(router, [_req(CARD, kind="credit_card")])
    assert router.txn_requests() == []
    assert _by_id(result)[CARD].error == "connector_account_error"


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (date(2026, 7, 1), date(2026, 9, 30)),  # 92 days
        (date(2026, 9, 30), date(2026, 9, 1)),  # reversed
        (date(2026, 10, 1), date(2026, 10, 6)),  # ends after tomorrow
    ],
)
def test_bad_windows_raise_before_any_request(start, end):
    router = Router()
    with pytest.raises(ConnectorError) as info:
        _fetch(router, start=start, end=end)
    assert _err(info) == "window_too_long"
    assert router.requests == []


def test_ninety_day_window_and_tomorrow_are_allowed():
    router = Router()
    _fetch(router, start=TODAY - timedelta(days=88), end=TODAY + timedelta(days=1))
    assert router.txn_requests()


@pytest.mark.parametrize("count", [0, MAX_ACCOUNTS + 1])
def test_account_list_size_is_checked_before_any_request(count):
    router = Router()
    accounts = [_req(f"acc_n{i:04d}") for i in range(count)]
    with _client(router) as client, pytest.raises(ConnectorError) as info:
        AkahuProvider().fetch(client, _creds(), accounts, START, END)
    assert _err(info) == "bad_request"
    assert router.requests == []


@pytest.mark.parametrize(
    ("status", "error_type"),
    [
        (401, "reconnect_needed"),
        (403, "reconnect_needed"),
        (429, "provider_rate_limited"),
    ],
)
@pytest.mark.parametrize("failing_page", [0, 1])
def test_fetch_status_mapping_on_any_page(status, error_type, failing_page):
    router = Router(txn_status={failing_page: status})
    with pytest.raises(ConnectorError) as info:
        _fetch(router)
    assert _err(info) == error_type


def test_revoked_token_on_accounts_stops_before_transactions():
    router = Router(accounts_status=401)
    with pytest.raises(ConnectorError) as info:
        _fetch(router)
    assert _err(info) == "reconnect_needed"
    assert router.txn_requests() == []


def _page(items: list[Any], cursor: Any = None, **extra: Any) -> dict[str, Any]:
    return {"success": True, "items": items, "cursor": {"next": cursor}, **extra}


def _row(n: int, day: date, account: str = CHECK, amount: Any = -1) -> dict[str, Any]:
    return {
        "_id": f"trans_gen{n:06d}",
        "_account": account,
        "_connection": "conn_exampleBank0001",
        "date": day.isoformat() + "T00:00:00.000Z",
        "description": f"EXAMPLE SHOP {n}",
        "amount": amount,
        "type": "EFTPOS",
    }


def _endless(day_of: Callable[[int], date]):
    """A transactions handler that always has another page."""

    def handler(request: httpx.Request, index: int) -> httpx.Response:
        rows = [_row(index * 2 + k, day_of(index)) for k in range(2)]
        return httpx.Response(200, json=_page(rows, f"cursor_{index + 1}"))

    return handler


def test_page_cap_sets_partial_and_moves_end_back_to_last_complete_day():
    # Page i holds rows dated START + i days, so page 20 is START + 19 days.
    router = Router(txn_handler=_endless(lambda i: START + timedelta(days=i)))
    result = _fetch(router)
    assert len(router.txn_requests()) == MAX_AKAHU_PAGES
    assert result.pages == MAX_AKAHU_PAGES
    last_seen = START + timedelta(days=MAX_AKAHU_PAGES - 1)
    assert result.end == last_seen - timedelta(days=1)
    assert "connector_partial" in result.errors
    check = _by_id(result)[CHECK]
    # Per-account warnings stay free of it: the mapping adds it from end.
    assert "connector_partial" not in check.warnings
    assert check.transactions
    assert max(t.posted for t in check.transactions) == result.end
    assert len(check.transactions) == 2 * (MAX_AKAHU_PAGES - 1)
    # The current balance belongs to today, not to the shortened window.
    assert check.balance is None
    assert check.balance_date is None
    # The cursor of the last page is never followed.
    assert "cursor_20" not in str(router.requests[-1].url)


def test_page_cap_with_newest_first_order_fails_closed():
    router = Router(txn_handler=_endless(lambda i: END - timedelta(days=i)))
    with pytest.raises(ConnectorError) as info:
        _fetch(router)
    assert _err(info) == "provider_bad_response"


def test_page_cap_within_a_single_day_fails_closed():
    router = Router(txn_handler=_endless(lambda i: START))
    with pytest.raises(ConnectorError) as info:
        _fetch(router)
    assert _err(info) == "provider_bad_response"


def test_exactly_twenty_pages_ending_with_null_cursor_is_complete():
    def handler(request: httpx.Request, index: int) -> httpx.Response:
        nxt = None if index == MAX_AKAHU_PAGES - 1 else f"cursor_{index + 1}"
        rows = [_row(index, START + timedelta(days=index))]
        return httpx.Response(200, json=_page(rows, nxt))

    result = _fetch(Router(txn_handler=handler))
    assert result.pages == MAX_AKAHU_PAGES
    assert result.end is None
    assert "connector_partial" not in result.errors



def test_running_out_of_time_between_pages_returns_a_partial_window(monkeypatch):
    """A 20-page fetch where each page takes 2 s against the 25 s overall
    deadline stops early the way the page cap does (design 8.1)."""
    now = [0.0]
    monkeypatch.setattr(http_mod, "time", types.SimpleNamespace(monotonic=lambda: now[0]))

    def handler(request: httpx.Request, index: int) -> httpx.Response:
        now[0] += 2.0
        nxt = None if index == MAX_AKAHU_PAGES - 1 else f"cursor_{index + 1}"
        rows = [_row(index * 2 + k, START + timedelta(days=index)) for k in range(2)]
        return httpx.Response(200, json=_page(rows, nxt))

    router = Router(txn_handler=handler)
    transport = httpx.MockTransport(router)
    with SafeClient(
        "akahu", transport=transport, deadline=now[0] + PROVIDER_CALL_SECONDS
    ) as client:
        result = AkahuProvider().fetch(
            client, _creds(), [_req(CHECK), _req(CARD, kind="credit_card")], START, END
        )
    # Pages stop once fewer than AKAHU_PAGE_RESERVE_SECONDS are left.
    expected = 0
    while PROVIDER_CALL_SECONDS - 2.0 * expected >= AKAHU_PAGE_RESERVE_SECONDS:
        expected += 1
    assert 1 < expected < MAX_AKAHU_PAGES
    assert len(router.txn_requests()) == expected
    assert result.pages == expected
    last_seen = START + timedelta(days=expected - 1)
    assert result.end == last_seen - timedelta(days=1)
    assert "connector_partial" in result.errors
    check = _by_id(result)[CHECK]
    assert max(t.posted for t in check.transactions) == result.end
    assert check.balance is None and check.balance_date is None
    assert now[0] < PROVIDER_CALL_SECONDS


def test_without_a_deadline_every_page_is_read(monkeypatch):
    def handler(request: httpx.Request, index: int) -> httpx.Response:
        nxt = None if index == MAX_AKAHU_PAGES - 1 else f"cursor_{index + 1}"
        rows = [_row(index, START + timedelta(days=index))]
        return httpx.Response(200, json=_page(rows, nxt))

    result = _fetch(Router(txn_handler=handler))
    assert result.pages == MAX_AKAHU_PAGES
    assert "connector_partial" not in result.errors

def test_repeated_cursor_is_bad_response():
    def handler(request: httpx.Request, index: int) -> httpx.Response:
        return httpx.Response(200, json=_page([_row(index, START)], "cursor_same"))

    router = Router(txn_handler=handler)
    with pytest.raises(ConnectorError) as info:
        _fetch(router)
    assert _err(info) == "provider_bad_response"
    assert len(router.txn_requests()) == 2


@pytest.mark.parametrize(
    "page",
    [
        {"success": False, "items": []},
        {"success": True},
        {"success": True, "items": "x"},
        {"success": True, "items": ["x"]},
        {"success": True, "items": [], "cursor": "x"},
        {"success": True, "items": [], "cursor": {"next": 5}},
        {"success": True, "items": [], "cursor": {"next": ""}},
        {"success": True, "items": [], "cursor": {"next": "c" * 5000}},
        [],
    ],
)
def test_transaction_page_structure_problems_are_bad_response(page):
    with pytest.raises(ConnectorError) as info:
        _fetch(Router(pages=[page]))
    assert _err(info) == "provider_bad_response"


def test_missing_cursor_object_ends_pagination():
    page = _load("transactions_page2.json")
    del page["cursor"]
    router = Router(pages=[page])
    result = _fetch(router)
    assert len(router.txn_requests()) == 1
    assert result.pages == 1


def test_too_many_items_on_one_page_is_bad_response(monkeypatch):
    monkeypatch.setattr(ak, "MAX_ITEMS_PER_PAGE", 3)
    with pytest.raises(ConnectorError) as info:
        _fetch(Router())  # page 1 has 4 items
    assert _err(info) == "provider_bad_response"


def test_too_many_rows_for_one_account_is_bad_response(monkeypatch):
    monkeypatch.setattr(ak, "MAX_TXNS_PER_ACCOUNT", 2)
    with pytest.raises(ConnectorError) as info:
        _fetch(Router())  # CHECK has 3 rows across the pages
    assert _err(info) == "provider_bad_response"


# --- logs ------------------------------------------------------------------------


def test_no_secret_or_content_in_logs_at_debug(caplog):
    caplog.set_level(logging.DEBUG)
    for name in ("httpx", "httpcore", "src.connectors"):
        logging.getLogger(name).setLevel(logging.DEBUG)
    accounts = _load("accounts.json")
    accounts["items"][0]["name"] = "PlantedAccountName"
    accounts["items"][0]["connection"]["name"] = "PlantedInstitution"
    pages = [_load("transactions_page2.json")]
    pages[0]["items"][0]["description"] = "PLANTED MERCHANT 4242"
    pages[0]["items"][0]["amount"] = -987.65
    router = Router(accounts=accounts, pages=pages)
    with _client(router) as client:
        AkahuProvider().list_accounts(client, _creds())
    _fetch(router)
    with pytest.raises(ConnectorError):
        _fetch(Router(txn_status={0: 401}))
    text = "\n".join(
        r.getMessage() + " " + repr(r.args) + " " + repr(r.__dict__)
        for r in caplog.records
    )
    for planted in (
        USER_TOKEN,
        APP_TOKEN,
        "PLANTEDuser",
        "PLANTEDapp",
        "PlantedAccountName",
        "PlantedInstitution",
        "PLANTED MERCHANT",
        "987.65",
        CHECK,
    ):
        assert planted not in text


def test_errors_carry_no_provider_text():
    router = Router(txn_status={0: 401})
    with pytest.raises(ConnectorError) as info:
        _fetch(router)
    assert USER_TOKEN not in str(info.value)
    assert info.value.__cause__ is None
    assert info.value.__context__ is None


# --- fixture hygiene -------------------------------------------------------------


FIXTURE_FILES = {
    "README.md",
    "accounts.json",
    "inactive.json",
    "transactions_page1.json",
    "transactions_page2.json",
}


def test_fixture_set_is_exact_and_carries_no_tokens():
    assert {p.name for p in FIXTURES.iterdir()} == FIXTURE_FILES
    for path in FIXTURES.iterdir():
        text = path.read_text(encoding="utf-8")
        if path.suffix == ".json":
            json.loads(text)
        assert "\u2014" not in text
        assert "user_token" not in text
        assert "app_token" not in text
        assert "Bearer" not in text
        assert not re.search(r"[A-Za-z0-9+/=_-]{41,}", text)
        for match in re.findall(r"acc_[A-Za-z0-9]+", text):
            assert match.startswith("acc_example")


# --- through the mapping ---------------------------------------------------------


_NOW = datetime(2026, 10, 4, 12, 0, tzinfo=timezone.utc)
_CONTEXT: dict[str, Any] = {"rules": [], "categories": []}


def test_fetch_result_maps_to_statements():
    reqs = [_req(CHECK), _req(CARD, kind="credit_card")]
    result = _fetch(Router(), reqs)
    out = to_statements("akahu", result, reqs, (START, END), _CONTEXT, now=_NOW)
    assert len(out) == 2
    by_key = {s["account"]["key"]: s for s in out}
    check = by_key[account_key_for("akahu", CHECK)]
    assert check["parser"] == "connector:akahu"
    assert check["file_name"] == "Akahu sync 2026-09-30"
    assert check["account"]["institution"] == "Example Bank NZ"
    assert check["account"]["last4"] is None
    assert [t["external_id"] for t in check["transactions"]] == [
        "akahu:trans_example000001",
        "akahu:trans_example000002",
        "akahu:trans_example000005",
    ]
    card = by_key[account_key_for("akahu", CARD)]
    # Akahu reports an owed card balance as negative; the holder owes 432.10.
    assert card["closing_balance"]["amount"] == pytest.approx(432.1)
    assert "connector_partial" not in check["warnings"]


def test_partial_fetch_maps_to_one_partial_warning():
    router = Router(txn_handler=_endless(lambda i: START + timedelta(days=i)))
    reqs = [_req(CHECK)]
    result = _fetch(router, reqs)
    out = to_statements("akahu", result, reqs, (START, END), _CONTEXT, now=_NOW)
    assert len(out) == 1
    stmt = out[0]
    assert stmt["warnings"].count("connector_partial") == 1
    assert stmt["period"]["end"] == result.end.isoformat()
    assert stmt["file_name"] == f"Akahu sync {result.end.isoformat()}"
    assert stmt["closing_balance"] is None
