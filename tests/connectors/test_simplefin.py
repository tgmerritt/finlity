"""SimpleFIN provider (design 2.1, 5.1, 8.3; plan Task A3).

Every request goes through ``httpx.MockTransport``; the connector conftest
makes any real name lookup or socket connect fail.
"""

from __future__ import annotations

import base64
import copy
import json
import logging
import re
from datetime import date, datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.connectors import registry
from src.connectors import simplefin as sf
from src.connectors.errors import ConnectorError
from src.connectors.http import SafeClient
from src.connectors.limits import MAX_ACCOUNTS, MAX_TXNS_PER_ACCOUNT
from src.connectors.normalize import account_key_for, guess_kind
from src.connectors.simplefin import (
    SimpleFinProvider,
    decode_setup_token,
    parse_access_url,
)
from src.connectors.types import AccountRequest, SimpleFinCredentials

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "simplefin"
BASE = "https://beta-bridge.simplefin.org/simplefin"
CLAIM_URL = BASE + "/claim/DEMO-v2-0000TEST"
PASSWORD = "Pl4nted-Pa55word-xyz"
USER = "planteduser"
ACCESS_URL = f"https://{USER}:{PASSWORD}@beta-bridge.simplefin.org/simplefin"
TODAY = date(2026, 10, 4)


def _load(name: str) -> Any:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _token(url: str) -> str:
    return base64.b64encode(url.encode()).decode()


def _creds() -> SimpleFinCredentials:
    return SimpleFinCredentials(base_url=BASE, username=USER, password=PASSWORD)


class Recorder:
    def __init__(self, response: httpx.Response):
        self.requests: list[httpx.Request] = []
        self.response = response

    def __call__(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        return self.response


def _client(handler: Any) -> SafeClient:
    return SafeClient("simplefin", transport=httpx.MockTransport(handler))


def _json_client(doc: Any, status: int = 200) -> tuple[SafeClient, Recorder]:
    rec = Recorder(httpx.Response(status, json=doc))
    return _client(rec), rec


def _err(info: pytest.ExceptionInfo[ConnectorError]) -> str:
    return info.value.error_type


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    for name in (
        "DYNO",
        "MULTI_USER_MODE",
        "PROTECT_DEMO_DATA",
        "CONNECTORS_SIMPLEFIN_EXTRA_HOSTS",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setattr(sf, "today", lambda: TODAY)
    return monkeypatch


def _utc(ts: int) -> date:
    return datetime.fromtimestamp(ts, tz=timezone.utc).date()


# --- fixtures hygiene -----------------------------------------------------------


FIXTURE_FILES = {
    "README.md",
    "accounts_balances.json",
    "accounts_window.json",
    "card_account.json",
    "claim_ok.txt",
    "errlist.json",
    "errors_v1.json",
}
_URL_USERINFO = re.compile(r"://([^/\"\s]*)@")
_ANY_USERINFO = re.compile(r"[^\s\"'`/@:]+:[^\s\"'`/@]*@")
_BASE64_RUN = re.compile(r"[A-Za-z0-9+/=_-]{41,}")


def _fixture_texts() -> list[tuple[str, str]]:
    root = FIXTURES.parent
    out = []
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out.append(
                (path.relative_to(root).as_posix(), path.read_text(encoding="utf-8"))
            )
    return out


def test_connector_fixture_files_are_exactly_the_reviewed_set():
    names = {name for name, _ in _fixture_texts() if name.startswith("simplefin/")}
    assert names == {"simplefin/" + n for n in FIXTURE_FILES}


def test_fixtures_carry_no_credentials_or_em_dash():
    for name, text in _fixture_texts():
        if not name.startswith("simplefin/"):
            continue
        assert "\u2014" not in text, name
        if name.endswith(".json"):
            json.loads(text)
        # The only userinfo anywhere is the placeholder, with or without a scheme.
        for match in _URL_USERINFO.finditer(text):
            assert match.group(0) == "://user:pass@", name
        for match in _ANY_USERINFO.finditer(text):
            assert match.group(0) == "user:pass@", name
        assert "/claim/" not in text, name
        assert "DEMO-" not in text, name
        assert _BASE64_RUN.search(text) is None, name


# --- decode_setup_token ---------------------------------------------------------


def test_decode_setup_token_good():
    assert decode_setup_token(_token(CLAIM_URL)) == CLAIM_URL


def test_decode_setup_token_tolerates_pasted_whitespace():
    token = _token(CLAIM_URL)
    pasted = "  \n" + token[:20] + "\n" + token[20:] + " \t\n"
    assert decode_setup_token(pasted) == CLAIM_URL


@pytest.mark.parametrize(
    "token",
    [
        "",
        "   ",
        "not base64 !!!",
        "aGVsbG8",  # bad padding
        base64.b64encode(b"\xff\xfe\xfd").decode(),  # not UTF-8
        _token("hello world"),
        _token("http://beta-bridge.simplefin.org/simplefin/claim/X"),
        _token("https://evil.example.com/simplefin/claim/X"),
        _token("https://bridge.simplefin.org.evil.com/simplefin/claim/X"),
        _token("https://beta-bridge.simplefin.org:8443/simplefin/claim/X"),
        _token("https://u:p@beta-bridge.simplefin.org/simplefin/claim/X"),
        _token("https://beta-bridge.simplefin.org/other/claim/X"),
        _token("https://127.0.0.1/simplefin/claim/X"),
        _token("https://beta-bridge.simplefin.org/simplefin"),
        _token("https://beta-bridge.simplefin.org/simplefin/accounts"),
        _token("https://beta-bridge.simplefin.org/simplefin/claim/"),
    ],
)
def test_decode_setup_token_refuses(token):
    with pytest.raises(ConnectorError) as info:
        decode_setup_token(token)
    assert _err(info) == "bad_setup_token"


def test_decode_setup_token_size_cap():
    long_url = BASE + "/claim/" + "A" * 2048
    with pytest.raises(ConnectorError) as info:
        decode_setup_token(_token(long_url))
    assert _err(info) == "bad_setup_token"


@pytest.mark.parametrize("bad", [None, 12, b"abc"])
def test_decode_setup_token_non_string(bad):
    with pytest.raises(ConnectorError) as info:
        decode_setup_token(bad)  # type: ignore[arg-type]
    assert _err(info) == "bad_setup_token"


# --- parse_access_url -----------------------------------------------------------


def test_parse_access_url_splits_userinfo():
    creds = parse_access_url("  " + ACCESS_URL + "\n")
    assert isinstance(creds, SimpleFinCredentials)
    assert creds.base_url == BASE
    assert (creds.username, creds.password) == (USER, PASSWORD)
    assert PASSWORD not in repr(creds) and PASSWORD not in f"{creds}"


@pytest.mark.parametrize(
    "bad",
    [
        BASE,  # no userinfo
        "https://u:p@evil.example.com/simplefin",
        "http://u:p@beta-bridge.simplefin.org/simplefin",
        "https://u:p@beta-bridge.simplefin.org/other",
        "",
        None,
        "x" * 5000,
    ],
)
def test_parse_access_url_refuses(bad):
    with pytest.raises(ConnectorError) as info:
        parse_access_url(bad)  # type: ignore[arg-type]
    assert _err(info) == "host_not_allowed"


# --- claim ---------------------------------------------------------------------


def test_claim_posts_empty_body_and_returns_credentials():
    rec = Recorder(httpx.Response(200, text=(FIXTURES / "claim_ok.txt").read_text()))
    with _client(rec) as client:
        creds = SimpleFinProvider().claim(client, _token(CLAIM_URL))
    assert isinstance(creds, SimpleFinCredentials)
    assert creds.base_url == BASE
    assert (creds.username, creds.password) == ("user", "pass")
    assert len(rec.requests) == 1
    req = rec.requests[0]
    assert req.method == "POST"
    assert str(req.url) == CLAIM_URL
    assert req.content == b""


def test_claim_403_is_claim_refused():
    rec = Recorder(httpx.Response(403, text="Forbidden"))
    with _client(rec) as client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().claim(client, _token(CLAIM_URL))
    assert _err(info) == "claim_refused"


@pytest.mark.parametrize(
    "body",
    [
        "https://user:pass@evil.example.com/simplefin",
        "not a url at all",
        BASE,  # no userinfo
        "",
    ],
)
def test_claim_response_not_an_allowed_access_url(body):
    rec = Recorder(httpx.Response(200, text=body))
    with _client(rec) as client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().claim(client, _token(CLAIM_URL))
    assert _err(info) == "provider_bad_response"


def test_claim_bad_token_makes_no_request():
    rec = Recorder(httpx.Response(200, text=ACCESS_URL))
    with _client(rec) as client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().claim(
            client, _token("https://evil.example.com/simplefin/c")
        )
    assert _err(info) == "bad_setup_token"
    assert rec.requests == []


# --- list_accounts ---------------------------------------------------------------


def test_list_accounts_request_shape():
    client, rec = _json_client(_load("accounts_balances.json"))
    with client:
        SimpleFinProvider().list_accounts(client, _creds())
    assert len(rec.requests) == 1
    req = rec.requests[0]
    assert req.method == "GET"
    assert req.url.host == "beta-bridge.simplefin.org"
    assert req.url.path == "/simplefin/accounts"
    assert req.url.userinfo == b""
    assert req.url.params.get("balances-only") == "1"
    assert req.url.params.get("version") == "2"
    assert "pending" not in req.url.params
    assert "start-date" not in req.url.params
    expected = base64.b64encode(f"{USER}:{PASSWORD}".encode()).decode()
    assert req.headers["authorization"] == f"Basic {expected}"


def test_list_accounts_maps_recorded_demo():
    doc = _load("accounts_balances.json")
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert result.errors == []
    ids = [a.provider_account_id for a in result.accounts]
    assert ids == ["Demo Savings", "Demo Checking", "Demo Empty Account"]
    savings = result.accounts[0]
    assert savings.name == "SimpleFIN Savings"
    assert savings.institution == "SimpleFIN Demo"
    assert savings.currency == "USD"
    assert savings.balance == Decimal("114965.51")
    assert isinstance(savings.balance, Decimal)
    assert savings.balance_date == _utc(doc["accounts"][0]["balance-date"])
    assert savings.kind_guess == "savings"
    assert savings.account_key == account_key_for("simplefin", "Demo Savings")
    assert result.accounts[1].kind_guess == "checking"


def test_list_accounts_card_guess():
    client, _ = _json_client(_load("card_account.json"))
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    (card,) = result.accounts
    assert card.kind_guess == "credit_card"
    assert card.institution == "Example Card Services"
    assert card.balance == Decimal("-412.30")


def test_list_accounts_v1_org_name_and_errors():
    client, _ = _json_client(_load("errors_v1.json"))
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    (acct,) = result.accounts
    assert acct.institution == "Example Credit Union"
    assert result.errors == ["connector_account_error"]


def test_list_accounts_errlist_gives_codes_only():
    client, _ = _json_client(_load("errlist.json"))
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert len(result.accounts) == 3
    assert result.errors == ["connector_account_error"]
    assert "sign in" not in json.dumps(result.errors)


def test_list_accounts_marks_each_errlist_flagged_account():
    client, _ = _json_client(_load("errlist.json"))
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    by_id = {a.provider_account_id: a for a in result.accounts}
    # con.auth on the whole connection B, act.failed on account 3.
    assert by_id["ACT-EXAMPLE-1"].error is None
    assert by_id["ACT-EXAMPLE-2"].error == "connector_account_error"
    assert by_id["ACT-EXAMPLE-3"].error == "connector_account_error"


def test_list_accounts_general_problem_marks_no_account():
    client, _ = _json_client(_load("errors_v1.json"))
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert [a.error for a in result.accounts] == [None]
    assert result.errors == ["connector_account_error"]


def test_list_accounts_institution_cut_to_120():
    doc = _load("accounts_balances.json")
    doc["connections"][0]["name"] = "N" * 300
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert result.accounts[0].institution == "N" * 120


def test_list_accounts_cap():
    doc = _load("accounts_balances.json")
    one = doc["accounts"][0]
    doc["accounts"] = [{**one, "id": f"ACT-{i}"} for i in range(MAX_ACCOUNTS + 1)]
    client, _ = _json_client(doc)
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().list_accounts(client, _creds())
    assert _err(info) == "provider_bad_response"


def test_list_accounts_at_cap_is_fine():
    doc = _load("accounts_balances.json")
    one = doc["accounts"][0]
    doc["accounts"] = [{**one, "id": f"ACT-{i}"} for i in range(MAX_ACCOUNTS)]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert len(result.accounts) == MAX_ACCOUNTS


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d.update(accounts="nope"),
        lambda d: d.pop("accounts"),
        lambda d: d["accounts"][0].pop("id"),
        lambda d: d["accounts"][0].update(id=""),
        lambda d: d["accounts"][0].update(id=12),
        lambda d: d["accounts"][0].update(currency=None),
        lambda d: d["accounts"].append("not an object"),
        lambda d: d.update(connections="nope"),
        lambda d: d.update(errlist="nope"),
    ],
)
def test_list_accounts_schema_mismatch(mutate):
    doc = _load("accounts_balances.json")
    mutate(doc)
    client, _ = _json_client(doc)
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().list_accounts(client, _creds())
    assert _err(info) == "provider_bad_response"


def test_list_accounts_top_level_not_object():
    client, _ = _json_client([1, 2, 3])
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().list_accounts(client, _creds())
    assert _err(info) == "provider_bad_response"


@pytest.mark.parametrize(
    "status,code",
    [
        (401, "reconnect_needed"),
        (403, "reconnect_needed"),
        (402, "payment_required"),
        (429, "provider_rate_limited"),
        (500, "provider_unavailable"),
    ],
)
def test_list_accounts_status_errors(status, code):
    client, _ = _json_client({}, status=status)
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().list_accounts(client, _creds())
    assert _err(info) == code


@pytest.mark.parametrize(
    "balance", ["abc", "NaN", "inf", "1e11", "1e999999999", True, [1], ""]
)
def test_list_accounts_unusable_balance_is_dropped(balance):
    doc = _load("accounts_balances.json")
    doc["accounts"][0]["balance"] = balance
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert result.accounts[0].balance is None
    assert result.accounts[0].balance_date is None
    assert result.accounts[1].balance == Decimal("25401.15")


@pytest.mark.parametrize("when", ["yesterday", True, -1, 10**13])
def test_list_accounts_unusable_balance_date_is_none(when):
    doc = _load("accounts_balances.json")
    doc["accounts"][0]["balance-date"] = when
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert result.accounts[0].balance == Decimal("114965.51")
    assert result.accounts[0].balance_date is None


def test_list_accounts_missing_balance_is_none():
    doc = _load("accounts_balances.json")
    del doc["accounts"][0]["balance"]
    del doc["accounts"][0]["balance-date"]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert result.accounts[0].balance is None
    assert result.accounts[0].balance_date is None


# --- fetch ---------------------------------------------------------------------


def _req(account_id: str, since: date = date(2026, 9, 4)) -> AccountRequest:
    return AccountRequest(
        provider_account_id=account_id,
        since=since,
        account_key=account_key_for("simplefin", account_id),
        kind="checking",
    )


def _midnight(d: date) -> int:
    return int(datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp())


def test_fetch_request_shape():
    client, rec = _json_client(_load("accounts_window.json"))
    start, end = date(2026, 9, 5), date(2026, 10, 4)
    with client:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Savings"), _req("Demo Checking")], start, end
        )
    (req,) = rec.requests
    assert req.method == "GET"
    assert req.url.path == "/simplefin/accounts"
    assert req.url.userinfo == b""
    params = req.url.params
    assert params.get("start-date") == str(_midnight(start))
    # end-date is exclusive: midnight UTC after the end day, so the end day is in.
    assert params.get("end-date") == str(_midnight(date(2026, 10, 5)))
    assert params.get("version") == "2"
    assert params.get_list("account") == ["Demo Savings", "Demo Checking"]
    assert "pending" not in params
    assert "balances-only" not in params
    assert "Authorization" in req.headers


def test_fetch_maps_recorded_window():
    doc = _load("accounts_window.json")
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client,
            _creds(),
            [_req("Demo Savings"), _req("Demo Checking"), _req("Demo Empty Account")],
            date(2026, 9, 5),
            date(2026, 10, 4),
        )
    assert result.errors == []
    assert result.pages == 1
    assert result.end is None
    by_id = {a.provider_account_id: a for a in result.accounts}
    assert list(by_id) == ["Demo Savings", "Demo Checking", "Demo Empty Account"]
    savings = by_id["Demo Savings"]
    raw = doc["accounts"][0]
    assert savings.error is None
    assert savings.currency == "USD"
    assert savings.balance == Decimal(raw["balance"])
    assert savings.balance_date == _utc(raw["balance-date"])
    assert len(savings.transactions) == len(raw["transactions"])
    first = savings.transactions[0]
    assert first.id == raw["transactions"][0]["id"]
    assert first.posted == _utc(raw["transactions"][0]["posted"])
    assert first.amount == Decimal(raw["transactions"][0]["amount"])
    assert isinstance(first.amount, Decimal)
    assert first.description == "Fishing bait"
    assert first.payee == "John's Fishin Shack"
    assert by_id["Demo Empty Account"].transactions == []
    assert by_id["Demo Empty Account"].error is None


def test_fetch_skips_pending_rows():
    client, _ = _json_client(_load("card_account.json"))
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    (card,) = result.accounts
    assert [t.id for t in card.transactions] == ["TRN-CARD-1", "TRN-CARD-2"]
    assert card.transactions[1].payee is None
    assert card.balance == Decimal("-412.30")


def test_fetch_skips_pending_flag_even_with_posted_date():
    doc = _load("card_account.json")
    doc["accounts"][0]["transactions"][0]["pending"] = True
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert [t.id for t in result.accounts[0].transactions] == ["TRN-CARD-2"]


def test_fetch_accepts_numeric_amounts():
    doc = _load("card_account.json")
    rows = doc["accounts"][0]["transactions"]
    rows[0]["amount"] = -58
    raw = json.dumps(doc).replace('"200.00"', "200.5")
    rec = Recorder(
        httpx.Response(200, text=raw, headers={"content-type": "application/json"})
    )
    with _client(rec) as client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    amounts = [t.amount for t in result.accounts[0].transactions]
    assert amounts == [Decimal("-58"), Decimal("200.5")]
    assert all(isinstance(a, Decimal) for a in amounts)


@pytest.mark.parametrize(
    "amount",
    [
        "NaN",
        "-NaN",
        "inf",
        "-Infinity",
        "sNaN",
        "1e11",
        "-10000000001",
        "1e999999999",
        "abc",
        "",
        None,
        True,
        [1],
    ],
)
def test_fetch_skips_rows_with_unusable_amounts(amount):
    doc = _load("card_account.json")
    doc["accounts"][0]["transactions"][0]["amount"] = amount
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    (card,) = result.accounts
    assert [t.id for t in card.transactions] == ["TRN-CARD-2"]
    assert card.warnings == ["rows_skipped"]
    assert card.error is None


def test_fetch_huge_json_number_amount_is_skipped():
    raw = json.dumps(_load("card_account.json")).replace('"-58.20"', "1e999999999")
    rec = Recorder(
        httpx.Response(200, text=raw, headers={"content-type": "application/json"})
    )
    with _client(rec) as client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert [t.id for t in result.accounts[0].transactions] == ["TRN-CARD-2"]
    assert result.accounts[0].warnings == ["rows_skipped"]


def test_fetch_clean_rows_have_no_warnings():
    client, _ = _json_client(_load("card_account.json"))
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].warnings == []


def test_fetch_unusable_balance_is_dropped():
    doc = _load("card_account.json")
    doc["accounts"][0]["balance"] = "NaN"
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    (card,) = result.accounts
    assert card.balance is None and card.balance_date is None
    assert len(card.transactions) == 2


def test_fetch_amount_at_bound_is_fine():
    doc = _load("card_account.json")
    doc["accounts"][0]["transactions"][0]["amount"] = "-10000000000"
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].transactions[0].amount == Decimal("-10000000000")


@pytest.mark.parametrize(
    "mutate",
    [
        lambda t: t.update(posted="1790812800"),
        lambda t: t.update(posted=True),
        lambda t: t.update(posted=-5),
        lambda t: t.update(posted=10**13),
        lambda t: t.pop("posted"),
        lambda t: t.update(id=""),
        lambda t: t.update(posted=False),
        lambda t: t.update(posted=1.5),
        lambda t: t.update(id=None),
        lambda t: t.update(id=12),
        lambda t: t.update(id="x" * 300),
    ],
)
def test_fetch_skips_rows_with_unusable_id_or_date(mutate):
    doc = _load("card_account.json")
    mutate(doc["accounts"][0]["transactions"][0])
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    (card,) = result.accounts
    assert [t.id for t in card.transactions] == ["TRN-CARD-2"]
    assert card.warnings == ["rows_skipped"]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["accounts"][0].update(transactions="nope"),
        lambda d: d["accounts"][0]["transactions"].append("not an object"),
        lambda d: d["accounts"][0].update(id=None),
        lambda d: d["accounts"][0].update(currency=5),
        lambda d: d.update(accounts={"a": 1}),
    ],
)
def test_fetch_structure_mismatch(mutate):
    doc = _load("card_account.json")
    mutate(doc)
    client, _ = _json_client(doc)
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert _err(info) == "provider_bad_response"


def test_fetch_wrong_typed_text_is_treated_as_absent():
    doc = _load("card_account.json")
    doc["accounts"][0]["transactions"][0]["description"] = 5
    doc["accounts"][0]["transactions"][0]["payee"] = ["x"]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    first = result.accounts[0].transactions[0]
    assert (first.description, first.payee) == ("", None)
    assert result.accounts[0].warnings == []


def test_fetch_missing_description_falls_back_to_empty():
    doc = _load("card_account.json")
    del doc["accounts"][0]["transactions"][0]["description"]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].transactions[0].description == ""
    assert result.accounts[0].transactions[0].payee == "Fuel Stop"


def test_fetch_row_cap():
    doc = _load("card_account.json")
    row = doc["accounts"][0]["transactions"][0]
    doc["accounts"][0]["transactions"] = [
        {**row, "id": f"T{i}"} for i in range(MAX_TXNS_PER_ACCOUNT + 1)
    ]
    client, _ = _json_client(doc)
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert _err(info) == "provider_bad_response"


def test_fetch_errlist_marks_accounts_without_failing():
    client, _ = _json_client(_load("errlist.json"))
    with client:
        result = SimpleFinProvider().fetch(
            client,
            _creds(),
            [_req("ACT-EXAMPLE-1"), _req("ACT-EXAMPLE-2"), _req("ACT-EXAMPLE-3")],
            date(2026, 9, 5),
            TODAY,
        )
    by_id = {a.provider_account_id: a for a in result.accounts}
    assert by_id["ACT-EXAMPLE-1"].error is None
    assert [t.id for t in by_id["ACT-EXAMPLE-1"].transactions] == ["TRN-EXAMPLE-1"]
    # con.auth on the whole connection B, act.failed on account 3.
    assert by_id["ACT-EXAMPLE-2"].error == "connector_account_error"
    assert by_id["ACT-EXAMPLE-2"].transactions == []
    assert by_id["ACT-EXAMPLE-2"].balance is None
    assert by_id["ACT-EXAMPLE-3"].error == "connector_account_error"
    assert result.errors == ["connector_account_error"]


def test_fetch_v1_errors_and_missing_account():
    client, _ = _json_client(_load("errors_v1.json"))
    with client:
        result = SimpleFinProvider().fetch(
            client,
            _creds(),
            [_req("ACT-EXAMPLE-1"), _req("ACT-EXAMPLE-2")],
            date(2026, 9, 5),
            TODAY,
        )
    by_id = {a.provider_account_id: a for a in result.accounts}
    assert by_id["ACT-EXAMPLE-1"].error is None
    assert len(by_id["ACT-EXAMPLE-1"].transactions) == 1
    # Requested but absent from the response.
    assert by_id["ACT-EXAMPLE-2"].error == "connector_account_error"
    assert by_id["ACT-EXAMPLE-2"].transactions == []
    assert result.errors == ["connector_account_error"]
    assert "attention" not in repr(result)


def test_fetch_ignores_unrequested_accounts():
    client, _ = _json_client(_load("accounts_window.json"))
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert [a.provider_account_id for a in result.accounts] == ["Demo Checking"]


def test_fetch_general_errlist_entry_is_result_level():
    doc = _load("accounts_window.json")
    doc["errlist"] = [{"code": "gen.notice", "msg": "Something general."}]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].error is None
    assert result.errors == ["connector_account_error"]


@pytest.mark.parametrize(
    "entry",
    [
        "a string",
        {"code": 5},
    ],
)
def test_fetch_malformed_errlist_entry(entry):
    doc = _load("accounts_window.json")
    doc["errlist"] = [entry]
    client, _ = _json_client(doc)
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert _err(info) == "provider_bad_response"


@pytest.mark.parametrize(
    "start,end",
    [
        (date(2026, 7, 5), TODAY),  # 92 days inclusive
        (date(2026, 7, 6), TODAY),  # 91 days inclusive
        (date(2026, 9, 1), date(2026, 10, 6)),  # ends after tomorrow
        (date(2026, 10, 4), date(2026, 10, 3)),  # start after end
    ],
)
def test_fetch_window_rules_raise_before_any_request(start, end):
    client, rec = _json_client(_load("accounts_window.json"))
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().fetch(client, _creds(), [_req("Demo Checking")], start, end)
    assert _err(info) == "window_too_long"
    assert rec.requests == []


def test_fetch_window_of_exactly_90_days_is_fine():
    client, rec = _json_client(_load("accounts_window.json"))
    start = date(2026, 7, 7)
    assert (TODAY - start).days + 1 == 90
    with client:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], start, TODAY
        )
    assert len(rec.requests) == 1


def test_fetch_needs_accounts():
    client, rec = _json_client(_load("accounts_window.json"))
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().fetch(client, _creds(), [], date(2026, 9, 5), TODAY)
    assert _err(info) == "bad_request"
    assert rec.requests == []


def test_fetch_too_many_accounts():
    client, rec = _json_client(_load("accounts_window.json"))
    reqs = [_req(f"A{i}") for i in range(MAX_ACCOUNTS + 1)]
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().fetch(client, _creds(), reqs, date(2026, 9, 5), TODAY)
    assert _err(info) == "bad_request"
    assert rec.requests == []


def test_wrong_credentials_type_is_bad_request():
    from src.connectors.types import AkahuCredentials

    client, rec = _json_client(_load("accounts_balances.json"))
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().list_accounts(client, AkahuCredentials("a", "b"))
    assert _err(info) == "bad_request"
    assert rec.requests == []


# --- provider and registry -------------------------------------------------------


def test_provider_attributes_and_registry():
    provider = registry.get_provider("simplefin")
    assert isinstance(provider, SimpleFinProvider)
    assert provider.id == "simplefin"
    assert provider.display_name == "SimpleFIN"
    assert provider.max_window_days == 90
    assert provider.daily_request_budget == 20


# --- normalize helpers used here (A4 extends normalize.py) -------------------------


def test_account_key_for():
    a = account_key_for("simplefin", "ACT-123")
    b = account_key_for("simplefin", "ACT-124")
    assert a != b
    assert a.startswith("acct:") and "ACT-123" not in a
    assert account_key_for("akahu", "ACT-123") != a
    import hashlib

    digest = hashlib.sha256(b"finlity-conn-v1|simplefin|ACT-123").hexdigest()
    assert a == "acct:" + digest


@pytest.mark.parametrize(
    "name,expected",
    [
        ("Rewards VISA Card", "credit_card"),
        ("Platinum Mastercard", "credit_card"),
        ("AMEX Gold", "credit_card"),
        ("Credit card", "credit_card"),
        ("Home Loan", "loan"),
        ("Mortgage 2", "loan"),
        ("SimpleFIN Savings", "savings"),
        ("Everyday", "checking"),
        ("", "checking"),
    ],
)
def test_guess_kind_simplefin(name, expected):
    assert guess_kind("simplefin", name, None, None) == expected


@pytest.mark.parametrize(
    "ptype,expected",
    [
        ("CHECKING", "checking"),
        ("SAVINGS", "savings"),
        ("CREDITCARD", "credit_card"),
        ("LOAN", "loan"),
        ("KIWISAVER", "unknown"),
        (None, "unknown"),
    ],
)
def test_guess_kind_akahu(ptype, expected):
    assert guess_kind("akahu", "Anything Card", ptype, None) == expected


# --- logs ----------------------------------------------------------------------


def test_no_secret_or_content_in_logs(caplog):
    caplog.set_level(logging.DEBUG)
    for name in ("httpx", "httpcore", "src.connectors"):
        logging.getLogger(name).setLevel(logging.DEBUG)
    account_name = "Planted Account Name 77"
    merchant = "Planted Merchant Zed"
    amount = "-987.65"
    doc = copy.deepcopy(_load("accounts_window.json"))
    doc["accounts"][0]["name"] = account_name
    doc["accounts"][0]["transactions"][0]["description"] = merchant
    doc["accounts"][0]["transactions"][0]["amount"] = amount

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "POST":
            return httpx.Response(200, text=ACCESS_URL)
        return httpx.Response(200, json=doc)

    provider = SimpleFinProvider()
    with _client(handler) as client:
        creds = provider.claim(client, _token(CLAIM_URL))
        provider.list_accounts(client, creds)
        result = provider.fetch(
            client, creds, [_req("Demo Savings")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].transactions[0].description == merchant
    text = caplog.text + "".join(repr(r.args) for r in caplog.records)
    assert caplog.records, "expected the client's event log lines"
    for planted in (PASSWORD, USER, ACCESS_URL, account_name, merchant, "987.65"):
        assert planted not in text


def test_claim_url_not_in_httpx_logs(caplog):
    caplog.set_level(logging.DEBUG)
    for name in ("httpx", "httpcore", "src.connectors"):
        logging.getLogger(name).setLevel(logging.DEBUG)
    rec = Recorder(httpx.Response(200, text=ACCESS_URL))
    with _client(rec) as client:
        SimpleFinProvider().claim(client, _token(CLAIM_URL))
    assert "DEMO-v2-0000TEST" not in caplog.text


# --- review hardening -------------------------------------------------------------


def test_list_accounts_repeated_id_keeps_first():
    doc = _load("accounts_balances.json")
    dup = {**doc["accounts"][1], "id": "Demo Savings", "name": "Second Copy"}
    doc["accounts"].append(dup)
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    ids = [a.provider_account_id for a in result.accounts]
    assert ids == ["Demo Savings", "Demo Checking", "Demo Empty Account"]
    assert result.accounts[0].name == "SimpleFIN Savings"


def test_fetch_window_may_end_tomorrow():
    client, rec = _json_client(_load("accounts_window.json"))
    end = date(2026, 10, 5)
    with client:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 6), end
        )
    (req,) = rec.requests
    assert req.url.params.get("end-date") == str(_midnight(date(2026, 10, 6)))


@pytest.mark.parametrize("call", ["list", "fetch"])
def test_gen_auth_is_reconnect_needed(call):
    doc = _load("accounts_window.json")
    doc["errlist"] = [{"code": "gen.auth", "msg": "Sign in again."}]
    client, _ = _json_client(doc)
    provider = SimpleFinProvider()
    with client, pytest.raises(ConnectorError) as info:
        if call == "list":
            provider.list_accounts(client, _creds())
        else:
            provider.fetch(
                client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
            )
    assert _err(info) == "reconnect_needed"


@pytest.mark.parametrize(
    "entry",
    [
        {"code": "con.auth", "conn_id": 7},
        {"code": "act.failed", "account_id": ["x"]},
        {"code": "act.failed", "account_id": "", "conn_id": None},
    ],
)
def test_errlist_entry_with_unusable_ids_is_general(entry):
    doc = _load("accounts_window.json")
    doc["errlist"] = [entry]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].error is None
    assert result.errors == ["connector_account_error"]


@pytest.mark.parametrize(
    "mutate",
    [
        lambda d: d["accounts"][0].update(conn_id=7),
        lambda d: d["accounts"][0].update(conn_id=["x"]),
        lambda d: d["accounts"][0].update(org="nope"),
        lambda d: d["accounts"][0].update(org={"name": 5}),
        lambda d: d["connections"].append("not an object"),
        lambda d: d["connections"].append({"conn_id": 5, "name": "X"}),
    ],
)
def test_unusable_conn_id_or_org_means_no_institution(mutate):
    doc = _load("accounts_balances.json")
    mutate(doc)
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert len(result.accounts) == 3
    assert result.accounts[1].institution == "SimpleFIN Demo"


def test_unusable_conn_id_drops_institution():
    doc = _load("accounts_balances.json")
    doc["accounts"][0]["conn_id"] = 7
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().list_accounts(client, _creds())
    assert result.accounts[0].institution is None


def test_errored_account_skips_currency_check():
    doc = _load("errlist.json")
    doc["accounts"][1]["currency"] = 5  # ACT-EXAMPLE-2, under con.auth
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-2")], date(2026, 9, 5), TODAY
        )
    (acct,) = result.accounts
    assert acct.error == "connector_account_error"
    assert acct.currency == ""


@pytest.mark.parametrize(
    "key,cap",
    [("errlist", 200), ("errors", 200), ("connections", 100)],
)
def test_problem_and_connection_lists_are_capped(key, cap):
    doc = _load("accounts_window.json")
    item: Any = (
        "a warning"
        if key == "errors"
        else {"code": "act.notice", "msg": "m"}
        if key == "errlist"
        else {"conn_id": "C", "name": "N"}
    )
    doc[key] = [item] * cap
    client, _ = _json_client(doc)
    with client:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    doc[key] = [item] * (cap + 1)
    client, _ = _json_client(doc)
    with client, pytest.raises(ConnectorError) as info:
        SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert _err(info) == "provider_bad_response"


def test_bad_setup_token_error_has_no_context():
    with pytest.raises(ConnectorError) as info:
        decode_setup_token("bm90LWEtdXJs!!")
    assert info.value.__context__ is None
    assert info.value.__cause__ is None
    with pytest.raises(ConnectorError) as info:
        decode_setup_token(base64.b64encode(b"\xff\xfe").decode())
    assert info.value.__context__ is None


@pytest.mark.parametrize("flag", ["true", 1, "yes", False, None])
def test_only_json_true_marks_pending(flag):
    doc = _load("card_account.json")
    doc["accounts"][0]["transactions"][0]["pending"] = flag
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-CARD")], date(2026, 9, 5), TODAY
        )
    assert [t.id for t in result.accounts[0].transactions] == [
        "TRN-CARD-1",
        "TRN-CARD-2",
    ]


def test_fetch_carries_institution():
    client, _ = _json_client(_load("accounts_window.json"))
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].institution == "SimpleFIN Demo"


def test_fetch_carries_v1_org_name_and_cuts_to_120():
    client, _ = _json_client(_load("errors_v1.json"))
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("ACT-EXAMPLE-1")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].institution == "Example Credit Union"
    doc = _load("accounts_window.json")
    doc["connections"][0]["name"] = "N" * 300
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].institution == "N" * 120


def test_fetch_unusable_conn_id_gives_no_institution():
    doc = _load("accounts_window.json")
    doc["accounts"][1]["conn_id"] = 7
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].institution is None
    assert result.accounts[0].error is None


# --- rate-limit warnings (A7) ---------------------------------------------------


@pytest.mark.parametrize(
    "key,item",
    [
        ("errors", "You have exceeded the rate limit. Slow down."),
        ("errors", "Too many requests today."),
        ("errors", "RATE-LIMITED: try tomorrow"),
        ("errlist", {"code": "gen.ratelimit", "msg": "Slow down."}),
        ("errlist", {"code": "gen.notice", "msg": "Rate limit exceeded for this token."}),
    ],
)
def test_rate_limit_warning_is_a_result_code_and_data_is_kept(key, item):
    doc = _load("accounts_window.json")
    doc[key] = [item]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert result.accounts[0].error is None
    assert result.accounts[0].transactions
    assert result.errors == ["connector_account_error", "provider_rate_limited"]
    listing_client, _ = _json_client(doc)
    with listing_client:
        listing = SimpleFinProvider().list_accounts(listing_client, _creds())
    assert listing.errors == ["connector_account_error", "provider_rate_limited"]


@pytest.mark.parametrize(
    "item",
    [
        "Example Savings Bank: connection needs attention.",
        "Interest rate changed.",
        {"code": "con.auth", "msg": "Generate a new separate token."},
    ],
)
def test_other_warnings_are_not_rate_limits(item):
    doc = _load("accounts_window.json")
    if isinstance(item, str):
        doc["errors"] = [item]
    else:
        doc["errlist"] = [item]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert "provider_rate_limited" not in result.errors


def test_rate_limit_text_scan_is_bounded():
    doc = _load("accounts_window.json")
    doc["errors"] = ["x" * 100_000 + " rate limit"]
    client, _ = _json_client(doc)
    with client:
        result = SimpleFinProvider().fetch(
            client, _creds(), [_req("Demo Checking")], date(2026, 9, 5), TODAY
        )
    assert "provider_rate_limited" not in result.errors
