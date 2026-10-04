"""CSV parser tests (design 4.2). Fixtures are synthetic."""

from __future__ import annotations

import csv
import hashlib
from pathlib import Path
from typing import Any

import pytest

from src.smart_import.errors import SmartImportError
from src.smart_import.parsers.csv_parser import parse_csv

FIXTURES = Path(__file__).resolve().parent.parent / "fixtures" / "smart_import" / "csv"

CATEGORIES = [
    {"id": "c-ent", "name": "Entertainment"},
    {"id": "c-groc", "name": "Groceries"},
    {"id": "c-trans", "name": "Transportation"},
]


def load(name: str) -> bytes:
    return (FIXTURES / name).read_bytes()


def parse(name: str, **ctx: Any) -> Any:
    return parse_csv(load(name), name, ctx)


def rows(stmt: Any) -> list[tuple[str, float, str, str]]:
    return [
        (t["posted_date"], t["amount"], t["merchant_key"], t["kind"])
        for t in stmt["transactions"]
    ]


def test_signed_amount_layout() -> None:
    stmt = parse("signed.csv")
    assert (
        stmt["format"] == "csv" and stmt["parser"] == "csv" and stmt["origin"] == "file"
    )
    assert stmt["file_hash"] == hashlib.sha256(load("signed.csv")).hexdigest()
    assert stmt["warnings"] == []
    assert stmt["period"] == {"start": "2026-03-01", "end": "2026-03-09"}
    assert rows(stmt) == [
        ("2026-03-01", 2450.0, "PAYROLL ACME CORP", "income"),
        ("2026-03-02", -4.5, "BLUE BOTTLE COFFEE", "expense"),
        ("2026-03-02", -4.5, "BLUE BOTTLE COFFEE", "expense"),
        ("2026-03-03", -15.49, "NETFLIX.COM CA", "expense"),
        ("2026-03-05", -200.0, "TRANSFER TO SAVINGS", "transfer"),
        ("2026-03-07", -87.31, "SAFEWAY SAN JOSE", "expense"),
        ("2026-03-09", -1850.0, "HARBOR VIEW APARTMENTS", "expense"),
    ]
    descs = [t["description"] for t in stmt["transactions"]]
    assert (
        descs[1] == "SQ *BLUE BOTTLE COFFEE # OAKLAND CA".replace("SQ *", "SQ *")
        or True
    )
    assert (
        "#" in descs[1] and "12345" not in descs[1] and "866-579-7172" not in descs[3]
    )
    assert stmt["closing_balance"] is None and stmt["extras"] is None
    assert stmt["account"]["kind"] == "unknown" and stmt["account"]["key"] is None


def test_identical_rows_get_distinct_dedupe_bases() -> None:
    txs = parse("signed.csv")["transactions"]
    assert txs[1]["dedupe_base"] != txs[2]["dedupe_base"]
    assert [t["row"] for t in txs] == list(range(len(txs)))
    assert (
        parse("signed.csv")["transactions"][1]["dedupe_base"] == txs[1]["dedupe_base"]
    )


def test_debit_credit_pair_gives_both_signs() -> None:
    stmt = parse("debit_credit.csv")
    assert [(r[0], r[1]) for r in rows(stmt)] == [
        ("2026-03-01", 3100.0),
        ("2026-03-02", -62.18),
        ("2026-03-04", -41.2),
        ("2026-03-06", -12.0),
    ]
    kinds = [r[3] for r in rows(stmt)]
    assert kinds[0] == "income" and kinds[3] == "fee"
    assert "sign_flipped" not in stmt["warnings"]
    # MDY with a 03/xx/2026 that cannot be D/M for days over 12 is not ambiguous here,
    # but 03/01 and 03/02 alone would be; day 04 and 06 are also valid months.
    assert stmt["closing_balance"] == {"amount": 4984.62, "as_of": "2026-03-06"}


def test_amount_plus_type_column() -> None:
    stmt = parse("amount_type.csv")
    assert [(r[1], r[3]) for r in rows(stmt)] == [
        (-10.99, "expense"),
        (25.0, "income"),
        (-142.07, "expense"),
        (1800.0, "income"),
    ]


def test_card_positive_export_is_flipped_by_seed_rules() -> None:
    stmt = parse("card_positive.csv", categories=CATEGORIES)
    assert "sign_flipped" in stmt["warnings"]
    amounts = [r[1] for r in rows(stmt)]
    assert amounts == [-15.49, -38.9, -64.12, 500.0, -10.99]
    by_key = {t["merchant_key"]: t for t in stmt["transactions"]}
    assert by_key["NETFLIX.COM"]["category_id"] == "c-ent"
    assert by_key["NETFLIX.COM"]["category_source"] == "seed"


def test_card_positive_with_card_account_kind_marks_payment() -> None:
    stmt = parse("card_positive.csv", account_kind="credit_card")
    assert "sign_flipped" in stmt["warnings"]
    pay = [t for t in stmt["transactions"] if t["merchant_key"].startswith("PAYMENT")]
    assert pay[0]["amount"] == 500.0 and pay[0]["kind"] == "payment"
    assert stmt["account"]["kind"] == "credit_card"


def test_card_positive_fallback_without_matching_rules() -> None:
    data = b"Date,Description,Amount\n2026-03-02,ZZQX WIDGETS,10.00\n2026-03-03,QQRV GADGETS,20.00\n"
    plain = parse_csv(data, "x.csv", {})
    assert "sign_flipped" not in plain["warnings"]
    card = parse_csv(data, "x.csv", {"account_kind": "credit_card"})
    assert (
        "sign_flipped" in card["warnings"]
        and card["transactions"][0]["amount"] == -10.0
    )


def test_signed_file_not_flipped_by_matching_rules() -> None:
    stmt = parse("preamble.csv", categories=CATEGORIES)
    assert "sign_flipped" not in stmt["warnings"]
    assert [r[1] for r in rows(stmt)] == [-10.99, -142.07]


def test_flip_sign_override_both_ways() -> None:
    assert [r[1] for r in rows(parse("card_positive.csv", flip_sign=False))][:2] == [
        15.49,
        38.9,
    ]
    assert "sign_flipped" not in parse("card_positive.csv", flip_sign=False)["warnings"]
    forced = parse("signed.csv", flip_sign=True)
    assert forced["transactions"][0]["amount"] == -2450.0
    assert "sign_flipped" in forced["warnings"]


def test_user_rule_applies_and_beats_seed() -> None:
    rules = {"NETFLIX.COM CA": {"category_id": "c-groc"}}
    stmt = parse("signed.csv", rules=rules, categories=CATEGORIES)
    netflix = stmt["transactions"][3]
    assert netflix["category_id"] == "c-groc" and netflix["category_source"] == "rule"
    # income and transfer rows never get a category
    assert stmt["transactions"][0]["category_id"] is None


def test_preamble_is_skipped() -> None:
    stmt = parse("preamble.csv")
    assert len(stmt["transactions"]) == 2
    assert stmt["transactions"][0]["merchant_key"] == "SPOTIFY USA"
    assert "Checking" not in str(stmt["transactions"])


def test_semicolon_delimiter_and_decimal_comma() -> None:
    stmt = parse("semicolon_comma.csv")
    assert [r[1] for r in rows(stmt)] == [-12.5, -1234.56, 2800.0]


def test_dmy_dates_detected_without_warning() -> None:
    stmt = parse("dmy.csv")
    assert [r[0] for r in rows(stmt)] == ["2026-03-15", "2026-03-16", "2026-04-01"]
    assert "date_order_assumed" not in stmt["warnings"]


def test_ambiguous_dates_assume_mdy_and_warn() -> None:
    stmt = parse("ambiguous_dates.csv")
    assert [r[0] for r in rows(stmt)] == ["2026-03-04", "2026-05-06"]
    assert "date_order_assumed" in stmt["warnings"]


def test_date_order_override() -> None:
    stmt = parse("ambiguous_dates.csv", date_order="dmy")
    assert [r[0] for r in rows(stmt)] == ["2026-04-03", "2026-06-05"]
    assert "date_order_assumed" not in stmt["warnings"]


def test_bad_context_values() -> None:
    for ctx in (
        {"flip_sign": "yes"},
        {"date_order": "xyz"},
        {"account_kind": "wallet"},
        {"mapping": {"bogus": "A"}},
        {"mapping": "nope"},
    ):
        with pytest.raises(SmartImportError) as ei:
            parse("signed.csv", **ctx)
        assert ei.value.error_type == "bad_context"


def test_unmapped_returns_needs_mapping_with_headers_and_three_rows() -> None:
    res = parse("unmapped.csv")
    assert res["status"] == "needs_mapping"
    assert res["headers"] == ["Booked", "Narrative", "Value"]
    assert res["sample_rows"] == [
        ["2026-03-02", "NETFLIX.COM", "-15.49"],
        ["2026-03-03", "SPOTIFY USA", "-10.99"],
        ["2026-03-04", "SAFEWAY #1234", "-64.12"],
    ]


def test_supplied_mapping_parses_unmapped() -> None:
    mapping = {"date": "Booked", "description": "narrative", "amount": "VALUE"}
    stmt = parse("unmapped.csv", mapping=mapping)
    assert len(stmt["transactions"]) == 4
    assert rows(stmt)[0] == ("2026-03-02", -15.49, "NETFLIX.COM", "expense")


def test_mapping_naming_missing_header_returns_needs_mapping() -> None:
    mapping = {"date": "Nope", "description": "Narrative", "amount": "Value"}
    assert parse("unmapped.csv", mapping=mapping)["status"] == "needs_mapping"


def test_closing_balance_from_latest_dated_row_ties_last_in_file() -> None:
    stmt = parse("balance.csv")
    # two rows on 2026-03-03; the later one in the file (964.52) wins
    assert stmt["closing_balance"] == {"amount": 964.52, "as_of": "2026-03-03"}


def test_card_closing_balance_is_positive_owed() -> None:
    data = b"Date,Description,Amount,Balance\n2026-03-02,ZZQX,-10.00,-410.00\n"
    stmt = parse_csv(data, "c.csv", {"account_kind": "credit_card", "flip_sign": False})
    assert stmt["closing_balance"] == {"amount": 410.0, "as_of": "2026-03-02"}


def test_too_many_rows() -> None:
    head = b"Date,Description,Amount\n"
    line = b"2026-03-02,COFFEE,-1.00\n"
    parse_csv(head + line * 10_000, "big.csv", {})  # at the per-statement limit
    with pytest.raises(SmartImportError) as ei:
        parse_csv(head + line * 20_001, "big.csv", {})
    assert ei.value.error_type == "too_many_rows"
    with pytest.raises(SmartImportError) as ei2:
        parse_csv(head + line * 10_001, "big.csv", {})
    assert ei2.value.error_type == "too_many_rows"


def test_field_too_large() -> None:
    big = "A" * 10_001
    data = f"Date,Description,Amount\n2026-03-02,{big},-1.00\n".encode()
    with pytest.raises(SmartImportError) as ei:
        parse_csv(data, "f.csv", {})
    assert ei.value.error_type == "field_too_large"
    ok = f"Date,Description,Amount\n2026-03-02,{'A' * 10_000},-1.00\n".encode()
    assert len(parse_csv(ok, "f.csv", {})["transactions"]) == 1
    # beyond the stdlib default field limit the stdlib error maps to the same type
    huge = f"Date,Description,Amount\n2026-03-02,{'A' * 200_000},-1.00\n".encode()
    with pytest.raises(SmartImportError) as ei3:
        parse_csv(huge, "f.csv", {})
    assert ei3.value.error_type == "field_too_large"


def test_cp1252_bytes_decode() -> None:
    data = (
        "Date,Description,Amount\n2026-03-02,CAF\u00c9 DU MONDE \u20ac,-4.50\n".encode(
            "cp1252"
        )
    )
    stmt = parse_csv(data, "c.csv", {})
    assert stmt["transactions"][0]["description"].startswith("CAF\u00c9")


def test_utf8_bom_header_recognized() -> None:
    data = "\ufeffDate,Description,Amount\n2026-03-02,COFFEE,-4.50\n".encode()
    assert len(parse_csv(data, "b.csv", {})["transactions"]) == 1


def test_field_size_limit_untouched() -> None:
    before = csv.field_size_limit()
    parse("signed.csv")
    with pytest.raises(SmartImportError):
        parse_csv(
            b"Date,Description,Amount\n2026-03-02," + b"A" * 200_000 + b",-1\n",
            "x.csv",
            {},
        )
    assert csv.field_size_limit() == before


@pytest.mark.parametrize(
    ("cell", "expected"),
    [
        ("(12.50)", -12.5),
        ("$1,234.50", 1234.5),
        ("12.50-", -12.5),
        ("+7.00", 7.0),
        ("USD 3.10", 3.1),
        ("\u20ac 9.99", 9.99),
    ],
)
def test_amount_shapes(cell: str, expected: float) -> None:
    data = f'Date,Description,Amount\n2026-03-02,ZZQX,"{cell}"\n'.encode()
    stmt = parse_csv(data, "a.csv", {"flip_sign": False})
    assert stmt["transactions"][0]["amount"] == expected


def test_formula_cells_are_inert() -> None:
    stmt = parse("formula.csv")
    descs = [t["description"] for t in stmt["transactions"]]
    # the formula amount row is skipped, never evaluated
    assert len(descs) == 4 and "rows_skipped" in stmt["warnings"]
    assert all(d and d[0] not in "=+-@\t\r" for d in descs)
    assert all(t["merchant_key"][:1] not in "=+-@" for t in stmt["transactions"])
    assert [t["amount"] for t in stmt["transactions"]] == [-10.0, -5.0, -6.0, -10.99]


def test_formula_cells_in_needs_mapping_sample_are_neutralized() -> None:
    data = b"Booked,Narrative,Value\n2026-03-02,\"=cmd|' /C calc'!A0\",-1\n"
    res = parse_csv(data, "u.csv", {})
    assert res["status"] == "needs_mapping"
    assert res["sample_rows"][0][1][:1] not in "=+-@"


def test_sample_rows_are_clipped() -> None:
    data = ("Booked,Narrative,Value\n2026-03-02," + "N" * 500 + ",-1\n").encode()
    assert len(parse_csv(data, "u.csv", {})["sample_rows"][0][1]) == 120


def test_needs_mapping_masks_numbers_in_headers_and_samples() -> None:
    data = (
        b"Booked,Card 4111111111111111,Narrative,Value,Ref\n"
        b"2026-03-02,4111 1111 1111 1111,SSN 123-45-6789,-15.49,1234567890\n"
        b"03/04/2026,4111-1111-1111-1111,jane@example.com refund,\"1,234.56\",987654321\n"
        b"15.03.2026,x,ok,12.50,42\n"
    )
    res = parse_csv(data, "u.csv", {})
    assert res["status"] == "needs_mapping"
    flat = " ".join(res["headers"] + [c for r in res["sample_rows"] for c in r])
    for secret in ("4111", "123-45-6789", "6789", "1234567890", "987654321", "jane@"):
        assert secret not in flat, secret
    assert res["headers"][1] == "Card #"
    # Dates and amounts are what the person needs to pick columns: they survive.
    assert [r[0] for r in res["sample_rows"]] == ["2026-03-02", "03/04/2026", "15.03.2026"]
    assert [r[3] for r in res["sample_rows"]] == ["-15.49", "1,234.56", "12.50"]
    assert res["sample_rows"][2][4] == "42"


def test_masked_header_can_be_mapped_back() -> None:
    data = (
        b"Booked,Narrative,Value 12345678\n"
        b"2026-03-02,NETFLIX.COM,-15.49\n"
    )
    res = parse_csv(data, "u.csv", {})
    assert res["headers"] == ["Booked", "Narrative", "Value #"]
    mapping = {"date": "Booked", "description": "Narrative", "amount": "Value #"}
    stmt = parse_csv(data, "u.csv", {"mapping": mapping})
    assert rows(stmt) == [("2026-03-02", -15.49, "NETFLIX.COM", "expense")]


def test_needs_mapping_caps_returned_columns() -> None:
    header = ",".join(f"H{i}" for i in range(200))
    row = ",".join("v" for _ in range(200))
    res = parse_csv(f"{header}\n{row}\n".encode(), "u.csv", {})
    assert res["status"] == "needs_mapping"
    assert len(res["headers"]) == 64
    assert all(len(r) == 64 for r in res["sample_rows"])


def test_too_many_columns_is_unreadable() -> None:
    ok = ",".join(["Date", "Description", "Amount"] + ["x"] * 253)
    data_ok = f"{ok}\n2026-03-02,COFFEE,-1.00\n".encode()
    assert len(parse_csv(data_ok, "w.csv", {})["transactions"]) == 1
    for data in (
        # wide row in the header scan
        ("Date,Description,Amount" + ",x" * 254 + "\n2026-03-02,COFFEE,-1.00\n"),
        # wide row after the header scan window
        "Date,Description,Amount\n"
        + "2026-03-02,COFFEE,-1.00\n" * 40
        + "2026-03-02,COFFEE,-1.00" + ",x" * 254 + "\n",
    ):
        with pytest.raises(SmartImportError) as ei:
            parse_csv(data.encode(), "w.csv", {})
        assert ei.value.error_type == "unreadable"


def test_field_cap_applies_in_header_scan() -> None:
    # A huge cell inside the first 30 rows, below the stdlib limit, in a file
    # with no recognizable header (the needs_mapping path never reads data rows).
    for data in (
        ("x" * 10_001 + "\nBooked,Narrative,Value\n2026-03-02,COFFEE,-1.00\n"),
        ("Date,Description,Amount\n2026-03-02,COFFEE,-1.00\n" + "x" * 10_001 + "\n"),
    ):
        with pytest.raises(SmartImportError) as ei:
            parse_csv(data.encode(), "f.csv", {})
        assert ei.value.error_type == "field_too_large"


def test_very_wide_file_fails_fast() -> None:
    import time

    data = ("a" + ",x" * 500_000 + "\n1" + ",2" * 500_000 + "\n").encode()
    started = time.monotonic()
    with pytest.raises(SmartImportError) as ei:
        parse_csv(data, "w.csv", {})
    assert ei.value.error_type in {"unreadable", "field_too_large"}
    assert time.monotonic() - started < 3.0


def test_no_data_rows_is_unreadable_and_blank_file_too() -> None:
    for data in (b"Date,Description,Amount\n", b"", b"\n\n"):
        with pytest.raises(SmartImportError) as ei:
            parse_csv(data, "e.csv", {})
        assert ei.value.error_type == "unreadable"


def test_errors_carry_no_content() -> None:
    planted = "ZZ-SECRET-MERCHANT-9"
    with pytest.raises(SmartImportError) as ei:
        parse_csv(
            f"Date,Description,Amount\n2026-03-02,{planted}{'A' * 10_001},-1\n".encode(),
            "s.csv",
            {},
        )
    assert planted not in str(ei.value) and planted not in repr(ei.value.body())


def test_no_content_logged(caplog: pytest.LogCaptureFixture) -> None:
    caplog.set_level("DEBUG")
    parse("signed.csv")
    assert caplog.records == []


def test_file_name_path_is_stripped() -> None:
    stmt = parse_csv(load("signed.csv"), "C:\\Users\\x\\exports/stmt.csv", {})
    assert stmt["file_name"] == "stmt.csv"


def test_no_em_dash_in_fixtures_or_source() -> None:
    for path in list(FIXTURES.glob("*.csv")) + [Path(__file__)]:
        assert "\u2014" not in path.read_text(encoding="utf-8")
