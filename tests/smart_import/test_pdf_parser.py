"""PDF parser tests. Every PDF is synthetic and built at test time."""

from __future__ import annotations

import ast
import pathlib
import re
import time

import pytest

from src.api.bank_statements import _parse_usaa_pdf
from src.smart_import import limits
from src.smart_import.errors import SmartImportError
from src.smart_import.parsers import pdf_parser
from src.smart_import.parsers.pdf_parser import NeedsAiLayout, parse_pdf

from .pdf_factory import (
    CARD_LINES,
    USAA_LINES,
    encrypt_pdf,
    make_image_only_pdf,
    make_many_pages_pdf,
    make_pdf,
    make_raw_pdf,
    text_ops_stream,
)


def parse(lines: list[str], name: str = "stmt.pdf"):
    return parse_pdf(make_pdf(lines), name, {})


def test_usaa_matches_legacy_debits_and_adds_credits():
    pdf = make_pdf(USAA_LINES)
    legacy = _parse_usaa_pdf(pdf)
    st = parse_pdf(pdf, "usaa.pdf", {})
    assert not isinstance(st, NeedsAiLayout)
    assert st["parser"] == "pdf:usaa_checking"
    assert st["format"] == "pdf" and st["origin"] == "file"
    assert st["account"]["kind"] == "checking"
    debits = [t for t in st["transactions"] if t["amount"] < 0]
    assert [(t["posted_date"], -t["amount"]) for t in debits] == [
        (r["date"].date().isoformat(), r["amount"]) for r in legacy
    ]
    credits = [t for t in st["transactions"] if t["amount"] > 0]
    assert [(t["posted_date"], t["amount"], t["kind"]) for t in credits] == [
        ("2026-02-20", 1250.00, "income")
    ]
    assert st["period"] == {"start": "2026-02-14", "end": "2026-03-16"}
    assert [t["row"] for t in st["transactions"]] == [0, 1, 2, 3]
    assert st["file_name"] == "usaa.pdf" and len(st["file_hash"]) == 64


def test_usaa_year_rollover():
    st = parse(
        [
            "USAA CLASSIC CHECKING",
            "Statement Period: 12/14/2025 to 01/16/2026",
            "12/28 TEST MERCHANT",
            "***1234 $10.00 0",
            "$10.00",
            "01/05 ANOTHER MERCHANT",
            "***1234 $20.00 0",
            "$20.00",
        ]
    )
    assert [t["posted_date"] for t in st["transactions"]] == [
        "2025-12-28",
        "2026-01-05",
    ]


USAA_DEC_JAN = [
    "USAA CLASSIC CHECKING",
    "Statement Period: 12/14/2025 to 01/16/2026",
    "12/10 EARLY MERCHANT",
    "***1234 $5.00 0",
    "$95.00",
    "12/28 TEST MERCHANT",
    "***1234 $10.00 0",
    "$85.00",
    "01/05 ANOTHER MERCHANT",
    "***1234 $20.00 0",
    "$65.00",
    "02/01 LATE POSTING MERCHANT",
    "***1234 $7.00 0",
    "$58.00",
]


def test_usaa_dec_jan_dates_match_legacy_year_rule():
    pdf = make_pdf(USAA_DEC_JAN)
    legacy = _parse_usaa_pdf(pdf)
    st = parse_pdf(pdf, "usaa.pdf", {})
    assert not isinstance(st, NeedsAiLayout) and st["parser"] == "pdf:usaa_checking"
    got = [(t["posted_date"], -t["amount"]) for t in st["transactions"]]
    want = [(r["date"].date().isoformat(), r["amount"]) for r in legacy]
    assert got == want
    # The legacy rule: the period's start year, plus one for a month before
    # the start month (so a stray 02/01 lands after the period, in 2026).
    assert [d for d, _ in got] == ["2025-12-10", "2025-12-28", "2026-01-05", "2026-02-01"]


def test_usaa_layout_needs_usaa_header_not_just_the_word():
    from src.smart_import.parsers.pdf_layouts import usaa_checking

    assert usaa_checking.matches("\n".join(USAA_LINES))
    other = [
        "EXAMPLE BANK CHECKING",
        "Statement Period: 02/01/2026 to 02/28/2026",
        "Beginning Balance $1,000.00",
        "02/03 USAA INSURANCE PREMIUM $120.00",
        "02/05 GROCERY STORE $45.10",
        "Checks enclosed 0",
        "Ending Balance $834.90",
    ]
    assert not usaa_checking.matches("\n".join(other))
    st = parse(other)
    assert not isinstance(st, NeedsAiLayout)
    assert st["parser"] == "pdf:generic_lines"


def test_generic_card_statement():
    st = parse(CARD_LINES)
    assert not isinstance(st, NeedsAiLayout)
    assert st["parser"] == "pdf:generic_lines"
    assert st["account"]["kind"] == "credit_card"
    assert st["account"]["last4"] == "9010"
    assert st["account"]["key"] and st["account"]["key"].startswith("acct:")
    assert st["period"] == {"start": "2025-12-15", "end": "2026-01-14"}
    rows = [(t["posted_date"], t["amount"], t["kind"]) for t in st["transactions"]]
    assert rows == [
        ("2025-12-21", -4.5, "expense"),
        ("2025-12-29", -87.43, "expense"),
        ("2026-01-04", 500.0, "payment"),
        ("2026-01-06", -15.99, "expense"),
        ("2026-01-10", 12.0, "refund"),
    ]
    assert st["transactions"][1]["description"] == "EXAMPLE MARKET #12 SPRINGFIELD ST"
    assert st["closing_balance"] == {"amount": 1234.56, "as_of": "2026-01-14"}
    assert st["extras"] == {"minimum_payment": 35.0, "payment_due": "2026-02-10"}
    assert "Minimum Payment Due $35.00" not in [
        t["description"] for t in st["transactions"]
    ]


def test_generic_checking_with_running_balance():
    st = parse(
        [
            "Statement Period 03/01/2026 to 03/31/2026",
            "Beginning Balance $1,000.00",
            "03/02/2026 CORNER CAFE 12.50 987.50",
            "03/05/2026 EMPLOYER DIRECT DEP 2,000.00 2,987.50",
            "03/09/2026 UTILITY CO 100.00 2,887.50",
            "Ending Balance $2,887.50",
        ]
    )
    assert st["account"]["kind"] == "checking"
    assert [t["amount"] for t in st["transactions"]] == [-12.5, 2000.0, -100.0]
    assert st["transactions"][1]["kind"] == "income"
    assert st["closing_balance"] == {"amount": 2887.5, "as_of": "2026-03-31"}
    assert st["extras"] is None


def test_month_name_dates_and_dec_jan_rollover():
    st = parse(
        [
            "Closing Date Jan 14, 2026",
            "Statement Period Dec 15, 2025 - Jan 14, 2026",
            "New Balance $20.00",
            "Dec 30 SOME STORE $5.00",
            "Jan 02 OTHER STORE $15.00",
        ]
    )
    assert [t["posted_date"] for t in st["transactions"]] == [
        "2025-12-30",
        "2026-01-02",
    ]


def test_dedupe_occurrence_for_identical_rows():
    st = parse(
        [
            "Statement Period 03/01/2026 to 03/31/2026",
            "New Balance $9.00",
            "03/02 COFFEE SHOP $4.50",
            "03/02 COFFEE SHOP $4.50",
        ]
    )
    bases = [t["dedupe_base"] for t in st["transactions"]]
    assert len(set(bases)) == 2


def test_unreadable_layout_needs_ai():
    out = parse(
        [
            "Some Bank Of Nowhere",
            "Date    Details",
            "2025-12-05 ORDER 987654321 jane@example.com 25.00 USD",
            "no dated lines at all here",
        ]
    )
    assert isinstance(out, NeedsAiLayout)
    assert out.lines == [] and out.line_count == 0
    assert len(out.file_hash) == 64


def test_needs_ai_masks_digit_runs(monkeypatch):
    # Force the layouts to reject so the candidate-line path runs on dated lines.
    monkeypatch.setattr(pdf_parser, "LAYOUTS", ())
    lines = [
        f"12/05/2025 ORDER 98765432{i} jane{i}@example.com 25.00" for i in range(450)
    ]
    out = parse(["Unknown", *lines])
    assert isinstance(out, NeedsAiLayout)
    assert len(out.lines) == 400 == out.line_count
    for ln in out.lines:
        assert not re.search(r"\d{5}", ln)
        assert "@" not in ln


def test_no_text_layer():
    with pytest.raises(SmartImportError) as ei:
        parse_pdf(make_image_only_pdf(2), "scan.pdf", {})
    assert ei.value.error_type == "no_text_layer"


def test_too_many_pages():
    pdf = make_many_pages_pdf(limits.MAX_PDF_PAGES + 1)
    with pytest.raises(SmartImportError) as ei:
        parse_pdf(pdf, "big.pdf", {})
    assert ei.value.error_type == "too_many_pages"
    # exactly at the limit is accepted (no transactions, so needs_ai)
    ok = parse_pdf(make_many_pages_pdf(limits.MAX_PDF_PAGES), "ok.pdf", {})
    assert isinstance(ok, NeedsAiLayout)


def test_encrypted_pdf_with_password_is_rejected():
    pdf = encrypt_pdf(make_pdf(CARD_LINES), "s3cret")
    with pytest.raises(SmartImportError) as ei:
        parse_pdf(pdf, "locked.pdf", {})
    assert ei.value.error_type == "encrypted_pdf"


def test_encrypted_pdf_with_empty_password_opens():
    pdf = encrypt_pdf(make_pdf(CARD_LINES), "")
    st = parse_pdf(pdf, "open.pdf", {})
    assert not isinstance(st, NeedsAiLayout)
    assert len(st["transactions"]) == 5


def test_extracted_text_cap(monkeypatch):
    monkeypatch.setattr(limits, "MAX_PDF_TEXT_CHARS", 50)
    with pytest.raises(SmartImportError) as ei:
        parse(CARD_LINES)
    assert ei.value.error_type == "pdf_text_too_large"


def _timed_error(pdf: bytes) -> tuple[str, float]:
    started = time.monotonic()
    with pytest.raises(SmartImportError) as ei:
        parse_pdf(pdf, "heavy.pdf", {})
    assert ei.value.__cause__ is None
    return ei.value.error_type, time.monotonic() - started


def test_heavy_single_page_is_rejected_fast():
    # One page with 1.5M text operators: before the budget this ran for tens
    # of seconds inside pypdf (and minutes in review), using GBs of memory.
    pdf = make_raw_pdf([text_ops_stream(1_500_000)])
    error_type, elapsed = _timed_error(pdf)
    assert error_type == "pdf_text_too_large"
    assert elapsed < 5.0


def test_uncompressed_page_over_budget_is_rejected():
    pdf = make_raw_pdf([text_ops_stream(60_000)], compress=False)
    assert _timed_error(pdf)[0] == "pdf_text_too_large"


def test_text_operator_cap_under_the_byte_budget():
    stream = text_ops_stream(limits.MAX_PDF_PAGE_TEXT_OPS + 100)
    assert len(stream) < limits.MAX_PDF_PAGE_CONTENT_BYTES
    assert _timed_error(make_raw_pdf([stream]))[0] == "pdf_text_too_large"


def test_total_content_budget(monkeypatch):
    stream = text_ops_stream(2_000)
    monkeypatch.setattr(limits, "MAX_PDF_TOTAL_CONTENT_BYTES", len(stream) * 3)
    assert isinstance(parse_pdf(make_raw_pdf([stream] * 3), "ok.pdf", {}), NeedsAiLayout)
    assert _timed_error(make_raw_pdf([stream] * 4))[0] == "pdf_text_too_large"


def test_wall_clock_kills_the_child(monkeypatch):
    # Lift the budget so the heavy page reaches pypdf, then rely on the kill.
    monkeypatch.setattr(limits, "MAX_PDF_PAGE_CONTENT_BYTES", 10**9)
    monkeypatch.setattr(limits, "MAX_PDF_TOTAL_CONTENT_BYTES", 10**9)
    monkeypatch.setattr(limits, "MAX_PDF_PAGE_TEXT_OPS", 10**9)
    monkeypatch.setattr(limits, "PDF_WALL_CLOCK_SECONDS", 1.0)
    error_type, elapsed = _timed_error(make_raw_pdf([text_ops_stream(1_500_000)]))
    assert error_type == "parse_timeout"
    assert elapsed < 4.0


def test_child_gets_only_the_bytes_and_no_secrets(monkeypatch):
    seen: dict[str, object] = {}
    real_run = pdf_parser.subprocess.run

    def spy(args, **kwargs):
        seen["args"] = args
        seen.update(kwargs)
        return real_run(args, **kwargs)

    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-not-real")
    monkeypatch.setattr(pdf_parser.subprocess, "run", spy)
    pdf = make_pdf(CARD_LINES)
    st = parse_pdf(pdf, "Jane Doe statement.pdf", {})
    assert not isinstance(st, NeedsAiLayout)
    assert seen["input"] == pdf
    assert "ANTHROPIC_API_KEY" not in seen["env"]
    assert "shell" not in seen
    assert not any("Jane" in str(a) for a in seen["args"])


def test_worker_imports_only_stdlib_and_pypdf():
    worker = pathlib.Path(pdf_parser.__file__).with_name("pdf_worker.py")
    allowed = {"__future__", "io", "sys", "zlib", "typing", "resource", "pypdf"}
    for node in ast.walk(ast.parse(worker.read_text(encoding="utf-8"))):
        if isinstance(node, ast.ImportFrom):
            assert node.level == 0 and node.module.split(".")[0] in allowed
        elif isinstance(node, ast.Import):
            assert all(a.name.split(".")[0] in allowed for a in node.names)


def test_transaction_cap(monkeypatch):
    from src.smart_import.parsers.pdf_layouts import _common

    monkeypatch.setattr(_common, "MAX_TRANSACTIONS_PER_STATEMENT", 2)
    with pytest.raises(SmartImportError) as ei:
        parse(CARD_LINES)
    assert ei.value.error_type == "too_many_rows"


@pytest.mark.parametrize(
    "blob",
    [
        b"",
        b"not a pdf at all",
        b"%PDF-1.4\n1 0 obj\n<<>>\nendobj\n",
        make_pdf(CARD_LINES)[:200],
    ],
)
def test_hostile_bytes_give_fixed_errors(blob):
    with pytest.raises(SmartImportError) as ei:
        parse_pdf(blob, "x.pdf", {})
    assert ei.value.error_type in {"unreadable", "no_text_layer"}
    assert ei.value.__cause__ is None
    assert str(ei.value) == ei.value.detail


def test_no_content_in_logs(caplog):
    caplog.set_level("DEBUG")
    parse(CARD_LINES)
    with pytest.raises(SmartImportError):
        parse_pdf(b"%PDF-garbage", "Jane Doe 1234.pdf", {})
    text = caplog.text
    assert "BLUE BOTTLE" not in text and "Jane" not in text


def test_pdf_modules_have_no_logging_or_em_dash():
    root = pathlib.Path(pdf_parser.__file__).parent
    for path in [
        *root.rglob("*.py"),
        pathlib.Path(__file__),
        pathlib.Path(__file__).with_name("pdf_factory.py"),
    ]:
        src = path.read_text(encoding="utf-8")
        assert chr(0x2014) not in src, path
        if root in path.parents:
            tree = ast.parse(src)
            for node in ast.walk(tree):
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    names = [a.name for a in node.names] + [
                        getattr(node, "module", "") or ""
                    ]
                    assert "logging" not in names, path


# --- concurrency cap ----------------------------------------------------------


def test_busy_when_every_pdf_slot_is_taken(monkeypatch):
    """At most MAX_CONCURRENT_PDF_READS children; the next one is refused, not queued."""
    spawned: list[object] = []
    monkeypatch.setattr(pdf_parser.subprocess, "run", lambda *a, **k: spawned.append(1))
    assert limits.MAX_CONCURRENT_PDF_READS == 2
    taken = 0
    try:
        for _ in range(limits.MAX_CONCURRENT_PDF_READS):
            assert pdf_parser._PDF_SLOTS.acquire(blocking=False)
            taken += 1
        with pytest.raises(SmartImportError) as exc:
            parse(CARD_LINES)
        assert exc.value.error_type == "busy" and exc.value.status == 503
        assert spawned == []
    finally:
        for _ in range(taken):
            pdf_parser._PDF_SLOTS.release()


def test_pdf_slot_is_released_after_success_and_failure(monkeypatch):
    assert not isinstance(parse(CARD_LINES), NeedsAiLayout)
    monkeypatch.setattr(limits, "PDF_WALL_CLOCK_SECONDS", 0.001)
    for _ in range(limits.MAX_CONCURRENT_PDF_READS + 1):
        with pytest.raises(SmartImportError) as exc:
            parse(CARD_LINES)
        assert exc.value.error_type == "parse_timeout"
    monkeypatch.undo()
    assert not isinstance(parse(CARD_LINES), NeedsAiLayout)


def test_child_address_space_is_512_mib():
    assert limits.PDF_CHILD_MAX_ADDRESS_BYTES == 512 * 1024 * 1024
