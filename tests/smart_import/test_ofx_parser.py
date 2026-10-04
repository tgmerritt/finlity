"""OFX / QFX tokenizer tests. All data is synthetic (design 4.3, plan Task A3)."""

from __future__ import annotations

import ast
import hashlib
import time
from pathlib import Path

import pytest

from src.smart_import.errors import SmartImportError
from src.smart_import.limits import (
    MAX_OFX_TAG_NAME,
    MAX_OFX_TAGS,
    MAX_OFX_VALUE_CHARS,
    MAX_TRANSACTIONS_PER_STATEMENT,
)
from src.smart_import.normalize import (
    account_key_from_number,
    dedupe_base,
    merchant_key,
)
from src.smart_import.parsers.ofx_parser import parse_ofx

FIX = Path(__file__).resolve().parents[1] / "fixtures" / "smart_import" / "ofx"
SRC = Path(__file__).resolve().parents[2] / "src" / "smart_import"


def _read(name: str) -> bytes:
    return (FIX / name).read_bytes()


def _err(content: bytes) -> str:
    with pytest.raises(SmartImportError) as exc:
        parse_ofx(content, "x.ofx", {})
    return exc.value.error_type


def _sgml(body: str, charset: str = "1252") -> bytes:
    head = f"OFXHEADER:100\nDATA:OFXSGML\nVERSION:102\nCHARSET:{charset}\n\n"
    return (head + "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>" + body).encode("cp1252")


def _txn(name="X", amt="-1.00", date="20261001", fitid="F1", memo="") -> str:
    memo_tag = f"<MEMO>{memo}" if memo else ""
    return (
        f"<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>{date}<TRNAMT>{amt}"
        f"<FITID>{fitid}<NAME>{name}{memo_tag}</STMTTRN>"
    )


# --- v1 SGML ---------------------------------------------------------------


def test_bank_v1_statement_shape():
    content = _read("bank_v1.ofx")
    stmts = parse_ofx(content, "bank_v1.ofx", {})
    assert len(stmts) == 1
    s = stmts[0]
    assert s["file_hash"] == hashlib.sha256(content).hexdigest()
    assert (s["file_name"], s["format"], s["parser"], s["origin"]) == (
        "bank_v1.ofx",
        "ofx",
        "ofx",
        "file",
    )
    assert s["account"] == {
        "kind": "checking",
        "key": account_key_from_number("9999", "000000001234"),
        "last4": "1234",
        "institution": "Sample Bank",
    }
    assert s["period"] == {"start": "2026-10-01", "end": "2026-10-31"}
    assert s["closing_balance"] == {"amount": 3421.17, "as_of": "2026-10-31"}
    assert s["extras"] is None
    assert s["warnings"] == []
    assert len(s["transactions"]) == 8


def test_bank_v1_transactions():
    t = parse_ofx(_read("bank_v1.ofx"), "b.ofx", {})[0]["transactions"]
    assert [x["row"] for x in t] == list(range(8))
    first = t[0]
    assert first["posted_date"] == "2026-10-02"
    assert first["amount"] == -12.5
    assert first["description"] == "BLUE BOTTLE COFFEE #123 POS PURCHASE"
    assert first["merchant_key"] == merchant_key("BLUE BOTTLE COFFEE #123 POS PURCHASE")
    assert first["kind"] == "expense"
    assert first["external_id"] == "2026100201"
    assert first["dedupe_base"] == dedupe_base(
        "2026-10-02",
        -12.5,
        first["merchant_key"],
        first["description"],
        0,
        fitid="2026100201",
    )
    assert first["category_id"] is None and first["category_source"] == "none"
    assert t[1]["kind"] == "income" and t[1]["amount"] == 2500.0
    # XFER, SRVCHG, INT map through TRNTYPE
    assert t[5]["kind"] == "transfer"
    assert t[6]["kind"] == "fee"
    assert t[7]["kind"] == "interest" and t[7]["amount"] == 0.12


def test_identical_rows_without_fitid_get_occurrences():
    t = parse_ofx(_read("bank_v1.ofx"), "b.ofx", {})[0]["transactions"]
    a, b = t[2], t[3]
    assert a["external_id"] is None and b["external_id"] is None
    assert a["description"] == b["description"] == "CORNER CAFÉ"  # cp1252 byte 0xC9
    assert a["dedupe_base"] != b["dedupe_base"]


def test_decimal_comma_and_entities():
    t = parse_ofx(_read("bank_v1.ofx"), "b.ofx", {})[0]["transactions"][4]
    assert t["amount"] == -23.10
    # &amp; and &#233; decode, &lt; decodes, &foo; stays literal
    assert t["description"] == "TACOS & MORE &foo; é <3"


def test_entities_single_pass_not_double_decoded():
    c = _sgml(
        "<BANKTRANLIST>"
        + _txn(name="A &amp;lt; B &#x41; &#65; &#0; &bogus; &amp")
        + "</BANKTRANLIST>"
    )
    d = parse_ofx(c, "x", {})[0]["transactions"][0]["description"]
    assert d == "A &lt; B A A &#0; &bogus; &amp"


# --- v2 XML / QFX ----------------------------------------------------------


def test_card_v2_qfx():
    content = _read("card_v2.qfx")
    s = parse_ofx(content, "card_v2.qfx", {})[0]
    assert s["account"]["kind"] == "credit_card"
    assert s["account"]["last4"] == "5678"
    assert s["account"]["institution"] == "Sample Card Co"
    assert s["account"]["key"] == account_key_from_number("7777", "000000005678")
    # LEDGERBAL -1234.56 means owed: stored positive
    assert s["closing_balance"] == {"amount": 1234.56, "as_of": "2026-10-31"}
    assert s["period"] == {"start": "2026-10-01", "end": "2026-10-31"}
    t = s["transactions"]
    assert [x["kind"] for x in t] == [
        "expense",
        "payment",
        "refund",
        "fee",
        "interest",
        "expense",
    ]
    assert t[0]["amount"] == -45.67 and t[1]["amount"] == 300.0
    assert t[0]["description"] == "GROCERY MART & DELI"
    assert t[5]["description"] == "STREAMING SERVICE"
    assert [x["external_id"] for x in t] == ["Q1", "Q2", "Q3", "Q4", "Q5", "Q6"]


def test_two_statements_in_one_file():
    content = _read("two_statements.ofx")
    stmts = parse_ofx(content, "two.ofx", {})
    assert [s["account"]["kind"] for s in stmts] == ["checking", "credit_card"]
    assert {s["file_hash"] for s in stmts} == {hashlib.sha256(content).hexdigest()}
    assert len(stmts[0]["transactions"]) == 8 and len(stmts[1]["transactions"]) == 2
    assert stmts[1]["closing_balance"]["amount"] == 1234.56
    assert stmts[0]["account"]["key"] != stmts[1]["account"]["key"]


def test_origin_from_context_is_whitelisted():
    c = _read("card_v2.qfx")
    assert parse_ofx(c, "s", {"origin": "sample"})[0]["origin"] == "sample"
    assert parse_ofx(c, "s", {"origin": "<script>"})[0]["origin"] == "file"
    assert parse_ofx(c, "s", {})[0]["origin"] == "file"


# --- encodings -------------------------------------------------------------


def test_utf8_bom_and_utf16_bom():
    xml = _read("card_v2.qfx")
    assert len(parse_ofx(b"\xef\xbb\xbf" + xml, "x", {})[0]["transactions"]) == 6
    u16 = b"\xff\xfe" + xml.decode().encode("utf-16-le")
    assert len(parse_ofx(u16, "x", {})[0]["transactions"]) == 6


def test_utf8_charset_header():
    c = _sgml(
        "<BANKTRANLIST>" + _txn(name="CAFÉ") + "</BANKTRANLIST>", charset="UNICODE"
    )
    c = c.replace(b"CAF\xc9", "CAFÉ".encode())
    d = parse_ofx(c, "x", {})[0]["transactions"][0]["description"]
    assert d == "CAFÉ"


def test_invalid_utf8_falls_back_to_cp1252():
    c = _sgml("<BANKTRANLIST>" + _txn(name="CAFÉ") + "</BANKTRANLIST>", charset="NONE")
    assert parse_ofx(c, "x", {})[0]["transactions"][0]["description"] == "CAFÉ"


def test_nul_bytes_without_bom_unreadable():
    assert _err(_read("card_v2.qfx").replace(b"<OFX>", b"<O\x00FX>")) == "unreadable"


# --- unsupported constructs ------------------------------------------------


@pytest.mark.parametrize("name", ["doctype.ofx", "entity.ofx", "cdata.ofx"])
def test_unsupported_fixtures(name):
    assert _err(_read(name)) == "unsupported_ofx"


@pytest.mark.parametrize(
    "snippet",
    [
        b"<!DOCTYPE x>",
        b"<!ENTITY a 'b'>",
        b"<!ELEMENT a ANY>",
        b"<![CDATA[x]]>",
        b"<!-- hi -->",
        b"<?xml-stylesheet href='x'?>",
        b"<?php echo 1 ?>",
    ],
)
def test_unsupported_constructs_anywhere(snippet):
    base = _read("card_v2.qfx")
    assert (
        _err(base.replace(b"<LANGUAGE>", snippet + b"<LANGUAGE>")) == "unsupported_ofx"
    )


def test_prolog_only_allowed_at_start():
    base = _read("card_v2.qfx")
    mid = base.replace(b"<LANGUAGE>", b'<?xml version="1.0"?><LANGUAGE>')
    assert _err(mid) == "unsupported_ofx"


def test_investment_statement_unsupported():
    c = b"OFXHEADER:100\n\n<OFX><INVSTMTMSGSRSV1><INVSTMTTRNRS><INVSTMTRS><DTASOF>20261001</INVSTMTRS></OFX>"
    assert _err(c) == "unsupported_ofx"


def test_external_entity_never_resolved(tmp_path):
    marker = tmp_path / "secret.txt"
    marker.write_text("TOPSECRETVALUE")
    c = (
        f'<?xml version="1.0"?><!DOCTYPE OFX [<!ENTITY x SYSTEM "file://{marker}">]>'
        "<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST><STMTTRN><NAME>&x;</NAME>"
        "</STMTTRN></BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>"
    ).encode()
    assert _err(c) == "unsupported_ofx"


# --- limits and hostile input ---------------------------------------------


def test_tag_name_cap():
    ok = "A" * MAX_OFX_TAG_NAME
    assert parse_ofx(
        _sgml(f"<{ok}>1<BANKTRANLIST>" + _txn() + "</BANKTRANLIST>"), "x", {}
    )
    assert _err(_sgml("<" + "A" * (MAX_OFX_TAG_NAME + 1) + ">1")) == "ofx_too_large"


def test_huge_single_tag():
    assert _err(_sgml("<" + "A" * 5_000_000 + ">1")) == "ofx_too_large"


def test_value_cap():
    ok = _sgml(
        "<BANKTRANLIST>" + _txn(name="N" * MAX_OFX_VALUE_CHARS) + "</BANKTRANLIST>"
    )
    assert parse_ofx(ok, "x", {})
    big = _sgml(
        "<BANKTRANLIST>"
        + _txn(name="N" * (MAX_OFX_VALUE_CHARS + 1))
        + "</BANKTRANLIST>"
    )
    assert _err(big) == "ofx_too_large"


def test_huge_value_without_tags():
    assert _err(_sgml("<MEMO>" + "z" * 9_000_000)) == "ofx_too_large"


def test_tag_count_cap():
    body = "<A>1" * (MAX_OFX_TAGS + 10)
    assert _err(_sgml(body)) == "ofx_too_large"


def test_deep_nesting_is_bounded_not_recursive():
    deep = _sgml("<A>" * 100_000)
    assert _err(deep) == "ofx_too_large"
    # also with the closers present
    xml = ("<A>" * 5000 + "</A>" * 5000).encode()
    assert _err(b"<OFX>" + xml + b"</OFX>") == "ofx_too_large"


def test_billion_laughs_style_text_is_inert_and_fast():
    laugh = "&lol9;" * 100_000
    c = _sgml("<BANKTRANLIST>" + _txn(name="X", memo=laugh[:1500]) + "</BANKTRANLIST>")
    t0 = time.perf_counter()
    s = parse_ofx(c, "x", {})
    assert time.perf_counter() - t0 < 2
    assert "&lol9;" in s[0]["transactions"][0]["description"]


def test_too_many_transactions():
    body = "".join(
        f"<STMTTRN><DTPOSTED>20261001<TRNAMT>-1<FITID>{i}</STMTTRN>"
        for i in range(MAX_TRANSACTIONS_PER_STATEMENT + 1)
    )
    assert _err(_sgml("<BANKTRANLIST>" + body + "</BANKTRANLIST>")) == "too_many_rows"


def test_linear_time_on_large_input():
    txns = "".join(_txn(fitid=str(i)) for i in range(9000))
    c = _sgml("<BANKTRANLIST>" + txns + "</BANKTRANLIST>")
    t0 = time.perf_counter()
    s = parse_ofx(c, "x", {})
    assert len(s[0]["transactions"]) == 9000
    assert time.perf_counter() - t0 < 5


def _many_fi(statements: int, fi_nodes: int) -> bytes:
    stmt = "<STMTRS><BANKACCTFROM><ACCTID>12345678</BANKACCTFROM></STMTRS>"
    return (
        "OFXHEADER:100\n<OFX>"
        + "<FI></FI>" * fi_nodes
        + stmt * statements
        + "</OFX>"
    ).encode()


def test_statement_cap():
    assert len(parse_ofx(_many_fi(12, 1), "x", {})) == 12
    t0 = time.perf_counter()
    assert _err(_many_fi(13, 1)) == "ofx_too_large"
    # Rejected while tokenizing, not after building every statement.
    assert _err(_many_fi(20_000, 1)) == "ofx_too_large"
    assert time.perf_counter() - t0 < 2


def test_institution_is_resolved_once_not_per_statement(monkeypatch):
    from src.smart_import.parsers import ofx_parser

    calls = []
    real = ofx_parser._institution
    monkeypatch.setattr(
        ofx_parser, "_institution", lambda tree: calls.append(1) or real(tree)
    )
    # 12 statements and ~90k empty FI blocks (inside the tag cap): the FI scan
    # used to run once per statement.
    content = _many_fi(12, 90_000)
    t0 = time.perf_counter()
    assert len(parse_ofx(content, "x", {})) == 12
    assert time.perf_counter() - t0 < 1.5
    assert len(calls) == 1


def test_interleaved_fi_and_statements_fail_fast():
    # The review probe: FI/STMTRS pairs, quadratic before (20k pairs took 59s).
    body = "<FI></FI><STMTRS></STMTRS>" * 20_000
    t0 = time.perf_counter()
    assert _err(("OFXHEADER:100\n<OFX>" + body + "</OFX>").encode()) == "ofx_too_large"
    assert time.perf_counter() - t0 < 2


def test_many_unclosed_tags_linear():
    c = _sgml("<A>" + "<B>x" * 150_000)
    t0 = time.perf_counter()
    parse_ofx(c, "x", {})
    assert time.perf_counter() - t0 < 3


def test_many_ampersands_linear():
    c = _sgml(
        "<BANKTRANLIST>" + _txn(name="&" * 1900 + "&amp;" * 20) + "</BANKTRANLIST>"
    )
    t0 = time.perf_counter()
    parse_ofx(c, "x", {})
    assert time.perf_counter() - t0 < 1


# --- malformed and truncated ----------------------------------------------


def test_empty_and_garbage():
    assert _err(b"") == "unreadable"
    assert _err(b"hello world") == "unreadable"
    assert _err(b"<OFX></OFX>") == "unreadable"


def test_truncated_inside_tag_is_unreadable_or_partial():
    full = _read("bank_v1.ofx")
    for cut in range(0, len(full), 37):
        try:
            parse_ofx(full[:cut], "x", {})
        except SmartImportError as exc:
            assert exc.error_type in {"unreadable", "ofx_too_large", "unsupported_ofx"}


def test_truncated_mid_transaction_keeps_complete_rows_and_warns():
    full = _read("bank_v1.ofx")
    cut = full.index(b"CORNER CAF") + 5
    s = parse_ofx(full[:cut], "x", {})[0]
    assert "truncated_file" in s["warnings"]
    assert [x["external_id"] for x in s["transactions"]] == ["2026100201", "2026100501"]


def test_missing_closing_ofx_tag_is_fine():
    full = _read("bank_v1.ofx").replace(b"</OFX>", b"")
    s = parse_ofx(full, "x", {})[0]
    assert "truncated_file" not in s["warnings"] and len(s["transactions"]) == 8


def test_bad_rows_skipped_with_warning():
    body = (
        "<BANKTRANLIST>"
        + _txn(date="notadate", fitid="a")
        + _txn(amt="abc", fitid="b")
        + _txn(amt="1E999999", fitid="c")
        + _txn(date="20261340", fitid="d")
        + _txn(name="OK", fitid="e")
        + "</BANKTRANLIST>"
    )
    s = parse_ofx(_sgml(body), "x", {})[0]
    assert [t["external_id"] for t in s["transactions"]] == ["e"]
    assert "rows_skipped" in s["warnings"]


def test_duplicate_fitid_does_not_collide():
    body = (
        "<BANKTRANLIST>" + _txn(fitid="same") + _txn(fitid="same") + "</BANKTRANLIST>"
    )
    s = parse_ofx(_sgml(body), "x", {})[0]
    bases = [t["dedupe_base"] for t in s["transactions"]]
    assert len(set(bases)) == 2
    assert "duplicate_fitid" in s["warnings"]


def test_statement_without_account_or_balance():
    s = parse_ofx(_sgml("<BANKTRANLIST>" + _txn() + "</BANKTRANLIST>"), "x", {})[0]
    assert s["account"]["key"] is None and s["account"]["last4"] is None
    assert s["closing_balance"] is None
    assert s["period"] == {"start": "2026-10-01", "end": "2026-10-01"}
    assert s["account"]["kind"] == "unknown"


def test_available_balance_fallback_only_for_deposit_accounts():
    body = (
        "<BANKACCTFROM><ACCTID>1<ACCTTYPE>SAVINGS</BANKACCTFROM><BANKTRANLIST></BANKTRANLIST>"
        "<AVAILBAL><BALAMT>10.00<DTASOF>20261001</AVAILBAL>"
    )
    s = parse_ofx(_sgml(body), "x", {})[0]
    assert s["account"]["kind"] == "savings"
    assert s["closing_balance"] == {"amount": 10.0, "as_of": "2026-10-01"}
    assert "available_balance_used" in s["warnings"]
    card = (
        _read("card_v2.qfx")
        .replace(b"<LEDGERBAL>", b"<XX>")
        .replace(b"</LEDGERBAL>", b"</XX>")
    )
    assert parse_ofx(card, "x", {})[0]["closing_balance"] is None


# --- no XML library, no content leaks --------------------------------------


def test_no_xml_imports_in_smart_import_package():
    banned = {"xml", "lxml", "defusedxml"}
    offenders = []
    for path in SRC.rglob("*.py"):
        tree = ast.parse(path.read_text())
        for node in ast.walk(tree):
            names: list[str] = []
            if isinstance(node, ast.Import):
                names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
                names = [node.module]
            for n in names:
                if n.split(".")[0] in banned:
                    offenders.append((str(path), n))
    assert offenders == []


def test_error_messages_do_not_echo_content():
    secret = "SECRETMERCHANT9"
    c = f"<!DOCTYPE {secret}>".encode()
    with pytest.raises(SmartImportError) as exc:
        parse_ofx(c, secret + ".ofx", {})
    assert secret not in str(exc.value) and secret not in repr(exc.value.body())


def test_no_em_dash_in_fixtures_or_module():
    for p in list(FIX.iterdir()) + [SRC / "parsers" / "ofx_parser.py"]:
        assert chr(0x2014) not in p.read_bytes().decode("cp1252", errors="replace")
