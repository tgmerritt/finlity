"""The synthetic demo provider (design 11)."""

from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import httpx
import pytest

from src.connectors import registry
from src.connectors.demo import (
    CARD_ID,
    CHECKING_ID,
    DemoProvider,
)
from src.connectors.errors import ConnectorError
from src.connectors.normalize import account_key_for, to_statements
from src.connectors.types import AccountRequest, DemoCredentials
from src.smart_import.seed_rules import SEED_RULES
from src.smart_import.types import WARNINGS

TODAY = date(2026, 10, 5)
NOW = datetime(2026, 10, 5, 12, 0, tzinfo=timezone.utc)
CATEGORIES = [
    {"id": f"cat-{i}", "name": name}
    for i, name in enumerate(sorted({name for _, name in SEED_RULES}))
]
CONTEXT: dict[str, Any] = {"categories": CATEGORIES, "rules": {}}
CREDS = DemoCredentials()


class _NoNetwork:
    """A client that fails on any use."""

    def get_json(self, *a: object, **k: object) -> Any:
        raise AssertionError("demo made a network call")

    def post_text(self, *a: object, **k: object) -> str:
        raise AssertionError("demo made a network call")


CLIENT = _NoNetwork()


def _reqs(since: date, kinds: dict[str, str] | None = None) -> list[AccountRequest]:
    kinds = kinds or {CHECKING_ID: "checking", CARD_ID: "credit_card"}
    return [
        AccountRequest(
            provider_account_id=aid,
            since=since,
            account_key=account_key_for("demo", aid),
            kind=kind,
        )
        for aid, kind in kinds.items()
    ]


def _fetch(start: date, end: date, since: date | None = None):  # type: ignore[no-untyped-def]
    return DemoProvider().fetch(CLIENT, CREDS, _reqs(since or start), start, end)  # type: ignore[arg-type]


def _txns(result: Any, account_id: str) -> list[Any]:
    (acct,) = [a for a in result.accounts if a.provider_account_id == account_id]
    return acct.transactions


def test_same_window_gives_identical_output():
    a = _fetch(TODAY - timedelta(days=29), TODAY)
    b = _fetch(TODAY - timedelta(days=29), TODAY)
    assert a == b


def test_two_accounts_with_fixed_ids():
    accounts = DemoProvider().list_accounts(CLIENT, CREDS).accounts  # type: ignore[arg-type]
    assert [(a.provider_account_id, a.kind_guess) for a in accounts] == [
        ("demo-chk", "checking"),
        ("demo-card", "credit_card"),
    ]
    assert accounts[0].name == "Demo Everyday"
    assert accounts[1].name == "Demo Rewards Card"
    assert all(
        a.account_key == account_key_for("demo", a.provider_account_id)
        for a in accounts
    )


def test_external_ids_have_account_date_and_index():
    result = _fetch(TODAY - timedelta(days=9), TODAY)
    for aid in (CHECKING_ID, CARD_ID):
        rows = _txns(result, aid)
        assert rows
        for row in rows:
            account, day, n = row.id.rsplit(":", 2)
            assert account == aid
            assert day == row.posted.isoformat()
            assert n.isdigit()
        assert len({r.id for r in rows}) == len(rows)


def test_statement_external_ids_are_prefixed_with_the_provider():
    result = _fetch(TODAY - timedelta(days=9), TODAY)
    stmts = to_statements(
        "demo",
        result,
        _reqs(TODAY - timedelta(days=9)),
        (TODAY - timedelta(days=9), TODAY),
        CONTEXT,
        now=NOW,
    )
    for st in stmts:
        for tx in st["transactions"]:
            assert tx["external_id"].startswith("demo:demo-")


def test_overlapping_windows_share_ids_and_rows():
    wide = _fetch(TODAY - timedelta(days=29), TODAY)
    late = _fetch(TODAY - timedelta(days=14), TODAY - timedelta(days=2))
    for aid in (CHECKING_ID, CARD_ID):
        by_id = {t.id: t for t in _txns(wide, aid)}
        overlap = _txns(late, aid)
        assert overlap
        for t in overlap:
            assert by_id[t.id] == t


def test_dates_stay_inside_the_window_and_follow_it():
    start, end = TODAY - timedelta(days=29), TODAY
    for shift in (0, 7):
        result = _fetch(start - timedelta(days=shift), end - timedelta(days=shift))
        for aid in (CHECKING_ID, CARD_ID):
            days = {t.posted for t in _txns(result, aid)}
            assert min(days) >= start - timedelta(days=shift)
            assert max(days) <= end - timedelta(days=shift)


def test_thirty_day_window_has_salary_three_bills_and_daily_spending():
    start = TODAY - timedelta(days=29)
    rows = _txns(_fetch(start, TODAY), CHECKING_ID)
    salary = [t for t in rows if "PAYROLL" in t.description]
    assert len(salary) >= 2
    assert all(t.amount == Decimal("2400.00") for t in salary)
    descs = " ".join(t.description for t in rows)
    for bill in ("NETFLIX", "VERIZON", "PG&E"):
        assert bill in descs
    spending_days = {t.posted for t in rows if t.amount < 0}
    assert spending_days == {start + timedelta(days=i) for i in range(30)}


def test_card_has_only_outflows():
    rows = _txns(_fetch(TODAY - timedelta(days=29), TODAY), CARD_ID)
    assert rows and all(t.amount < 0 for t in rows)


def test_since_trims_one_account_only():
    start = TODAY - timedelta(days=29)
    reqs = _reqs(start)
    reqs[1] = AccountRequest(
        provider_account_id=CARD_ID,
        since=TODAY - timedelta(days=5),
        account_key=reqs[1].account_key,
        kind="credit_card",
    )
    result = DemoProvider().fetch(CLIENT, CREDS, reqs, start, TODAY)  # type: ignore[arg-type]
    assert min(t.posted for t in _txns(result, CARD_ID)) >= TODAY - timedelta(days=5)
    assert min(t.posted for t in _txns(result, CHECKING_ID)) == start


def test_card_balance_is_holder_side_and_a_function_of_the_date():
    start = TODAY - timedelta(days=29)
    a = _fetch(start, TODAY)
    b = _fetch(start - timedelta(days=10), TODAY)
    (card_a,) = [x for x in a.accounts if x.provider_account_id == CARD_ID]
    (card_b,) = [x for x in b.accounts if x.provider_account_id == CARD_ID]
    assert card_a.balance == card_b.balance
    assert card_a.balance_date == TODAY
    assert card_a.balance is not None and card_a.balance < 0
    other = _fetch(start, TODAY - timedelta(days=1))
    (card_c,) = [x for x in other.accounts if x.provider_account_id == CARD_ID]
    assert card_c.balance != card_a.balance
    (chk,) = [x for x in a.accounts if x.provider_account_id == CHECKING_ID]
    assert chk.balance is not None and chk.balance > 0


def test_card_statement_closing_balance_is_the_owed_amount():
    start = TODAY - timedelta(days=29)
    result = _fetch(start, TODAY)
    stmts = to_statements(
        "demo", result, _reqs(start), (start, TODAY), CONTEXT, now=NOW
    )
    (card,) = [s for s in stmts if s["account"]["kind"] == "credit_card"]
    (card_raw,) = [x for x in result.accounts if x.provider_account_id == CARD_ID]
    assert card["closing_balance"]["amount"] == float(-card_raw.balance)  # type: ignore[operator]
    assert card["closing_balance"]["amount"] > 0
    assert "connector_sign_check" not in card["warnings"]


def test_every_row_gets_a_seed_category_through_to_statements():
    start = TODAY - timedelta(days=89)
    result = _fetch(start, TODAY)
    stmts = to_statements(
        "demo", result, _reqs(start), (start, TODAY), CONTEXT, now=NOW
    )
    assert len(stmts) == 2
    checked = 0
    for st in stmts:
        assert st["parser"] == "connector:demo"
        assert set(st["warnings"]) <= set(WARNINGS)
        for tx in st["transactions"]:
            if tx["kind"] == "expense":
                checked += 1
                assert tx["category_source"] == "seed", tx["description"]
                assert tx["category_id"] is not None
    assert checked > 100


def test_no_fake_personal_names_or_real_institutions():
    start = TODAY - timedelta(days=89)
    result = _fetch(start, TODAY)
    text = " ".join(
        t.description for a in result.accounts for t in a.transactions
    ).lower()
    assert chr(0x2014) not in text
    for name in ("chase", "wells fargo", "bank of america", "citi "):
        assert name not in text


@pytest.mark.parametrize(
    ("start", "end"),
    [
        (TODAY - timedelta(days=90), TODAY),
        (TODAY, TODAY - timedelta(days=1)),
    ],
)
def test_window_caps_are_enforced(start: date, end: date):
    with pytest.raises(ConnectorError) as exc:
        _fetch(start, end)
    assert exc.value.error_type == "window_too_long"


def test_ninety_day_window_is_allowed():
    result = _fetch(TODAY - timedelta(days=89), TODAY)
    assert len(result.accounts) == 2


def test_unknown_account_is_an_account_error():
    req = AccountRequest(
        provider_account_id="nope",
        since=TODAY,
        account_key="acct:x",
        kind="checking",
    )
    result = DemoProvider().fetch(CLIENT, CREDS, [req], TODAY, TODAY)  # type: ignore[arg-type]
    assert result.accounts[0].error == "connector_account_error"
    assert result.accounts[0].transactions == []


def test_claim_needs_nothing_and_registry_builds_the_provider():
    provider = registry.get_provider("demo")
    assert isinstance(provider, DemoProvider)
    assert provider.daily_request_budget is None
    assert isinstance(provider.claim(CLIENT, ""), DemoCredentials)  # type: ignore[arg-type]


def test_no_network_through_a_failing_transport(monkeypatch: pytest.MonkeyPatch):
    def boom(*a: object, **k: object) -> None:
        raise AssertionError("network used")

    monkeypatch.setattr(httpx.Client, "send", boom)
    monkeypatch.setattr(httpx.AsyncClient, "send", boom)
    provider = registry.get_provider("demo")
    provider.list_accounts(CLIENT, CREDS)  # type: ignore[arg-type]
    result = _fetch(TODAY - timedelta(days=5), TODAY)
    assert result.accounts
