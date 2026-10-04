"""Cross-parser contract tests: the same statement reads the same from CSV, PDF
and OFX (kinds, categories, file name, origin, closing balance, warnings).

All inputs are synthetic and built here.
"""

from __future__ import annotations

import ast
import pathlib
from typing import Any

import pytest

from src.smart_import import types as si_types
from src.smart_import.analyze import analyze_file
from src.smart_import.parsers.csv_parser import parse_csv
from src.smart_import.parsers.ofx_parser import parse_ofx
from src.smart_import.parsers.pdf_parser import NeedsAiLayout, parse_pdf

from .pdf_factory import make_pdf

# (date, description, signed amount: spending negative)
CARD_ROWS = [
    ("2026-01-05", "INTEREST CHARGE PURCHASES", -12.34),
    ("2026-01-06", "LATE FEE", -39.00),
    ("2026-01-07", "INTEREST CHARGE ADJ", 12.34),
    ("2026-01-08", "BLUE BOTTLE COFFEE", -4.50),
    ("2026-01-09", "ANNUAL FEE", -95.00),
    ("2026-01-10", "LATE FEE", 39.00),
]
EXPECTED_KINDS = ["interest", "fee", "refund", "expense", "fee", "refund"]

CATEGORIES = [
    {"id": "c-dining", "name": "Food & Dining"},
    {"id": "c-bank", "name": "Bank Fees"},
]
RULES = {"LATE FEE": {"category_id": "c-bank"}}


def card_csv(balance: float | None = None, flipped: bool = False) -> bytes:
    sign = -1 if flipped else 1
    head = "Date,Description,Amount" + (",Balance" if balance is not None else "")
    lines = [head]
    for d, desc, amt in CARD_ROWS:
        line = f"{d},{desc},{sign * amt:.2f}"
        if balance is not None:
            line += f",{balance:.2f}"
        lines.append(line)
    return ("\n".join(lines) + "\n").encode()


def card_pdf(new_balance: str = "$1,234.56") -> bytes:
    lines = [
        "EXAMPLE CARD SERVICES",
        "Opening/Closing Date 12/15/2025 - 01/14/2026",
        f"New Balance {new_balance}",
        "Minimum Payment Due $35.00",
        "Transactions",
    ]
    for d, desc, amt in CARD_ROWS:
        mm_dd = d[5:7] + "/" + d[8:10]
        # Card statements print charges positive and credits with CR.
        money = f"${abs(amt):.2f}" + ("CR" if amt > 0 else "")
        lines.append(f"{mm_dd} {desc} {money}")
    return make_pdf(lines)


def card_ofx(ledger: str = "-1234.56") -> bytes:
    txns = "".join(
        f"<STMTTRN><TRNTYPE>{'CREDIT' if amt > 0 else 'DEBIT'}"
        f"<DTPOSTED>{d.replace('-', '')}<TRNAMT>{amt:.2f}<FITID>F{i}"
        f"<NAME>{desc}</STMTTRN>"
        for i, (d, desc, amt) in enumerate(CARD_ROWS)
    )
    body = (
        "OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:1252\n\n"
        "<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>"
        "<CCACCTFROM><ACCTID>4000123456789010</CCACCTFROM>"
        "<BANKTRANLIST><DTSTART>20251215<DTEND>20260114"
        f"{txns}</BANKTRANLIST>"
        f"<LEDGERBAL><BALAMT>{ledger}<DTASOF>20260114</LEDGERBAL>"
        "</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>"
    )
    return body.encode("cp1252")


def all_three(name: str, **ctx: Any) -> dict[str, Any]:
    csv_ctx = {"account_kind": "credit_card", "flip_sign": False, **ctx}
    pdf = parse_pdf(card_pdf(), name + ".pdf", dict(ctx))
    assert not isinstance(pdf, NeedsAiLayout)
    return {
        "csv": parse_csv(card_csv(), name + ".csv", csv_ctx),
        "pdf": pdf,
        "ofx": parse_ofx(card_ofx(), name + ".ofx", dict(ctx))[0],
    }


def test_same_rows_get_the_same_kind_from_every_format():
    for fmt, stmt in all_three("card").items():
        got = [(t["posted_date"], t["amount"], t["kind"]) for t in stmt["transactions"]]
        want = [
            (d, amt, kind)
            for (d, _, amt), kind in zip(CARD_ROWS, EXPECTED_KINDS, strict=True)
        ]
        assert got == want, fmt
        assert stmt["account"]["kind"] == "credit_card", fmt


def test_every_parser_finalizes_categories_name_and_origin():
    long_name = "x" * 300
    for name, ctx, want_origin in (
        ("dir/sub/Jane Statement", {"origin": "sample"}, "sample"),
        ("C:\\Users\\jane\\stmt", {}, "file"),
        ("plain", {"origin": "bogus"}, "file"),
        (long_name, {"origin": "connector"}, "connector"),
    ):
        stmts = all_three(name, categories=CATEGORIES, rules=RULES, **ctx)
        for fmt, stmt in stmts.items():
            base = name.replace("\\", "/").split("/")[-1] + "." + fmt
            assert stmt["file_name"] == base[:255], fmt
            assert "/" not in stmt["file_name"] and "\\" not in stmt["file_name"]
            assert stmt["origin"] == want_origin, fmt
            cats = [(t["category_id"], t["category_source"]) for t in stmt["transactions"]]
            assert cats == [
                (None, "none"),  # interest: no seed for it here
                ("c-bank", "rule"),
                (None, "none"),  # refund without a rule or seed
                ("c-dining", "seed"),
                (None, "none"),
                ("c-bank", "rule"),  # refund, still categorized by the rule
            ], fmt


def test_finalize_rejects_bad_category_shapes():
    from src.smart_import.errors import SmartImportError

    parsers = (
        lambda ctx: parse_ofx(card_ofx(), "x.ofx", ctx),
        lambda ctx: parse_pdf(card_pdf(), "x.pdf", ctx),
        lambda ctx: parse_csv(card_csv(), "x.csv", {"flip_sign": False, **ctx}),
    )
    for bad in ({"categories": "nope"}, {"categories": [{"id": 1}]}, {"rules": 3}):
        for run in parsers:
            with pytest.raises(SmartImportError) as ei:
                run(bad)
            assert ei.value.error_type == "bad_context"


def test_analyze_does_not_double_apply_rules():
    res = analyze_file(card_ofx(), "x.ofx", {"categories": CATEGORIES, "rules": RULES})
    cats = [t["category_source"] for t in res["statements"][0]["transactions"]]
    assert cats == ["none", "rule", "none", "seed", "none", "rule"]


# --- closing balance: amount owed is positive, a card in credit is negative ---


def test_closing_balance_card_owed_and_in_credit_from_every_format():
    # OFX card LEDGERBAL is from the holder's side: negative means owed.
    assert parse_ofx(card_ofx("-1234.56"), "x", {})[0]["closing_balance"] == {
        "amount": 1234.56,
        "as_of": "2026-01-14",
    }
    assert parse_ofx(card_ofx("25.00"), "x", {})[0]["closing_balance"]["amount"] == -25.0

    # PDF card "New Balance": printed positive is owed; minus or CR is a credit.
    for printed, owed in (
        ("$1,234.56", 1234.56),
        ("-$25.00", -25.0),
        ("$25.00CR", -25.0),
    ):
        st = parse_pdf(card_pdf(printed), "c.pdf", {})
        assert not isinstance(st, NeedsAiLayout)
        assert st["closing_balance"] == {"amount": owed, "as_of": "2026-01-14"}, printed

    # CSV: the balance follows the file's own sign convention. Spending
    # negative means the holder's side (owed negative); a flipped file is the
    # issuer's side (owed positive).
    ctx = {"account_kind": "credit_card"}
    for flipped, printed, owed in (
        (False, -410.0, 410.0),
        (False, 25.0, -25.0),
        (True, 410.0, 410.0),
        (True, -25.0, -25.0),
    ):
        st = parse_csv(card_csv(printed, flipped), "c.csv", {**ctx, "flip_sign": flipped})
        assert st["closing_balance"]["amount"] == owed, (flipped, printed)


def test_csv_card_balance_convention_read_from_running_balance():
    # Spending negative, but the running balance grows with spending: the
    # balance column is the issuer's side, so it is already the amount owed.
    data = (
        b"Date,Description,Amount,Balance\n"
        b"2026-03-01,BLUE BOTTLE COFFEE,-10.00,110.00\n"
        b"2026-03-02,BLUE BOTTLE COFFEE,-20.00,130.00\n"
        b"2026-03-03,REFUND,5.00,125.00\n"
    )
    st = parse_csv(data, "c.csv", {"account_kind": "credit_card", "flip_sign": False})
    assert st["closing_balance"] == {"amount": 125.0, "as_of": "2026-03-03"}
    # The same file newest first.
    lines = data.splitlines()
    rev = b"\n".join([lines[0], *reversed(lines[1:])]) + b"\n"
    st = parse_csv(rev, "c.csv", {"account_kind": "credit_card", "flip_sign": False})
    assert st["closing_balance"] == {"amount": 125.0, "as_of": "2026-03-03"}
    # Holder's side running balance (owed shown negative).
    hold = data.replace(b"110.00", b"-110.00").replace(b"130.00", b"-130.00")
    hold = hold.replace(b"125.00", b"-125.00")
    st = parse_csv(hold, "c.csv", {"account_kind": "credit_card", "flip_sign": False})
    assert st["closing_balance"]["amount"] == 125.0


def test_checking_closing_balance_is_the_plain_balance():
    data = b"Date,Description,Amount,Balance\n2026-03-01,COFFEE,-10.00,-50.00\n"
    st = parse_csv(data, "c.csv", {"account_kind": "checking"})
    assert st["closing_balance"]["amount"] == -50.0


# --- warnings vocabulary -------------------------------------------------------


def test_warnings_vocabulary_is_documented_and_complete():
    assert set(si_types.WARNINGS) == {
        "rows_skipped",
        "available_balance_used",
        "duplicate_fitid",
        "truncated_file",
        "year_assumed",
        "sign_assumed",
        "date_order_assumed",
        "sign_flipped",
        "ai_extracted",
        "ai_partial",
        "connector_account_error",
        "connector_partial",
        "connector_balance_only",
        "currency_unsupported",
        "connector_sign_check",
        "connector_balance_dropped",
    }
    # Every warning string a parser can append is in the vocabulary.
    root = pathlib.Path(si_types.__file__).parent / "parsers"
    found: set[str] = set()
    for path in root.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if (
                isinstance(node, ast.Call)
                and getattr(node.func, "attr", "") == "append"
                and getattr(node.func.value, "id", "") == "warnings"
                and node.args
                and isinstance(node.args[0], ast.Constant)
            ):
                found.add(node.args[0].value)
            if isinstance(node, ast.List) and all(
                isinstance(e, ast.Constant) and isinstance(e.value, str) for e in node.elts
            ):
                found.update(
                    e.value for e in node.elts if e.value.endswith("_assumed")
                )
    assert found and found <= set(si_types.WARNINGS), found - set(si_types.WARNINGS)
