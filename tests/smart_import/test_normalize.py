"""Tests for smart import limits, errors, normalization and seed rules.

All inputs are synthetic.
"""

from __future__ import annotations

import ast
import json
from pathlib import Path

import pytest

from src.smart_import import limits, normalize, seed_rules
from src.smart_import.errors import ERROR_CATALOG, SmartImportError

FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "smart_import"
    / "merchant_keys.json"
)
EM_DASH = chr(0x2014)

CATEGORIES = [
    {"id": "c-food", "name": "Food & Dining"},
    {"id": "c-ent", "name": "Entertainment"},
    {"id": "c-util", "name": "Utilities"},
    {"id": "c-pers", "name": "Personal"},
]


def _tx(key: str, kind: str = "expense") -> dict:
    return {
        "merchant_key": key,
        "kind": kind,
        "category_id": None,
        "category_source": "none",
    }


# --- merchant keys ----------------------------------------------------------

_KEY_CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))


def test_fixture_has_enough_cases_and_design_examples():
    assert len(_KEY_CASES) >= 23
    keys = {c["raw"]: c["key"] for c in _KEY_CASES}
    assert keys["SQ *BLUE BOTTLE COFFEE 12345 OAKLAND CA"] == "BLUE BOTTLE COFFEE"
    assert keys["NETFLIX.COM 866-579-7172 CA"] == "NETFLIX.COM CA"
    assert keys["AMAZON MKTPL*2K4X91 AMZN.COM/BILL WA"] == "AMAZON WA"


@pytest.mark.parametrize(
    "case", _KEY_CASES, ids=[c["raw"][:40] or "empty" for c in _KEY_CASES]
)
def test_merchant_key_golden(case):
    assert normalize.merchant_key(case["raw"]) == case["key"]


def test_merchant_key_none_is_unknown():
    assert normalize.merchant_key(None) == "UNKNOWN"


# --- masking ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("CARD 1234567890 STORE", "CARD # STORE"),
        ("REF 12345 AND 1234", "REF # AND 1234"),
        ("PAID ***1234 SHOP", "PAID SHOP"),
        ("XX ****************9876 YY", "XX YY"),
        ("mail me a@b.test now", "mail me now"),
        ("see https://x.example.test/p?q=1 ok", "see ok"),
        ("CALL 866-579-7172 NOW", "CALL # NOW"),
        ("  lots   of \t space \n here ", "lots of space here"),
    ],
)
def test_mask_description(raw, expected):
    assert normalize.mask_description(raw) == expected


def test_mask_description_caps_at_120_chars():
    out = normalize.mask_description("A" * 300)
    assert len(out) == 120
    out = normalize.mask_description("WORD " * 100)
    assert len(out) <= 120
    assert not out.endswith(" ")


def test_mask_description_none_is_empty():
    assert normalize.mask_description(None) == ""


# --- kinds ------------------------------------------------------------------


@pytest.mark.parametrize(
    ("description", "amount", "account_kind", "trntype", "expected"),
    [
        ("ACME PAYROLL", 2500.0, "checking", None, "income"),
        ("DIRECT DEP EMPLOYER", 1200.0, "checking", None, "income"),
        ("SALARY MARCH", 3000.0, "savings", None, "income"),
        ("ONLINE TRANSFER TO SAVINGS", -500.0, "checking", None, "transfer"),
        ("ZELLE TO FRIEND", -40.0, "checking", None, "transfer"),
        ("VENMO CASHOUT", 25.0, "checking", None, "transfer"),
        ("CASH APP SENT", -10.0, "checking", None, "transfer"),
        ("PAYMENT THANK YOU", 300.0, "credit_card", None, "payment"),
        ("AUTOPAY 0301", 150.0, "credit_card", None, "payment"),
        ("ONLINE PAYMENT", 80.0, "loan", None, "payment"),
        ("ONLINE PAYMENT TO UTILITY", -80.0, "checking", None, "expense"),
        ("EXAMPLE BANK CREDIT CARD AUTOPAY", -300.0, "checking", None, "payment"),
        ("INTEREST CHARGE PURCHASES", -22.5, "credit_card", None, "interest"),
        ("FINANCE CHARGE", -9.0, "credit_card", None, "interest"),
        ("MONTHLY SERVICE FEE", -12.0, "checking", None, "fee"),
        ("LATE FEE", -35.0, "credit_card", None, "fee"),
        ("COFFEE SHOP", -4.5, "checking", None, "expense"),
        ("COFFEE SHOP", 4.5, "credit_card", None, "refund"),
        ("MYSTERY DEPOSIT", 100.0, "checking", None, "income"),
        ("MYSTERY DEPOSIT", 100.0, "unknown", None, "income"),
        ("LOAN PAYMENT RECEIVED", 400.0, "loan", None, "payment"),
        ("PAYROLL REVERSAL", -2500.0, "checking", None, "expense"),
        ("ANYTHING", -5.0, "checking", "DEBIT", "expense"),
        ("ANYTHING", -5.0, "checking", "POS", "expense"),
        ("ANYTHING", 5.0, "checking", "DIRECTDEP", "income"),
        ("ANYTHING", 5.0, "checking", "DEP", "income"),
        ("ANYTHING", -5.0, "checking", "XFER", "transfer"),
        ("ANYTHING", -5.0, "checking", "SRVCHG", "fee"),
        ("ANYTHING", 5.0, "savings", "INT", "interest"),
        ("ANYTHING", 5.0, "savings", "DIV", "income"),
        ("ANYTHING", 5.0, "checking", "CREDIT", "income"),
        ("ANYTHING", 5.0, "credit_card", "CREDIT", "refund"),
        ("PAYMENT THANK YOU", 5.0, "credit_card", "CREDIT", "payment"),
        ("ANYTHING", -5.0, "checking", "OTHER", "expense"),
        ("ONLINE TRANSFER", -5.0, "checking", "OTHER", "transfer"),
    ],
)
def test_infer_kind(description, amount, account_kind, trntype, expected):
    assert normalize.infer_kind(description, amount, account_kind, trntype) == expected


@pytest.mark.parametrize(
    ("description", "amount", "account_kind", "trntype", "expected"),
    [
        # Generic TRNTYPEs defer to strong keywords on a negative amount.
        ("INTEREST CHARGE PURCHASES", -12.34, "credit_card", "DEBIT", "interest"),
        ("FINANCE CHARGE", -5.0, "credit_card", "POS", "interest"),
        ("INTEREST CHARGE", -5.0, "credit_card", "OTHER", "interest"),
        ("LATE FEE", -39.0, "credit_card", "DEBIT", "fee"),
        ("ANNUAL FEE", -95.0, "credit_card", "PAYMENT", "fee"),
        # Weak keywords do not override a generic TRNTYPE.
        ("MONTHLY SERVICE FEE", -12.0, "checking", "DEBIT", "expense"),
        # A positive interest or fee line is a credit back, never a charge.
        ("INTEREST CHARGE", 12.34, "credit_card", "CREDIT", "refund"),
        ("INTEREST CHARGE", 12.34, "credit_card", None, "refund"),
        ("LATE FEE", 39.0, "credit_card", None, "refund"),
        ("LATE FEE", 39.0, "credit_card", "CREDIT", "refund"),
        # Specific TRNTYPEs win over any keyword.
        ("INTEREST CHARGE", -5.0, "checking", "FEE", "fee"),
        ("LATE FEE", -5.0, "credit_card", "INT", "interest"),
        ("LATE FEE", -5.0, "checking", "XFER", "transfer"),
        ("ANNUAL FEE", 5.0, "checking", "DEP", "income"),
        ("FINANCE CHARGE", -5.0, "checking", "SRVCHG", "fee"),
    ],
)
def test_infer_kind_trntype_and_strong_keywords(
    description, amount, account_kind, trntype, expected
):
    assert normalize.infer_kind(description, amount, account_kind, trntype) == expected


def test_fee_keyword_needs_word_boundary():
    assert normalize.infer_kind("BLUE COFFEE ROASTERS", -4.0, "checking") == "expense"


# --- dedupe -----------------------------------------------------------------

_BASE = ("2026-03-14", -4.5, "BLUE BOTTLE COFFEE", "BLUE BOTTLE COFFEE #", 0)


def test_dedupe_base_is_stable_hex_sha256():
    a = normalize.dedupe_base(*_BASE)
    assert a == normalize.dedupe_base(*_BASE)
    assert len(a) == 64
    int(a, 16)


def test_dedupe_base_accepts_date_objects():
    from datetime import date

    assert normalize.dedupe_base(
        date(2026, 3, 14), *_BASE[1:]
    ) == normalize.dedupe_base(*_BASE)


def test_dedupe_base_changes_with_each_field():
    base = normalize.dedupe_base(*_BASE)
    variants = [
        ("2026-03-15", -4.5, "BLUE BOTTLE COFFEE", "BLUE BOTTLE COFFEE #", 0),
        ("2026-03-14", -4.51, "BLUE BOTTLE COFFEE", "BLUE BOTTLE COFFEE #", 0),
        ("2026-03-14", -4.5, "OTHER", "BLUE BOTTLE COFFEE #", 0),
        ("2026-03-14", -4.5, "BLUE BOTTLE COFFEE", "OTHER DESC", 0),
        ("2026-03-14", -4.5, "BLUE BOTTLE COFFEE", "BLUE BOTTLE COFFEE #", 1),
    ]
    assert len({base, *(normalize.dedupe_base(*v) for v in variants)}) == 6


def test_dedupe_base_cents_rounding_is_float_safe():
    assert normalize.dedupe_base(
        "2026-01-01", -0.1 - 0.2, "K", "D", 0
    ) == normalize.dedupe_base("2026-01-01", -0.3, "K", "D", 0)


def test_fitid_wins_over_other_fields():
    a = normalize.dedupe_base(*_BASE, fitid="20260314001")
    b = normalize.dedupe_base("2030-01-01", -99.0, "X", "Y", 7, fitid="20260314001")
    assert a == b
    assert a != normalize.dedupe_base(*_BASE)
    assert a != normalize.dedupe_base(*_BASE, fitid="20260314002")


def test_blank_fitid_is_ignored():
    assert normalize.dedupe_base(*_BASE, fitid="  ") == normalize.dedupe_base(*_BASE)
    assert normalize.dedupe_base(*_BASE, fitid="") == normalize.dedupe_base(*_BASE)


def test_assign_occurrences_distinguishes_identical_rows():
    row = {
        "posted_date": "2026-03-14",
        "amount": -4.5,
        "merchant_key": "K",
        "description": "D",
    }
    other = {**row, "amount": -5.0}
    assert normalize.assign_occurrences(
        [row, other, dict(row), dict(row), dict(other)]
    ) == [
        0,
        0,
        1,
        2,
        1,
    ]
    assert normalize.assign_occurrences([]) == []


def test_identical_rows_get_distinct_dedupe_bases():
    row = {
        "posted_date": "2026-03-14",
        "amount": -4.5,
        "merchant_key": "K",
        "description": "D",
    }
    occ = normalize.assign_occurrences([row, dict(row)])
    bases = {normalize.dedupe_base("2026-03-14", -4.5, "K", "D", n) for n in occ}
    assert len(bases) == 2


# --- account key ------------------------------------------------------------


def test_account_key_shape_and_no_digits_leak():
    key = normalize.account_key_from_number("Sample Bank", "000-123456789")
    assert key.startswith("acct:")
    assert len(key) == len("acct:") + 64
    assert "123456789" not in key


def test_account_key_stable_and_distinct():
    a = normalize.account_key_from_number("Sample Bank", "0001234")
    assert a == normalize.account_key_from_number(" SAMPLE bank ", "000-1234")
    assert a != normalize.account_key_from_number("Sample Bank", "0001235")
    assert a != normalize.account_key_from_number("Other Bank", "0001234")
    assert normalize.account_key_from_number(None, "0001234").startswith("acct:")


# --- seed rules -------------------------------------------------------------


def test_seed_table_shape():
    rules = seed_rules.SEED_RULES
    assert 150 <= len(rules) <= 260
    keywords = [k for k, _ in rules]
    assert len(keywords) == len(set(keywords))
    assert all(k == k.upper() and k.strip() == k for k in keywords)
    default_names = {
        "Housing", "Utilities", "Transportation", "Insurance", "Healthcare",
        "Debt Payments", "Food & Dining", "Entertainment", "Savings & Investments",
        "Personal", "Education", "Other",
    }  # fmt: skip
    assert {name for _, name in rules} <= default_names


@pytest.mark.parametrize(
    "name", ["SMITH", "JOHNSON", "GARCIA", "NGUYEN", "SMITH JOHN", "WILLIAMS"]
)
def test_seed_rules_never_match_person_names(name):
    assert seed_rules.seed_category_name(normalize.merchant_key(name)) is None


def test_seed_matches_on_token_boundary_only():
    assert seed_rules.seed_category_name("NETFLIX.COM CA") == "Entertainment"
    assert seed_rules.seed_category_name("SHELL OIL") == "Transportation"
    assert seed_rules.seed_category_name("SHELLEY JONES") is None
    assert seed_rules.seed_category_name("TARGETED ADS LLC") is None


def test_seed_longest_keyword_wins():
    assert seed_rules.seed_category_name("AMAZON PRIME VIDEO") == "Entertainment"
    assert seed_rules.seed_category_name("AMAZON WA") == "Personal"


def test_apply_rules_seed_maps_by_exact_category_name():
    txs = [_tx("NETFLIX.COM CA"), _tx("STARBUCKS WA"), _tx("UNKNOWN SHOP")]
    seed_rules.apply_rules(txs, {}, CATEGORIES)
    assert [(t["category_id"], t["category_source"]) for t in txs] == [
        ("c-ent", "seed"),
        ("c-food", "seed"),
        (None, "none"),
    ]


def test_apply_rules_renamed_or_missing_category_means_no_seed_match():
    renamed = [
        {"id": "c-ent", "name": "Fun Stuff"},
        {"id": "c-food", "name": "Food & Dining"},
    ]
    txs = [_tx("NETFLIX.COM CA"), _tx("STARBUCKS WA")]
    seed_rules.apply_rules(txs, {}, renamed)
    assert txs[0]["category_id"] is None and txs[0]["category_source"] == "none"
    assert txs[1]["category_id"] == "c-food"
    seed_rules.apply_rules(txs, {}, [])
    assert all(t["category_id"] is None for t in txs)


def test_user_rule_beats_seed():
    txs = [_tx("NETFLIX.COM CA")]
    seed_rules.apply_rules(
        txs, {"NETFLIX.COM CA": {"category_id": "c-pers"}}, CATEGORIES
    )
    assert (txs[0]["category_id"], txs[0]["category_source"]) == ("c-pers", "rule")


def test_user_rules_accept_list_of_rows():
    txs = [_tx("NETFLIX.COM CA")]
    seed_rules.apply_rules(
        txs, [{"merchant_key": "NETFLIX.COM CA", "category_id": "c-util"}], CATEGORIES
    )
    assert txs[0]["category_id"] == "c-util"


def test_user_rule_for_deleted_category_is_ignored_and_seed_applies():
    txs = [_tx("NETFLIX.COM CA")]
    seed_rules.apply_rules(txs, {"NETFLIX.COM CA": {"category_id": "gone"}}, CATEGORIES)
    assert (txs[0]["category_id"], txs[0]["category_source"]) == ("c-ent", "seed")


def test_user_rule_kind_replaces_row_kind():
    txs = [_tx("NETFLIX.COM CA", kind="expense"), _tx("ZELLE FRIEND", kind="expense")]
    rules = {
        "NETFLIX.COM CA": {"category_id": "c-ent", "kind": "refund"},
        "ZELLE FRIEND": {"category_id": "c-food", "kind": "transfer"},
    }
    seed_rules.apply_rules(txs, rules, CATEGORIES)
    assert txs[0]["kind"] == "refund" and txs[0]["category_id"] == "c-ent"
    assert txs[1]["kind"] == "transfer"
    assert txs[1]["category_id"] is None and txs[1]["category_source"] == "none"


@pytest.mark.parametrize("kind", ["income", "transfer", "payment"])
def test_uncategorizable_kinds_get_no_category(kind):
    txs = [_tx("NETFLIX.COM CA", kind=kind)]
    seed_rules.apply_rules(
        txs, {"NETFLIX.COM CA": {"category_id": "c-ent"}}, CATEGORIES
    )
    assert txs[0]["category_id"] is None and txs[0]["category_source"] == "none"


@pytest.mark.parametrize("kind", ["expense", "fee", "interest", "refund"])
def test_categorizable_kinds_get_category(kind):
    txs = [_tx("STARBUCKS WA", kind=kind)]
    seed_rules.apply_rules(txs, None, CATEGORIES)
    assert txs[0]["category_id"] == "c-food"


# --- errors and limits ------------------------------------------------------


def test_error_messages_are_fixed_and_dash_free():
    for error_type, (status, detail) in ERROR_CATALOG.items():
        assert 400 <= status < 600
        assert detail and EM_DASH not in detail
        err = SmartImportError(error_type)
        assert err.status == status and str(err) == detail
        assert err.body() == {"error_type": error_type, "detail": detail}


def test_error_statuses_match_design_limits_table():
    expected = {
        "file_too_large": 413,
        "unsupported_type": 415,
        "too_many_rows": 422,
        "field_too_large": 422,
        "ofx_too_large": 422,
        "too_many_pages": 422,
        "pdf_text_too_large": 422,
        "parse_timeout": 422,
        "bad_context": 422,
        "ai_unavailable": 503,
        "ai_not_enabled": 403,
        "ai_bad_response": 502,
    }
    for error_type, status in expected.items():
        assert SmartImportError(error_type).status == status


def test_unknown_error_type_still_has_a_fixed_message():
    err = SmartImportError("something_new")
    assert err.status == 422 and err.detail


def test_limit_constants_match_design():
    assert limits.MAX_FILE_BYTES == 10 * 1024 * 1024
    assert limits.MAX_CSV_ROWS == 20_000
    assert limits.MAX_CSV_FIELD_CHARS == 10_000
    assert limits.MAX_OFX_TAGS == 200_000
    assert limits.MAX_OFX_TAG_NAME == 32
    assert limits.MAX_OFX_VALUE_CHARS == 2_000
    assert limits.MAX_PDF_PAGES == 60
    assert limits.MAX_PDF_TEXT_CHARS == 2_000_000
    assert limits.PDF_WALL_CLOCK_SECONDS == 20
    assert limits.MAX_TRANSACTIONS_PER_STATEMENT == 10_000
    assert limits.MAX_FILES_PER_BATCH == 12
    assert limits.MAX_CONTEXT_BYTES == 256 * 1024


class _FakeUpload:
    def __init__(self, data: bytes):
        self._data = data
        self.requested: list[int] = []

    async def read(self, size: int = -1) -> bytes:
        self.requested.append(size)
        return self._data if size < 0 else self._data[:size]


async def test_read_limited_returns_data_at_the_limit():
    up = _FakeUpload(b"x" * 10)
    assert await limits.read_limited(up, 10) == b"x" * 10
    assert up.requested == [11]  # never reads more than limit + 1 bytes


async def test_read_limited_rejects_one_byte_over():
    with pytest.raises(SmartImportError) as exc:
        await limits.read_limited(_FakeUpload(b"x" * 11), 10)
    assert exc.value.error_type == "file_too_large" and exc.value.status == 413


@pytest.mark.parametrize(
    ("name", "head", "expected"),
    [
        ("a.csv", b"Date,Amount\n", "csv"),
        ("a.TXT", b"Date;Amount\n", "csv"),
        ("a.ofx", b"OFXHEADER:100\n", "ofx"),
        ("a.qfx", b"\n  <OFX><SIGNONMSGSRSV1>", "ofx"),
        ("a.pdf", b"%PDF-1.4\n", "pdf"),
    ],
)
def test_sniff_type_accepts_matching_content(name, head, expected):
    assert limits.sniff_type(name, head) == expected


@pytest.mark.parametrize(
    ("name", "head"),
    [
        ("a.pdf", b"Date,Amount\n"),
        ("a.ofx", b"%PDF-1.4"),
        ("a.csv", b"%PDF-1.4"),
        ("a.csv", b"OFXHEADER:100\n"),
        ("a.xlsx", b"PK\x03\x04"),
        ("noext", b"abc"),
        ("", b"abc"),
    ],
)
def test_sniff_type_rejects_mismatches(name, head):
    with pytest.raises(SmartImportError) as exc:
        limits.sniff_type(name, head)
    assert exc.value.error_type == "unsupported_type" and exc.value.status == 415


# --- hygiene ----------------------------------------------------------------


def test_no_em_dash_in_smart_import_sources_or_fixture():
    root = Path(__file__).resolve().parents[2]
    files = list((root / "src" / "smart_import").rglob("*.py")) + [
        FIXTURE,
        Path(__file__),
    ]
    for path in files:
        assert EM_DASH not in path.read_text(encoding="utf-8"), path.name


_BANNED_OS_PREFIXES = ("fork", "exec", "spawn", "posix_spawn", "system", "popen")


def _banned_os_name(name: str) -> bool:
    return name.startswith(_BANNED_OS_PREFIXES)


def test_smart_import_core_imports_no_database_or_xml():
    root = Path(__file__).resolve().parents[2] / "src" / "smart_import"
    banned = (
        "xml",
        "lxml",
        "defusedxml",
        "sqlalchemy",
        "subprocess",
        "pickle",
        "importlib",
        "multiprocessing",
    )
    # The one exception: pdf_parser runs the PDF extraction child with a fixed
    # argument list (sys.executable -I pdf_worker.py <limits>) and never a shell.
    # A multiprocessing spawn child would re-import src.main under
    # ``python -m src.main``, costing about 1.3s and the whole app per upload.
    # Keyed on the path under src/smart_import, so a same-named file elsewhere
    # in the package gets no exception.
    # service.py is the data layer (B2): the only module here that touches the
    # database, imported by src/api/smart_import.py and never by the stateless
    # parsers or the v2 routes (their forbid_database tests enforce that).
    allowed = {
        ("parsers/pdf_parser.py", "subprocess"),
        ("service.py", "sqlalchemy"),
    }
    for path in root.rglob("*.py"):
        rel = path.relative_to(root).as_posix()
        tree = ast.parse(path.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names = [node.module]
                if node.module == "os":
                    bad = [a.name for a in node.names if _banned_os_name(a.name)]
                    assert not bad, f"{rel} imports os.{bad}"
            for n in names:
                top = n.split(".")[0]
                if (rel, top) in allowed:
                    continue
                assert top not in banned, f"{rel} imports {n}"
            if isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
                if node.value.id == "os":
                    assert not _banned_os_name(node.attr), f"{rel} uses os.{node.attr}"
            if isinstance(node, ast.Name):
                assert node.id != "__import__", rel
            if isinstance(node, ast.Call):
                assert not any(k.arg == "shell" for k in node.keywords), rel
                func = node.func
                name = getattr(func, "attr", getattr(func, "id", ""))
                assert name not in ("system", "popen", "Popen", "eval", "exec"), rel


def test_core_import_ban_catches_process_and_dynamic_import_tricks():
    """The scan above must see these patterns (checked on synthetic source)."""
    for src in (
        "import os\nos.fork()",
        "import os\nos.execv('x', [])",
        "import os\nos.spawnl(0, 'x')",
        "import os\nos.posix_spawn('x', [], {})",
        "from os import execve",
        "import importlib\nimportlib.import_module('x')",
        "__import__('subprocess')",
    ):
        tree = ast.parse(src)
        hits = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and getattr(node.value, "id", "") == "os":
                hits.append(_banned_os_name(node.attr))
            if isinstance(node, ast.ImportFrom) and node.module == "os":
                hits.append(any(_banned_os_name(a.name) for a in node.names))
            if isinstance(node, ast.Import):
                hits.append(any(a.name.split(".")[0] == "importlib" for a in node.names))
            if isinstance(node, ast.Name):
                hits.append(node.id == "__import__")
        assert any(hits), src


# --- review round: separated numbers, payments, sniffing --------------------


@pytest.mark.parametrize(
    "raw",
    [
        "4111 1111 1111 1111",
        "4111-1111-1111-1111",
        "ACCT 1234 5678 9012 3456",
        "DE89 3704 0044 0532 0130 00",
        "GB29 NWBK 6016 1331 9268 19",
        "123-45-6789",
        "1234-5678-90",
        "4111.1111.1111.1111",
        "12345 67890",
    ],
)
def test_mask_description_hides_separated_account_numbers(raw):
    out = normalize.mask_description(f"PAY {raw} NOW")
    assert sum(c.isdigit() for c in out) < 9
    assert "1111" not in out and "6789" not in out and "0044" not in out
    assert "#" in out


def test_mask_description_keeps_labels_around_masked_numbers():
    assert normalize.mask_description("ACCT 1234 5678 9012 3456") == "ACCT #"
    assert normalize.mask_description("SSN 123-45-6789 X") == "SSN # X"


@pytest.mark.parametrize(
    "raw",
    [
        "PAID 2026-10-04 STORE",
        "POSTED 10/04/2026 STORE",
        "TOTAL 1,234.56 USD",
        "FEE 12.50 15.00 20.00",
        "DATES 2026-10-04 2026-10-05",
        "STORE 1234 5678",
    ],
)
def test_mask_description_does_not_mangle_dates_and_amounts(raw):
    assert normalize.mask_description(raw) == raw


@pytest.mark.parametrize("raw", ["CARD XXXX1234 SHOP", "CARD *1234 SHOP", "CARD ENDING 1234 SHOP"])
def test_last_four_forms_are_allowed_through(raw):
    # Deliberate: last-4 hints are display aids, not usable account numbers.
    assert normalize.mask_description(raw) == raw


def test_merchant_key_ignores_separated_numbers():
    assert normalize.merchant_key("SQ *COFFEE HOUSE 4111 1111 1111 1111") == "COFFEE HOUSE"
    assert normalize.merchant_key("NETFLIX.COM 866-579-7172 CA") == "NETFLIX.COM CA"


@pytest.mark.parametrize(
    ("description", "amount", "account_kind", "trntype", "expected"),
    [
        ("CAPITAL ONE AUTOPAY", -300.0, "checking", "DEBIT", "payment"),
        ("CAPITAL ONE MOBILE PMT", -300.0, "checking", None, "payment"),
        ("AMEX EPAYMENT ACH PMT", -300.0, "checking", "PAYMENT", "payment"),
        ("AMERICAN EXPRESS PAYMENT", -300.0, "checking", None, "payment"),
        ("CHASE CARD AUTOPAY", -300.0, "checking", "DEBIT", "payment"),
        ("DISCOVER E-PAYMENT", -300.0, "checking", None, "payment"),
        ("CITI CARD ONLINE PAYMENT", -300.0, "savings", None, "payment"),
        ("PAYMENT THANK YOU", -5.0, "credit_card", "DEBIT", "payment"),
        ("PAYMENT THANK YOU", 5.0, "credit_card", None, "payment"),
        ("PAYMENT THANK YOU", 5.0, "credit_card", "CREDIT", "payment"),
        ("DISCOVER MAGAZINE", -12.0, "checking", None, "expense"),
        ("CAPITAL ONE", -12.0, "checking", None, "expense"),
    ],
)
def test_infer_kind_payments_to_cards(description, amount, account_kind, trntype, expected):
    assert normalize.infer_kind(description, amount, account_kind, trntype) == expected


def test_seed_loose_prefixes_are_gone():
    for key in ["GAP", "TARGET", "BP", "HOA", "STEAM", "SMITH"]:
        assert seed_rules.seed_category_name(key) is None
    assert seed_rules.seed_category_name("STEAM GAMES") == "Entertainment"
    assert seed_rules.seed_category_name("STEAMPOWERED") == "Entertainment"
    assert seed_rules.seed_category_name("TARGET.COM") == "Personal"


def test_seed_source_has_no_trailing_whitespace_or_long_lines():
    root = Path(__file__).resolve().parents[2] / "src" / "smart_import"
    core = ("__init__", "types", "errors", "limits", "normalize", "seed_rules")
    for path in (root / f"{name}.py" for name in core):
        for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            assert line == line.rstrip(), f"{path.name}:{n} trailing whitespace"
            assert len(line) <= 100, f"{path.name}:{n} too long"


def test_sniff_type_txt_and_bom_cases():
    assert limits.sniff_type("export.txt", b"Date,Amount\n") == "csv"
    assert limits.sniff_type("a.csv", b"\xef\xbb\xbfDate,Amount\n") == "csv"
    assert limits.sniff_type("a.ofx", b"\xef\xbb\xbfOFXHEADER:100\n") == "ofx"
    assert limits.sniff_type("a.pdf", b"\xef\xbb\xbf%PDF-1.7") == "pdf"
    with pytest.raises(SmartImportError):
        limits.sniff_type("export.txt", b"%PDF-1.4")
    with pytest.raises(SmartImportError):
        limits.sniff_type("export.txt", b"OFXHEADER:100\n")


def test_error_details_have_no_format_placeholders():
    for error_type, (_, detail) in ERROR_CATALOG.items():
        assert not any(tok in detail for tok in ("{", "}", "%s", "%d", "%(")), error_type
