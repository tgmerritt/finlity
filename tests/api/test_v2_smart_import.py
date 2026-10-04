"""Tests for the stateless /api/v2/smart-import analyze, recurring and status routes."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from src.main import app
from src.smart_import import limits
from src.smart_import.analyze import analyze_file
from src.smart_import.parsers.pdf_parser import NeedsAiLayout
from tests.smart_import.db_guard import forbid_database
from tests.smart_import.pdf_factory import make_pdf

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "smart_import"
SAMPLES = Path(__file__).resolve().parents[2] / "src" / "web" / "src" / "samples"

PLANTED_NAME = "jane_planted_statement.csv"
PLANTED_MERCHANT = "ZQXPLANTED WIDGETS"
PLANTED_AMOUNT = "7777.77"
PLANTED_CSV = (
    "Date,Description,Amount\n"
    f"2026-03-01,{PLANTED_MERCHANT},-{PLANTED_AMOUNT}\n"
    "2026-03-02,OTHER SHOP,-3.10\n"
).encode()

CATEGORIES = [{"id": "c-food", "name": "Food & Dining"}]
ANALYZE = "/api/v2/smart-import/analyze"
RECURRING = "/api/v2/smart-import/recurring"
STATUS = "/api/v2/smart-import/status"
ROUTES = [
    ("POST", ANALYZE),
    ("POST", RECURRING),
    ("GET", STATUS),
]


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _post(client, name: str, content: bytes, context=None, ctype="text/plain"):
    data = {} if context is None else {"context": json.dumps(context)}
    return client.post(ANALYZE, files={"file": (name, content, ctype)}, data=data)


def _assert_fixed_error(resp, status: int, error_type: str, *leaks: str):
    assert resp.status_code == status
    body = resp.json()
    assert set(body) == {"error_type", "detail"}
    assert body["error_type"] == error_type
    for leak in leaks:
        assert leak not in resp.text


# ---- formats ---------------------------------------------------------------


def test_analyze_csv_ok(client):
    resp = _post(client, "s.csv", (SAMPLES / "sample-checking.csv").read_bytes())
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert len(body["statements"]) == 1
    assert body["statements"][0]["format"] == "csv"


def test_analyze_csv_applies_categories(client):
    resp = _post(
        client, "s.csv", PLANTED_CSV, {"categories": [{"id": "c1", "name": "Other"}]}
    )
    assert resp.status_code == 200


def test_analyze_ofx_ok_with_seed_categories(client):
    resp = _post(
        client,
        "card.ofx",
        (SAMPLES / "sample-card.ofx").read_bytes(),
        {"categories": [{"id": "c-pers", "name": "Personal"}]},
    )
    assert resp.status_code == 200
    stmt = resp.json()["statements"][0]
    assert stmt["format"] == "ofx"
    sources = {t["category_source"] for t in stmt["transactions"]}
    assert "seed" in sources


def test_analyze_qfx_two_statements(client):
    content = (FIXTURES / "ofx" / "two_statements.ofx").read_bytes()
    resp = _post(client, "two.qfx", content)
    assert resp.status_code == 200
    assert len(resp.json()["statements"]) == 2


def test_analyze_pdf_ok(client):
    content = make_pdf(
        [
            "Statement Period 03/01/2026 - 03/31/2026",
            "Beginning Balance 1,000.00",
            "03/02 WHOLE FOODS MARKET 25.00",
            "03/05 SHELL OIL 40.00",
        ]
    )
    resp = _post(client, "s.pdf", content, ctype="application/pdf")
    assert resp.status_code == 200
    assert resp.json()["status"] in {"ok", "needs_ai_layout"}


def test_analyze_pdf_needs_ai_layout(client, monkeypatch):
    import src.smart_import.analyze as analyze_mod

    monkeypatch.setattr(
        analyze_mod,
        "parse_pdf",
        lambda content, name, ctx: NeedsAiLayout(
            lines=["03/02 THING 4.00"], line_count=1, file_hash="ab" * 32
        ),
    )
    resp = _post(client, "s.pdf", make_pdf(["x"]), ctype="application/pdf")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "needs_ai_layout",
        "file_hash": "ab" * 32,
        "line_count": 1,
        "lines": ["03/02 THING 4.00"],
    }


def test_analyze_needs_mapping(client):
    content = (FIXTURES / "csv" / "unmapped.csv").read_bytes()
    resp = _post(client, "u.csv", content)
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "needs_mapping"
    assert body["headers"]
    assert "sample_rows" in body


# ---- errors ----------------------------------------------------------------


@pytest.mark.parametrize(
    "name,content",
    [
        ("notes.docx", b"hello"),
        ("s.pdf", b"Date,Description,Amount\n"),
        ("s.csv", b"%PDF-1.4 whatever"),
        ("s.ofx", b"Date,Description,Amount\n"),
    ],
)
def test_wrong_extension_or_sniffed_type_is_415(client, name, content):
    resp = _post(client, name, content)
    _assert_fixed_error(resp, 415, "unsupported_type", name)


def test_exactly_at_limit_is_not_413_but_one_over_is(client):
    over = b"a" * (limits.MAX_FILE_BYTES + 1)
    resp = _post(client, "big.csv", over)
    _assert_fixed_error(resp, 413, "file_too_large")


def test_oversized_chunked_body_is_413_without_content_length(client):
    boundary = "xBOUNDARYx"
    head = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="b.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
    ).encode()

    def body():
        yield head
        chunk = b"a" * (1024 * 1024)
        for _ in range(14):
            yield chunk
        yield f"\r\n--{boundary}--\r\n".encode()

    resp = client.post(
        ANALYZE,
        content=body(),
        headers={"content-type": f"multipart/form-data; boundary={boundary}"},
    )
    _assert_fixed_error(resp, 413, "file_too_large")


def test_declared_content_length_over_cap_is_413(client):
    resp = client.post(
        ANALYZE,
        content=b"x",
        headers={
            "content-type": "multipart/form-data; boundary=zz",
            "content-length": str(limits.MAX_FILE_BYTES * 4),
        },
    )
    assert resp.status_code == 413
    assert set(resp.json()) == {"error_type", "detail"}


@pytest.mark.parametrize(
    "context",
    ["{not json", "[1,2]", '"text"', "null", json.dumps({"flip_sign": "yes"})],
)
def test_malformed_context_is_422_bad_context(client, context):
    resp = client.post(
        ANALYZE,
        files={"file": ("s.csv", PLANTED_CSV, "text/csv")},
        data={"context": context},
    )
    _assert_fixed_error(resp, 422, "bad_context", PLANTED_MERCHANT, PLANTED_NAME)


def test_oversized_context_is_422_bad_context(client):
    big = json.dumps({"pad": "x" * (limits.MAX_CONTEXT_BYTES + 10)})
    resp = client.post(
        ANALYZE,
        files={"file": ("s.csv", PLANTED_CSV, "text/csv")},
        data={"context": big},
    )
    _assert_fixed_error(resp, 422, "bad_context")


def test_missing_file_is_fixed_422(client):
    resp = client.post(ANALYZE, data={"context": "{}"})
    _assert_fixed_error(resp, 422, "bad_request")


def test_parser_errors_use_catalog_bodies(client):
    resp = _post(client, PLANTED_NAME, b"just one line of text, no table")
    assert resp.status_code in (200, 422)
    if resp.status_code == 422:
        _assert_fixed_error(resp, 422, "unreadable", PLANTED_NAME)


def test_unexpected_parser_exception_is_fixed_body_and_not_logged(
    client, monkeypatch, caplog
):
    import src.smart_import.analyze as analyze_mod

    def explode(*args, **kwargs):
        raise RuntimeError(f"secret {PLANTED_MERCHANT} {PLANTED_AMOUNT}")

    monkeypatch.setattr(analyze_mod, "parse_csv", explode)
    with caplog.at_level(logging.DEBUG):
        resp = _post(client, PLANTED_NAME, PLANTED_CSV)
    _assert_fixed_error(resp, 422, "unreadable", PLANTED_MERCHANT, PLANTED_AMOUNT)
    for text in (caplog.text, *[r.getMessage() for r in caplog.records]):
        assert PLANTED_MERCHANT not in text
        assert PLANTED_AMOUNT not in text
        assert PLANTED_NAME not in text
    assert all(r.exc_info is None for r in caplog.records)


# ---- upload closed ---------------------------------------------------------


def test_upload_close_is_awaited(client, monkeypatch):
    from starlette.datastructures import UploadFile

    closed: list[bool] = []
    original = UploadFile.close

    async def spy(self):
        closed.append(True)
        return await original(self)

    monkeypatch.setattr(UploadFile, "close", spy)
    assert _post(client, "s.csv", PLANTED_CSV).status_code == 200
    assert _post(client, "s.csv", b"%PDF-1.4").status_code == 415
    assert len(closed) == 2


# ---- privacy ---------------------------------------------------------------


def test_caplog_has_no_content_on_success_and_failure(client, caplog):
    with caplog.at_level(logging.DEBUG):
        ok = _post(client, PLANTED_NAME, PLANTED_CSV)
        bad = _post(client, PLANTED_NAME, b"%PDF-1.4 " + PLANTED_CSV)
        ctx = client.post(
            ANALYZE,
            files={"file": (PLANTED_NAME, PLANTED_CSV, "text/csv")},
            data={"context": "{oops"},
        )
    assert ok.status_code == 200 and bad.status_code == 415 and ctx.status_code == 422
    blob = caplog.text + " ".join(r.getMessage() for r in caplog.records)
    for planted in (PLANTED_NAME, PLANTED_MERCHANT, PLANTED_AMOUNT, "OTHER SHOP"):
        assert planted not in blob


def test_responses_carry_no_store_cache_header(client):
    resp = _post(client, "s.csv", PLANTED_CSV)
    assert "no-store" in resp.headers["cache-control"]


# ---- recurring -------------------------------------------------------------


def _bills():
    return [
        {
            "posted_date": f"2026-0{m}-05",
            "amount": -15.49,
            "description": "NETFLIX.COM",
            "merchant_key": "NETFLIX",
            "kind": "expense",
            "category_id": None,
        }
        for m in (1, 2, 3)
    ]


def test_recurring_returns_candidates(client):
    resp = client.post(
        RECURRING,
        json={"rows": _bills(), "history": [], "expenses": [], "categories": []},
    )
    assert resp.status_code == 200
    candidates = resp.json()["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["merchant_key"] == "NETFLIX"
    assert candidates[0]["frequency"] == "monthly"


def test_recurring_list_caps_are_fixed_422(client):
    big = [{"merchant_key": PLANTED_MERCHANT}] * 20_001
    resp = client.post(
        RECURRING,
        json={"rows": big, "history": [], "expenses": [], "categories": []},
    )
    _assert_fixed_error(resp, 422, "bad_request", PLANTED_MERCHANT)


def test_recurring_accepts_exactly_the_cap(client):
    rows = [{"merchant_key": "X"}] * 20_000
    resp = client.post(
        RECURRING,
        json={"rows": rows, "history": [], "expenses": [], "categories": []},
    )
    assert resp.status_code == 200


def test_recurring_validation_error_does_not_echo_input(client):
    resp = client.post(RECURRING, json={"rows": PLANTED_MERCHANT})
    _assert_fixed_error(resp, 422, "bad_request", PLANTED_MERCHANT)


# ---- status ----------------------------------------------------------------


def test_status_without_key(client, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.setenv("SMART_IMPORT_AI_ENABLED", "true")
    body = client.get(STATUS).json()
    assert body["ai_available"] is False
    assert body["pdf_ai_available"] is False
    assert body["provider"] is None
    assert body["model"] is None
    assert body["limits"]["max_file_bytes"] == limits.MAX_FILE_BYTES


def test_status_flags(client, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-not-used")
    monkeypatch.delenv("SMART_IMPORT_AI_ENABLED", raising=False)
    monkeypatch.delenv("SMART_IMPORT_PDF_AI_ENABLED", raising=False)
    assert client.get(STATUS).json()["ai_available"] is False

    monkeypatch.setenv("SMART_IMPORT_AI_ENABLED", "true")
    body = client.get(STATUS).json()
    assert body["ai_available"] is True
    assert body["pdf_ai_available"] is False
    assert body["provider"] == "Anthropic Claude"
    assert body["model"]

    monkeypatch.setenv("SMART_IMPORT_PDF_AI_ENABLED", "true")
    assert client.get(STATUS).json()["pdf_ai_available"] is True

    monkeypatch.delenv("SMART_IMPORT_AI_ENABLED")
    body = client.get(STATUS).json()
    assert body["ai_available"] is False
    assert body["pdf_ai_available"] is False


# ---- no database -----------------------------------------------------------


def test_no_database_is_opened_by_any_route(client, monkeypatch):
    forbid_database(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-not-used")
    assert _post(client, "s.csv", PLANTED_CSV).status_code == 200
    assert (
        client.post(
            RECURRING,
            json={"rows": _bills(), "history": [], "expenses": [], "categories": []},
        ).status_code
        == 200
    )
    assert client.get(STATUS).status_code == 200
    bad = _post(client, "s.csv", b"%PDF-1.4")
    assert bad.status_code == 415


def test_analyze_file_is_pure_and_defensive():
    result = analyze_file(PLANTED_CSV, "x.csv", {"categories": CATEGORIES})
    assert result["status"] == "ok"


def test_legacy_csv_error_path_does_not_log_the_file_name(caplog):
    from fastapi import HTTPException

    from src.api.bank_statements import _parse_file_rows

    with caplog.at_level(logging.DEBUG):
        with pytest.raises(HTTPException):
            _parse_file_rows(PLANTED_NAME, b"\xff\xfe\xfa not utf8 \x80\x81")
    assert caplog.records, "the failure should still be logged"
    blob = caplog.text + " ".join(r.getMessage() for r in caplog.records)
    assert PLANTED_NAME not in blob
    assert "jane" not in blob
    assert any("UnicodeDecodeError" in r.getMessage() for r in caplog.records)
    assert all(r.exc_info is None for r in caplog.records)


@pytest.mark.parametrize("field", ["expenses", "categories"])
def test_recurring_reference_lists_are_capped_at_2000(client, field):
    from src.api.v2.smart_import import MAX_RECURRING_REFERENCE_ITEMS

    assert MAX_RECURRING_REFERENCE_ITEMS == 2_000
    body = {"rows": [], "history": [], "expenses": [], "categories": []}
    body[field] = [{"id": "x", "name": PLANTED_MERCHANT}] * 2_000
    assert client.post(RECURRING, json=body).status_code == 200
    body[field] = [{"id": "x", "name": PLANTED_MERCHANT}] * 2_001
    _assert_fixed_error(
        client.post(RECURRING, json=body), 422, "bad_request", PLANTED_MERCHANT
    )
    status = client.get(STATUS).json()
    assert status["limits"]["max_recurring_reference_items"] == 2_000


# ---- body caps without Content-Length --------------------------------------


def _chunked_json(total_bytes: int):
    """A JSON body sent with Transfer-Encoding: chunked (no Content-Length)."""
    filler = total_bytes - 32

    def body():
        yield b'{"rows": [], "pad": "'
        chunk = b"a" * (1024 * 1024)
        sent = 0
        while sent < filler:
            part = chunk[: min(len(chunk), filler - sent)]
            sent += len(part)
            yield part
        yield b'"}'

    return body()


@pytest.mark.parametrize(
    "path",
    [
        RECURRING,
        "/api/v2/smart-import/categorize",
        "/api/v2/smart-import/extract",
        "/api/smart-import/categorize",
        "/api/smart-import/extract",
    ],
)
def test_chunked_json_over_the_cap_is_413(client, path):
    from src.api.v2.smart_import import MAX_JSON_BODY_BYTES

    resp = client.post(
        path,
        content=_chunked_json(MAX_JSON_BODY_BYTES + 2 * 1024 * 1024),
        headers={"content-type": "application/json"},
    )
    assert "content-length" not in {k.lower() for k in resp.request.headers}
    _assert_fixed_error(resp, 413, "request_too_large")


def test_chunked_json_under_the_cap_is_read(client):
    def body():
        yield b'{"rows": '
        yield json.dumps(_bills()).encode()
        yield b', "history": [], "expenses": [], "categories": []}'

    resp = client.post(
        RECURRING, content=body(), headers={"content-type": "application/json"}
    )
    assert resp.status_code == 200
    assert resp.json()["candidates"][0]["merchant_key"] == "NETFLIX"


# ---- uploads stay in memory -------------------------------------------------


def _big_csv(target_bytes: int) -> bytes:
    lines = ["Date,Description,Amount,Memo"]
    size = len(lines[0]) + 1
    i = 0
    while size < target_bytes:
        line = (
            f"2026-03-{1 + i % 28:02d},SHOP NUMBER {i:06d},-{1 + i % 90}.25,"
            + "M" * 180
        )
        lines.append(line)
        size += len(line) + 1
        i += 1
    return ("\n".join(lines) + "\n").encode()


def test_two_megabyte_upload_never_spools_to_disk(client, monkeypatch):
    import tempfile

    def no_disk(self):
        raise AssertionError("upload rolled over to disk")

    monkeypatch.setattr(tempfile.SpooledTemporaryFile, "rollover", no_disk)
    content = _big_csv(2 * 1024 * 1024)
    assert len(content) > 2 * 1024 * 1024
    resp = _post(client, "big.csv", content, ctype="text/csv")
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["statements"][0]["transactions"]) > 9_000


def _asgi_post(path: str, content_type: str, chunks) -> tuple[int, dict]:
    """POST straight to the ASGI app, one receive message per chunk.

    TestClient joins a streamed body into one message; this keeps the chunks,
    as a real chunked upload arrives, with no Content-Length header.
    """
    import asyncio

    scope = {
        "type": "http",
        "asgi": {"version": "3.0"},
        "http_version": "1.1",
        "method": "POST",
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [
            (b"host", b"testserver"),
            (b"content-type", content_type.encode()),
            (b"transfer-encoding", b"chunked"),
        ],
        "client": ("127.0.0.1", 5000),
        "server": ("testserver", 80),
    }
    pending = list(chunks)
    sent: list[dict] = []

    async def receive():
        if pending:
            return {
                "type": "http.request",
                "body": pending.pop(0),
                "more_body": bool(pending),
            }
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    asyncio.run(app(scope, receive, send))
    start = next(m for m in sent if m["type"] == "http.response.start")
    body = b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
    return start["status"], json.loads(body)


def test_upload_is_closed_when_the_stream_passes_the_cap(monkeypatch):
    import tempfile

    created: list[object] = []
    closed: list[object] = []
    original_init = tempfile.SpooledTemporaryFile.__init__
    original_close = tempfile.SpooledTemporaryFile.close

    def track_init(self, *args, **kwargs):
        created.append(self)
        original_init(self, *args, **kwargs)

    def track_close(self):
        closed.append(self)
        original_close(self)

    monkeypatch.setattr(tempfile.SpooledTemporaryFile, "__init__", track_init)
    monkeypatch.setattr(tempfile.SpooledTemporaryFile, "close", track_close)
    boundary = "xBOUNDARYx"
    head = (
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="file"; filename="b.csv"\r\n'
        "Content-Type: text/csv\r\n\r\n"
    ).encode()
    chunks = [head] + [b"a" * (1024 * 1024)] * 14 + [f"\r\n--{boundary}--\r\n".encode()]
    status, body = _asgi_post(
        ANALYZE, f"multipart/form-data; boundary={boundary}", chunks
    )
    assert (status, body["error_type"]) == (413, "file_too_large")
    assert len(created) == 1 and created[0] in closed


def test_chunked_json_over_the_cap_in_many_messages_is_413():
    from src.api.v2.smart_import import MAX_JSON_BODY_BYTES

    chunk = b"a" * (1024 * 1024)
    count = MAX_JSON_BODY_BYTES // len(chunk) + 2
    status, body = _asgi_post(
        RECURRING, "application/json", [b'{"pad": "'] + [chunk] * count + [b'"}']
    )
    assert status == 413
    assert body == {
        "error_type": "request_too_large",
        "detail": "The request is larger than the limit allows.",
    }


def test_analyze_pdf_is_503_busy_when_pdf_slots_are_full(client):
    from src.smart_import.parsers import pdf_parser
    from tests.smart_import.pdf_factory import CARD_LINES

    pdf = make_pdf(CARD_LINES)
    taken = 0
    try:
        while pdf_parser._PDF_SLOTS.acquire(blocking=False):
            taken += 1
        resp = _post(client, "card.pdf", pdf, ctype="application/pdf")
        _assert_fixed_error(resp, 503, "busy")
        assert resp.json()["detail"] == (
            "Too many files are being read right now. Try again in a moment."
        )
    finally:
        for _ in range(taken):
            pdf_parser._PDF_SLOTS.release()
    assert taken == 2
    assert _post(client, "card.pdf", pdf, ctype="application/pdf").status_code == 200
