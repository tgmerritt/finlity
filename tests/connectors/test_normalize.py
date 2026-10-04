"""Mapping provider data onto NormalizedStatement (design 5.2, plan Task A4).

Plain data in, plain data out: no network, and ``now`` is always passed in.
One test applies the output through the server Apply route on a temp database.
"""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import replace
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import httpx
import pytest

from src.api.smart_import import ApplyRequest, ApplyStatement
from tests.connectors.apply_contract import as_apply
from src.connectors import normalize as cn
from src.connectors import simplefin as sf
from src.connectors.errors import ConnectorError
from src.connectors.http import SafeClient
from src.connectors.normalize import (
    account_key_for,
    closing_amount,
    dropped_accounts,
    external_id_for,
    guess_kind,
    to_statements,
)
from src.connectors.simplefin import SimpleFinProvider
from src.database.models import Liability
from src.connectors.types import (
    AccountRequest,
    FetchedAccount,
    FetchResult,
    ProviderTxn,
    SimpleFinCredentials,
)
from src.smart_import import normalize as si
from src.smart_import.settings_store import _ACCOUNT_KEY
from src.smart_import.types import WARNINGS
from tests.api.si_support import (  # noqa: F401
    add_connection,
    add_liability,
    apply_body,
    client,
    db,
    do_apply,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "connectors" / "simplefin"
START, END = date(2026, 9, 5), date(2026, 10, 4)
WINDOW = (START, END)
CATEGORIES = [
    {"id": "c-dining", "name": "Food & Dining"},
    {"id": "c-shop", "name": "Shopping"},
]
CONTEXT: dict[str, Any] = {"categories": CATEGORIES, "rules": {}}
# Categories the si_support test database holds.
SERVER_CONTEXT: dict[str, Any] = {
    "categories": [{"id": "cat-Dining", "name": "Dining"}],
    "rules": {},
}
# Mid-afternoon UTC on the window's last day.
NOW = datetime(2026, 10, 4, 15, 0, tzinfo=timezone.utc)


def _txn(
    txn_id: str = "t1",
    posted: date = date(2026, 9, 20),
    amount: str = "-12.34",
    description: str = "STARBUCKS STORE",
    payee: str | None = None,
) -> ProviderTxn:
    return ProviderTxn(
        id=txn_id,
        posted=posted,
        amount=Decimal(amount),
        description=description,
        payee=payee,
    )


def _acct(
    account_id: str = "ACT-1",
    txns: list[ProviderTxn] | None = None,
    balance: str | None = "100.00",
    balance_date: date | None = END,
    currency: str = "USD",
    **kw: Any,
) -> FetchedAccount:
    return FetchedAccount(
        provider_account_id=account_id,
        currency=currency,
        transactions=[_txn()] if txns is None else txns,
        balance=None if balance is None else Decimal(balance),
        balance_date=balance_date,
        **kw,
    )


def _req(
    account_id: str = "ACT-1",
    kind: str = "checking",
    since: date = START,
    flip: bool = False,
    key: str | None = None,
) -> AccountRequest:
    return AccountRequest(
        provider_account_id=account_id,
        since=since,
        account_key=key or account_key_for("simplefin", account_id),
        kind=kind,
        flip_balance=flip,
    )


def _one(
    acct: FetchedAccount | None = None,
    req: AccountRequest | None = None,
    window: tuple[date, date] = WINDOW,
    context: dict[str, Any] | None = None,
    result_end: date | None = None,
    now: datetime = NOW,
) -> dict[str, Any]:
    out = _run([acct or _acct()], [req or _req()], window, context, result_end, now=now)
    assert len(out) == 1
    return out[0]  # type: ignore[return-value]


def _run(
    accts: list[FetchedAccount],
    reqs: list[AccountRequest],
    window: tuple[date, date] = WINDOW,
    context: dict[str, Any] | None = None,
    result_end: date | None = None,
    provider: str = "simplefin",
    now: datetime = NOW,
) -> list[Any]:
    result = FetchResult(accounts=accts, end=result_end)
    return to_statements(provider, result, reqs, window, context or CONTEXT, now=now)


# ---------------------------------------------------------------------------
# Account keys and kind guesses (A3 helpers, contract checked here)


def test_two_opaque_ids_at_one_institution_give_distinct_opaque_keys():
    a = account_key_for("simplefin", "ACT-abc-123")
    b = account_key_for("simplefin", "ACT-abc-124")
    assert a != b
    for key, raw in ((a, "ACT-abc-123"), (b, "ACT-abc-124")):
        assert raw not in key
        assert "abc" not in key
        assert _ACCOUNT_KEY.fullmatch(key)
    assert account_key_for("akahu", "ACT-abc-123") != a


@pytest.mark.parametrize(
    ("provider", "name", "ptype", "kind"),
    [
        ("simplefin", "Rewards CARD", None, "credit_card"),
        ("simplefin", "my visa", None, "credit_card"),
        ("simplefin", "Home LOAN", None, "loan"),
        ("simplefin", "High Yield SAVINGS", None, "savings"),
        ("simplefin", "Everyday", None, "checking"),
        ("akahu", "whatever", "CHECKING", "checking"),
        ("akahu", "whatever", "SAVINGS", "savings"),
        ("akahu", "whatever", "CREDITCARD", "credit_card"),
        ("akahu", "whatever", "LOAN", "loan"),
        ("akahu", "whatever", "KIWISAVER", "unknown"),
    ],
)
def test_kind_guesses(provider, name, ptype, kind):
    assert guess_kind(provider, name, ptype, None) == kind


# ---------------------------------------------------------------------------
# Finding 1: card balance sign, one rule


def test_card_balance_owed_is_negated_provider_balance():
    st = _one(_acct(balance="-500.00"), _req(kind="credit_card"))
    assert st["closing_balance"] == {"amount": 500.0, "as_of": END.isoformat()}


def test_card_positive_balance_is_a_credit():
    st = _one(_acct(balance="50.00"), _req(kind="credit_card"))
    assert st["closing_balance"]["amount"] == -50.0


def test_loan_follows_the_card_rule():
    st = _one(_acct(balance="-1200.00"), _req(kind="loan"))
    assert st["closing_balance"]["amount"] == 1200.0


def test_checking_balance_passes_through():
    st = _one(_acct(balance="-100.00"), _req(kind="checking"))
    assert st["closing_balance"]["amount"] == -100.0


def test_flip_balance_negates_the_result():
    st = _one(_acct(balance="-500.00"), _req(kind="credit_card", flip=True))
    assert st["closing_balance"]["amount"] == -500.0
    st = _one(_acct(balance="-100.00"), _req(kind="checking", flip=True))
    assert st["closing_balance"]["amount"] == 100.0


def test_sign_rule_lives_in_one_flag(monkeypatch):
    assert cn.PROVIDER_BALANCE_IS_HOLDER_SIDE is True
    assert closing_amount("credit_card", Decimal("-5"), False) == Decimal("5")
    monkeypatch.setattr(cn, "PROVIDER_BALANCE_IS_HOLDER_SIDE", False)
    assert closing_amount("credit_card", Decimal("-5"), False) == Decimal("-5")
    assert closing_amount("checking", Decimal("-5"), False) == Decimal("-5")


def test_positive_card_balance_with_mostly_charges_suggests_a_flip():
    rows = [_txn("a"), _txn("b"), _txn("c", amount="40.00", description="REFUND")]
    st = _one(_acct(txns=rows, balance="250.00"), _req(kind="credit_card"))
    assert st["closing_balance"]["amount"] == -250.0  # never flipped automatically
    assert st["warnings"] == ["connector_sign_check"]


@pytest.mark.parametrize(
    ("kind", "balance", "amounts", "flip"),
    [
        ("credit_card", "-250.00", ["-1.00", "-2.00"], False),  # owed: as expected
        ("credit_card", "250.00", ["1.00", "-2.00"], False),  # not mostly charges
        ("credit_card", "250.00", [], False),  # no rows to judge by
        (
            "credit_card",
            "250.00",
            ["-1.00", "-2.00"],
            True,
        ),  # the mapping already flips
        ("checking", "250.00", ["-1.00", "-2.00"], False),  # only cards
        ("credit_card", "0", ["-1.00"], False),
    ],
)
def test_no_sign_check_otherwise(kind, balance, amounts, flip):
    rows = [_txn(f"r{i}", amount=a) for i, a in enumerate(amounts)]
    st = _one(_acct(txns=rows, balance=balance), _req(kind=kind, flip=flip))
    assert "connector_sign_check" not in st["warnings"]


# ---------------------------------------------------------------------------
# Finding 3: UTC dates. A balance is dropped only when it is dated more than
# 24 hours after now (UTC); the period end is the window end.


def test_to_statements_never_reads_the_wall_clock():
    """``now`` is keyword-required: every caller passes its own clock."""
    with pytest.raises(TypeError):
        to_statements("simplefin", FetchResult(accounts=[]), [], WINDOW, CONTEXT)  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        to_statements("simplefin", FetchResult(accounts=[]), [], WINDOW, CONTEXT, now=None)  # type: ignore[arg-type]
    assert "datetime.now" not in Path(cn.__file__).read_text(encoding="utf-8")


def test_balance_dated_tomorrow_utc_is_kept_as_is():
    tomorrow = END + timedelta(days=1)
    st = _one(_acct(balance_date=tomorrow))
    assert st["closing_balance"] == {"amount": 100.0, "as_of": tomorrow.isoformat()}


def test_balance_dated_tomorrow_utc_is_kept_just_after_utc_midnight():
    tomorrow = END + timedelta(days=1)
    st = _one(
        _acct(balance_date=tomorrow),
        now=datetime(2026, 10, 4, 0, 1, tzinfo=timezone.utc),
    )
    assert st["closing_balance"]["as_of"] == tomorrow.isoformat()


def test_balance_more_than_a_day_ahead_is_dropped():
    st = _one(_acct(balance_date=END + timedelta(days=2)))
    assert st["closing_balance"] is None
    assert st["warnings"] == ["connector_balance_dropped"]


def test_future_check_uses_utc_not_local_offset():
    """A non-UTC ``now`` is converted first: 2026-10-04 20:00 at UTC-7 is
    2026-10-05 03:00 UTC, so a balance dated 2026-10-06 is within a day."""
    west = timezone(timedelta(hours=-7))
    st = _one(
        _acct(balance_date=date(2026, 10, 6)),
        now=datetime(2026, 10, 4, 20, 0, tzinfo=west),
    )
    assert st["closing_balance"]["as_of"] == "2026-10-06"


def test_naive_now_is_refused():
    with pytest.raises(ValueError):
        _one(now=datetime(2026, 10, 4, 12, 0))


def test_balance_before_the_window_keeps_its_date():
    day = START - timedelta(days=3)
    st = _one(_acct(balance_date=day))
    assert st["closing_balance"]["as_of"] == day.isoformat()


def test_balance_without_date_is_dropped():
    st = _one(_acct(balance_date=None))
    assert st["closing_balance"] is None
    assert st["warnings"] == ["connector_balance_dropped"]


def test_no_balance_is_not_a_dropped_balance():
    st = _one(_acct(balance=None, balance_date=None))
    assert st["warnings"] == []


def test_dropped_balance_alone_gives_no_statement():
    acct = _acct(txns=[], balance_date=END + timedelta(days=5))
    assert _run([acct], [_req()]) == []


def test_rows_after_the_period_end_are_skipped():
    late = _txn("late", posted=END + timedelta(days=1))
    st = _one(_acct(txns=[_txn(), _txn("last", posted=END), late]))
    assert [t["posted_date"] for t in st["transactions"]] == [
        "2026-09-20",
        END.isoformat(),
    ]
    assert st["period"]["end"] == END.isoformat()
    assert st["warnings"] == ["rows_skipped"]


def test_partial_end_before_since_gives_an_empty_period():
    since = date(2026, 9, 25)
    moved = date(2026, 9, 20)
    rows = [_txn("a", posted=date(2026, 9, 18)), _txn("b", posted=date(2026, 9, 26))]
    st = _one(_acct(txns=rows), _req(since=since), result_end=moved)
    assert st["period"] == {"start": moved.isoformat(), "end": moved.isoformat()}
    assert st["transactions"] == []
    assert st["warnings"] == [
        "rows_skipped",
        "connector_balance_only",
        "connector_partial",
    ]


def test_rows_after_a_partial_end_are_skipped():
    moved = date(2026, 9, 25)
    rows = [_txn("a", posted=date(2026, 9, 24)), _txn("b", posted=date(2026, 9, 26))]
    st = _one(_acct(txns=rows, balance=None), result_end=moved)
    assert [t["external_id"] for t in st["transactions"]] == ["simplefin:a"]
    assert st["warnings"] == ["rows_skipped", "connector_partial"]


def test_empty_txn_id_is_skipped():
    st = _one(_acct(txns=[_txn(""), _txn("  "), _txn("ok")]))
    assert [t["external_id"] for t in st["transactions"]] == ["simplefin:ok"]
    assert st["warnings"] == ["rows_skipped"]


def test_rows_before_the_accounts_own_since_are_dropped():
    since = date(2026, 9, 15)
    rows = [_txn("old", posted=date(2026, 9, 14)), _txn("new", posted=since)]
    st = _one(_acct(txns=rows), _req(since=since))
    assert [t["external_id"] for t in st["transactions"]] == ["simplefin:new"]
    assert st["period"] == {"start": since.isoformat(), "end": END.isoformat()}
    assert st["warnings"] == ["rows_skipped"]


def test_rows_skipped_is_never_repeated():
    rows = [_txn("", posted=END), _txn("old", posted=START - timedelta(days=1))]
    rows += [_txn("d"), _txn("d"), _txn("late", posted=END + timedelta(days=3))]
    st = _one(_acct(txns=rows, warnings=["rows_skipped"]))
    assert st["warnings"] == ["rows_skipped"]


def test_period_start_never_precedes_the_window():
    st = _one(_acct(), _req(since=START - timedelta(days=40)))
    assert st["period"]["start"] == START.isoformat()


# ---------------------------------------------------------------------------
# Finding 2: external ids. Stored dedupe keys are ``<account key>|<dedupe_base>``
# (models.py ImportTransaction.dedupe_key), so the account key scopes them.


def _dedupe_key(st: dict[str, Any], t: dict[str, Any]) -> str:
    return f"{st['account']['key']}|{t['dedupe_base']}"


def test_external_id_feeds_dedupe():
    st = _one()
    (t,) = st["transactions"]
    assert t["external_id"] == "simplefin:t1"
    assert t["dedupe_base"] == si.dedupe_base(
        t["posted_date"],
        t["amount"],
        t["merchant_key"],
        t["description"],
        0,
        fitid=t["external_id"],
    )


def test_same_id_in_two_accounts_gives_distinct_dedupe_keys():
    a = _acct("ACT-A", txns=[_txn("1788633284")])
    b = _acct("ACT-B", txns=[_txn("1788633284")])
    sa, sb = _run([a, b], [_req("ACT-A"), _req("ACT-B")])
    ta, tb = sa["transactions"][0], sb["transactions"][0]
    assert ta["external_id"] == tb["external_id"] == "simplefin:1788633284"
    assert _dedupe_key(sa, ta) != _dedupe_key(sb, tb)


def test_same_id_in_two_accounts_both_stored_on_the_server_path(client, db):  # noqa: F811
    a = _acct("ACT-A", txns=[_txn("1788633284")], balance=None)
    b = _acct("ACT-B", txns=[_txn("1788633284")], balance=None)
    out = _run([a, b], [_req("ACT-A"), _req("ACT-B")], context=SERVER_CONTEXT)
    add_connection(db)
    body = apply_body([as_apply(st) for st in out])
    res = do_apply(client, body)
    assert res.status_code == 200, res.text
    assert [i["txn_new"] for i in res.json()["imports"]] == [1, 1]
    again = do_apply(client, apply_body([as_apply(st) for st in out], batch="batch-2"))
    assert again.json()["skipped_files"] == [st["file_hash"] for st in out]


def _salt(account_id: str) -> str:
    return hashlib.sha256(account_id.encode()).hexdigest()[:8]


def test_true_duplicate_in_one_account_is_skipped():
    rows = [_txn("dup", amount="-1.00"), _txn("dup", amount="-1.00"), _txn("other")]
    st = _one(_acct(txns=rows))
    assert [t["amount"] for t in st["transactions"]] == [-1.0, -12.34]
    assert st["warnings"] == ["rows_skipped"]


def test_same_id_with_a_different_amount_keeps_both():
    rows = [
        _txn("dup", amount="-1.00"),
        _txn("dup", amount="-2.00"),
        _txn("dup", amount="-3.00"),
        _txn("dup", amount="-1.00", posted=date(2026, 9, 21)),
    ]
    st = _one(_acct(txns=rows))
    salted = f"simplefin:dup~{_salt('ACT-1')}"
    assert [t["external_id"] for t in st["transactions"]] == [
        "simplefin:dup",
        salted,
        salted + "~2",
        salted + "~3",
    ]
    assert [t["amount"] for t in st["transactions"]] == [-1.0, -2.0, -3.0, -1.0]
    assert st["warnings"] == []
    bases = {t["dedupe_base"] for t in st["transactions"]}
    assert len(bases) == 4


def test_salted_ids_are_stable_across_runs():
    rows = [_txn("dup", amount="-1.00"), _txn("dup", amount="-2.00")]
    first = _one(_acct(txns=rows))
    second = _one(_acct(txns=list(rows)))
    assert first["transactions"] == second["transactions"]
    assert first["file_hash"] == second["file_hash"]


def test_same_as_mapping_skips_only_true_duplicates_across_accounts():
    shared = account_key_for("simplefin", "ACT-A")
    a = _acct("ACT-A", txns=[_txn("x1"), _txn("x2"), _txn("x4", amount="-5.00")])
    b = _acct("ACT-B", txns=[_txn("x2"), _txn("x3"), _txn("x4", amount="-6.00")])
    sa, sb = _run([a, b], [_req("ACT-A"), _req("ACT-B", key=shared)])
    assert [t["external_id"] for t in sa["transactions"]] == [
        "simplefin:x1",
        "simplefin:x2",
        "simplefin:x4",
    ]
    assert [t["external_id"] for t in sb["transactions"]] == [
        "simplefin:x3",
        f"simplefin:x4~{_salt('ACT-B')}",
    ]
    assert sa["warnings"] == [] and sb["warnings"] == ["rows_skipped"]


def test_external_id_is_stable_across_syncs():
    first = _one()["transactions"][0]
    later = _one(window=(START + timedelta(days=10), END + timedelta(days=10)))
    assert later["transactions"][0]["external_id"] == first["external_id"]
    assert later["transactions"][0]["dedupe_base"] == first["dedupe_base"]


def test_long_ids_are_hashed_not_truncated():
    long_id = "T" * 256
    ext = external_id_for("simplefin", long_id)
    assert len(ext) <= 200
    assert ext.startswith("simplefin:#")
    assert ext == external_id_for("simplefin", long_id)
    assert ext != external_id_for("simplefin", "T" * 255 + "U")
    assert external_id_for("simplefin", "t1") == "simplefin:t1"
    # A verbatim id that looks like the hashed form is hashed too.
    assert external_id_for("simplefin", "#abc").startswith("simplefin:#")
    assert external_id_for("simplefin", "#abc") != "simplefin:#abc"
    fits = "T" * (200 - len("simplefin:"))
    assert external_id_for("simplefin", fits) == "simplefin:" + fits


# ---------------------------------------------------------------------------
# Finding 4 and the warning vocabulary


def test_fetched_account_warnings_are_carried():
    st = _one(_acct(warnings=["rows_skipped"]))
    assert st["warnings"] == ["rows_skipped"]


def test_unknown_fetched_warning_is_not_passed_through():
    st = _one(_acct(warnings=["rows_skipped", "something_new", "rows_skipped"]))
    assert st["warnings"] == ["rows_skipped"]


def test_balance_only_account_warns():
    st = _one(_acct(txns=[]))
    assert st["warnings"] == ["connector_balance_only"]
    assert st["transactions"] == []


def test_partial_result_moves_window_end_and_warns():
    moved = END - timedelta(days=5)
    st = _one(_acct(balance_date=END), result_end=moved)
    assert st["warnings"] == ["connector_partial"]
    assert st["period"]["end"] == moved.isoformat()
    assert st["file_name"] == f"SimpleFIN sync {moved.isoformat()}"
    assert st["closing_balance"]["as_of"] == END.isoformat()


def test_result_end_after_the_window_is_clamped():
    st = _one(result_end=END + timedelta(days=3))
    assert st["period"]["end"] == END.isoformat()
    assert "connector_partial" not in st["warnings"]


def test_every_emitted_warning_is_in_the_vocabulary():
    accts = [
        _acct("A", warnings=["rows_skipped"]),
        _acct("B", txns=[]),
        _acct("C", currency="XBTC"),
        _acct("D", txns=[], balance=None, error="connector_account_error"),
    ]
    reqs = [_req(x) for x in "ABCD"]
    out = _run(accts, reqs, result_end=END)
    for st in out:
        assert set(st["warnings"]) <= set(WARNINGS)
    for item in dropped_accounts(FetchResult(accounts=accts), reqs):
        assert item["code"] in WARNINGS


# ---------------------------------------------------------------------------
# Omitted accounts


def test_empty_account_is_omitted():
    assert _run([_acct(txns=[], balance=None)], [_req()]) == []


def test_errored_account_is_omitted_and_reported():
    bad = _acct(txns=[], balance=None, error="connector_account_error")
    assert _run([bad], [_req()]) == []
    assert dropped_accounts(FetchResult(accounts=[bad]), [_req()]) == [
        {"provider_account_id": "ACT-1", "code": "connector_account_error"}
    ]


@pytest.mark.parametrize(
    "currency", ["", "US", "USDT", "https://example.com/pts", "U$D"]
)
def test_non_iso_currency_gives_no_statement(currency):
    acct = _acct(currency=currency)
    assert _run([acct], [_req()]) == []
    assert dropped_accounts(FetchResult(accounts=[acct]), [_req()]) == [
        {"provider_account_id": "ACT-1", "code": "currency_unsupported"}
    ]


def test_lowercase_iso_currency_is_accepted():
    assert len(_run([_acct(currency="usd")], [_req()])) == 1
    assert (
        dropped_accounts(FetchResult(accounts=[_acct(currency="usd")]), [_req()]) == []
    )


def test_unrequested_accounts_are_ignored():
    out = _run([_acct("ACT-1"), _acct("ACT-X")], [_req("ACT-1")])
    assert len(out) == 1


def test_bad_kind_is_bad_request():
    with pytest.raises(ConnectorError) as info:
        _run([_acct()], [_req(kind="brokerage")])
    assert info.value.error_type == "bad_request"


def test_unknown_provider_is_bad_request():
    with pytest.raises(ConnectorError) as info:
        _run([_acct()], [_req()], provider="plaid")
    assert info.value.error_type == "bad_request"


# ---------------------------------------------------------------------------
# Statement fields


def test_institution_is_masked():
    st = _one(_acct(institution="Bank of bob@example.com 123456789"))
    assert st["account"]["institution"] == si.mask_description(
        "Bank of bob@example.com 123456789"
    )
    assert "bob@example.com" not in st["account"]["institution"]
    assert "123456789" not in st["account"]["institution"]
    assert _one(_acct(institution="   "))["account"]["institution"] is None


def test_statement_shape():
    st = _one(_acct(institution="Example Credit Union " + "x" * 200))
    assert st["origin"] == "connector"
    assert st["format"] == "connector"
    assert st["parser"] == "connector:simplefin"
    assert st["file_name"] == "SimpleFIN sync 2026-10-04"
    assert st["account"]["key"] == account_key_for("simplefin", "ACT-1")
    assert st["account"]["kind"] == "checking"
    assert st["account"]["last4"] is None
    assert len(st["account"]["institution"]) == 120
    assert st["account"]["institution"].startswith("Example Credit Union")
    assert st["extras"] is None
    assert re.fullmatch(r"[0-9a-f]{64}", st["file_hash"])


@pytest.mark.parametrize(("provider", "label"), [("akahu", "Akahu"), ("demo", "Demo")])
def test_parser_and_file_name_per_provider(provider, label):
    req = AccountRequest("ACT-1", START, account_key_for(provider, "ACT-1"), "checking")
    (st,) = _run([_acct()], [req], provider=provider)
    assert st["parser"] == f"connector:{provider}"
    assert st["file_name"] == f"{label} sync 2026-10-04"
    assert st["transactions"][0]["external_id"] == f"{provider}:t1"


def test_mapped_kind_wins_over_the_name():
    st = _one(_acct(), _req(kind="savings"))
    assert st["account"]["kind"] == "savings"


def test_descriptions_are_masked_and_capped():
    raw = "PAYMENT TO 4111111111111111 bob@example.com " + "Z" * 300
    st = _one(_acct(txns=[_txn(description=raw)]))
    (t,) = st["transactions"]
    assert "4111111111111111" not in t["description"]
    assert "bob@example.com" not in t["description"]
    assert len(t["description"]) <= 120
    assert "4111" not in t["merchant_key"]


def test_payee_used_when_description_is_empty():
    st = _one(_acct(txns=[_txn(description="", payee="Corner Cafe")]))
    assert st["transactions"][0]["description"] == "Corner Cafe"


def test_row_shape_and_kind():
    rows = [
        _txn("a", amount="-4.50"),
        _txn("b", amount="1960.00", description="PAYROLL ACME"),
    ]
    st = _one(_acct(txns=rows))
    a, b = st["transactions"]
    assert (a["row"], b["row"]) == (0, 1)
    assert a["amount"] == -4.5 and isinstance(a["amount"], float)
    assert a["kind"] == "expense"
    assert b["kind"] == "income"
    assert a["merchant_key"] == si.merchant_key("STARBUCKS STORE")


def test_seed_rules_categorize():
    st = _one()
    (t,) = st["transactions"]
    assert (t["category_id"], t["category_source"]) == ("c-dining", "seed")


def test_user_rule_beats_seed_rule():
    key = si.merchant_key("STARBUCKS STORE")
    ctx = {"categories": CATEGORIES, "rules": {key: {"category_id": "c-shop"}}}
    (t,) = _one(context=ctx)["transactions"]
    assert (t["category_id"], t["category_source"]) == ("c-shop", "rule")


def test_origin_forced_to_connector_even_if_context_says_otherwise():
    st = _one(context={**CONTEXT, "origin": "file"})
    assert st["origin"] == "connector"


def test_file_hash_stable_and_sensitive():
    base = _one()["file_hash"]
    assert _one()["file_hash"] == base
    rows = [_txn("a"), _txn("b")]
    flipped = [_txn("b"), _txn("a")]
    assert _one(_acct(txns=rows))["file_hash"] == _one(_acct(txns=flipped))["file_hash"]
    assert _one(_acct(balance="100.01"))["file_hash"] != base
    assert _one(_acct(txns=[_txn(amount="-12.35")]))["file_hash"] != base
    assert _one(window=(START, END - timedelta(days=1)))["file_hash"] != base
    assert _one(window=(START + timedelta(days=1), END))["file_hash"] != base
    assert _one(_acct(balance_date=END - timedelta(days=1)))["file_hash"] != base


# ---------------------------------------------------------------------------
# Contract: what the wizard sends to Apply validates


def test_output_validates_against_apply_models():
    accts = [
        _acct("ACT-1", balance="-500.00", warnings=["rows_skipped"]),
        _acct("ACT-2", txns=[]),
        _acct("ACT-3", txns=[_txn(description="x" * 2000)], balance=None),
    ]
    reqs = [
        _req("ACT-1", kind="credit_card"),
        _req("ACT-2"),
        _req("ACT-3", kind="unknown"),
    ]
    out = _run(accts, reqs)
    assert len(out) == 3
    for st in out:
        ApplyStatement.model_validate(as_apply(st))
    ApplyRequest.model_validate(
        {"batch_id": "b-1", "statements": [as_apply(s) for s in out]}
    )


def test_output_survives_a_second_finalize():
    """finalize_statement is idempotent on our output (analyze does the same)."""
    (st,) = _run([_acct()], [_req()])
    copy = json.loads(json.dumps(st))
    again = si.finalize_statement(
        copy, {**CONTEXT, "origin": "connector"}, st["file_name"]
    )
    assert again == st


# ---------------------------------------------------------------------------
# End to end from the recorded SimpleFIN window


def test_recorded_window_end_to_end(monkeypatch):
    monkeypatch.setattr(sf, "today", lambda: END)
    doc = json.loads((FIXTURES / "accounts_window.json").read_text(encoding="utf-8"))
    transport = httpx.MockTransport(lambda request: httpx.Response(200, json=doc))
    creds = SimpleFinCredentials(
        base_url="https://beta-bridge.simplefin.org/simplefin",
        username="u",
        password="p",
    )
    reqs = [
        _req("Demo Savings", kind="savings"),
        _req("Demo Checking"),
        _req("Demo Empty Account"),
    ]
    with SafeClient("simplefin", transport=transport) as http_client:
        result = SimpleFinProvider().fetch(http_client, creds, reqs, START, END)
    out = to_statements("simplefin", result, reqs, WINDOW, CONTEXT, now=NOW)
    # The empty demo account has no rows; it carries a balance, so it stays.
    assert len(out) == 3
    assert out[2]["warnings"] == ["connector_balance_only"]
    keys = [_dedupe_key(st, t) for st in out for t in st["transactions"]]
    assert len(keys) == len(set(keys))  # the demo repeats ids across accounts
    for st in out:
        ApplyStatement.model_validate(as_apply(st))


def test_fetched_account_repr_hides_institution():
    acct = replace(_acct(), institution="Example Secret Bank")
    assert "Example Secret Bank" not in repr(acct)


def test_balance_dated_utc_tomorrow_is_recorded_as_today_at_apply(client, db):  # noqa: F811
    """The A4 handoff, resolved in B3: a balance dated tomorrow by UTC is kept
    here, and Apply records a connector balance dated the local day after
    ``today()`` as today's snapshot (server ``_record_balance``, browser
    ``recordBalance``). Two days ahead is still ``skipped_future``."""
    add_liability(db)
    add_connection(db)
    acct = _acct(balance="-500.00", balance_date=END + timedelta(days=1))
    (st,) = _run([acct], [_req(kind="credit_card")], context=SERVER_CONTEXT)
    body = apply_body([{**as_apply(st), "liability_id": "L1"}])
    res = do_apply(client, body)
    assert res.status_code == 200, res.text
    assert res.json()["imports"][0]["balance"] == "recorded"
    with db.get_session() as s:
        liab = s.get(Liability, "L1")
        assert (liab.current_balance, liab.balance_as_of) == (500.0, END)


# ---------------------------------------------------------------------------
# Shared fixture for PR B and PR C: a connector sync produced by to_statements.
# PR C tests the wizard end to end in vitest against the browser
# parseStatement with this file. Regenerate after a mapping change with:
#   python -c "from tests.connectors.test_normalize import write_fixture; write_fixture()"

STATEMENTS_DIR = FIXTURES.parent / "statements"
STATEMENT_FIXTURE = STATEMENTS_DIR / "simplefin_sync.json"
FIXTURE_CONTEXT: dict[str, Any] = {
    "categories": [
        {"id": "cat-Dining", "name": "Food & Dining"},
        {"id": "cat-Groceries", "name": "Groceries"},
    ],
    "rules": {"CORNER CAFE": {"category_id": "cat-Dining"}},
}


def fixture_statements() -> dict[str, Any]:
    checking = _acct(
        "ACT-CHK",
        txns=[
            _txn("c1", date(2026, 9, 8), "-4.50", "STARBUCKS STORE 1234"),
            _txn("c2", date(2026, 9, 12), "-61.20", "SAFEWAY #2201"),
            _txn("c3", date(2026, 9, 15), "2400.00", "PAYROLL EXAMPLE CO"),
            _txn("c4", date(2026, 9, 18), "-15.49", "NETFLIX.COM"),
            _txn("c4", date(2026, 9, 18), "-15.49", "NETFLIX.COM"),
            _txn("c5", date(2026, 9, 22), "-9.75", "", payee="Corner Cafe"),
        ],
        balance="1520.33",
        balance_date=END,
        institution="Example Credit Union",
    )
    card = _acct(
        "ACT-CARD",
        txns=[
            _txn("k1", date(2026, 9, 10), "-42.00", "SHELL OIL 5739"),
            _txn("k1", date(2026, 9, 11), "-18.00", "SHELL OIL 5739"),
            _txn("k2", date(2026, 9, 25), "300.00", "PAYMENT THANK YOU"),
        ],
        balance="-812.40",
        balance_date=END + timedelta(days=1),
        institution="Example Card Services",
    )
    reqs = [_req("ACT-CHK"), _req("ACT-CARD", kind="credit_card")]
    statements = to_statements(
        "simplefin",
        FetchResult(accounts=[checking, card]),
        reqs,
        WINDOW,
        FIXTURE_CONTEXT,
        now=NOW,
    )
    return {
        "generated_by": "tests/connectors/test_normalize.py fixture_statements",
        "provider": "simplefin",
        "window": {"start": START.isoformat(), "end": END.isoformat()},
        "statements": statements,
    }


def _fixture_text() -> str:
    return json.dumps(fixture_statements(), indent=2, sort_keys=True) + "\n"


def write_fixture() -> None:
    STATEMENTS_DIR.mkdir(parents=True, exist_ok=True)
    STATEMENT_FIXTURE.write_text(_fixture_text(), encoding="utf-8")


def test_statement_fixture_matches_the_mapping():
    assert STATEMENT_FIXTURE.read_text(encoding="utf-8") == _fixture_text()


def test_statement_fixture_files_and_hygiene():
    names = {p.name for p in STATEMENTS_DIR.iterdir() if p.is_file()}
    assert names == {"simplefin_sync.json"}
    text = STATEMENT_FIXTURE.read_text(encoding="utf-8")
    assert chr(0x2014) not in text
    assert "@" not in text
    doc = json.loads(text)
    for st in doc["statements"]:
        ApplyStatement.model_validate(as_apply(st))
        assert set(st["warnings"]) <= set(WARNINGS)
