"""AI categorize and PDF extract: hosted v2 routes and server-mode routes.

Every provider here is tests/smart_import/fake_provider.py. No real key is
ever set (the env key is a placeholder that is never used because the hosted
provider factory is patched) and no network call is made.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re

import pytest
from fastapi.testclient import TestClient

import src.api.smart_import as v1
import src.api.v2.smart_import as v2
from src.api.dependencies import get_db
from src.database import Database
from src.main import app
from src.services.providers import ProviderNotConfiguredError
from src.smart_import import ai_categorize, ai_extract, settings_store
from tests.smart_import.db_guard import forbid_database
from tests.smart_import.fake_provider import FakeProvider

V2_CATEGORIZE = "/api/v2/smart-import/categorize"
V2_EXTRACT = "/api/v2/smart-import/extract"
V2_STATUS = "/api/v2/smart-import/status"
V1_CATEGORIZE = "/api/smart-import/categorize"
V1_EXTRACT = "/api/smart-import/extract"
V1_STATUS = "/api/smart-import/ai-status"

PLANTED_MERCHANT = "ZQXPLANTED WIDGETS"
PLANTED_RESPONSE_MARKER = "RESPONSEMARKER9137"
CATEGORIES = ["Food & Dining", "Entertainment", "Utilities"]
ITEMS = [
    {
        "id": "m1",
        "merchant": PLANTED_MERCHANT,
        "typical_amount": 77,
        "direction": "out",
        "count": 4,
    },
    {
        "id": "m2",
        "merchant": "NETFLIX",
        "typical_amount": 16,
        "direction": "out",
        "count": 3,
    },
]
CATEGORIZE_BODY = {"categories": CATEGORIES, "items": ITEMS}
GOOD_RESPONSE = json.dumps(
    [
        {
            "id": "m1",
            "category": "Food & Dining",
            "kind": "expense",
            "confidence": 3,
            "note": PLANTED_RESPONSE_MARKER,
        },
        {"id": "m2", "category": "Groceries", "kind": "expense", "confidence": 0.4},
        {"id": "m99", "category": "Utilities", "kind": "expense", "confidence": 0.9},
    ]
)
LINES = ["03/01 ZQXPLANTED WIDGETS 77.77", "03/03 NETFLIX.COM 15.99"]
EXTRACT_BODY = {
    "lines": LINES,
    "period_hint": {"start": "2026-03-01", "end": "2026-03-31"},
    "account_kind": "checking",
}
EXTRACT_RESPONSE = json.dumps(
    [
        {
            "line": 0,
            "date": "2026-03-01",
            "amount": -77.77,
            "description": PLANTED_MERCHANT,
        },
        {
            "line": 1,
            "date": "2026-03-03",
            "amount": -15.99,
            "description": "NETFLIX.COM",
        },
    ]
)


def _enable_hosted(monkeypatch, *, ai=True, pdf=False, key=True):
    for name in (
        "ANTHROPIC_API_KEY",
        "SMART_IMPORT_AI_ENABLED",
        "SMART_IMPORT_PDF_AI_ENABLED",
        "SMART_IMPORT_AI_FAKE",
        "DYNO",
    ):
        monkeypatch.delenv(name, raising=False)
    if key:
        monkeypatch.setenv("ANTHROPIC_API_KEY", "placeholder-not-a-key")
    if ai:
        monkeypatch.setenv("SMART_IMPORT_AI_ENABLED", "true")
    if pdf:
        monkeypatch.setenv("SMART_IMPORT_PDF_AI_ENABLED", "true")


@pytest.fixture()
def hosted(monkeypatch):
    """A v2 client whose hosted provider factory returns a recording fake."""
    fake = FakeProvider(GOOD_RESPONSE)
    monkeypatch.setattr(v2, "_hosted_provider", lambda: fake)
    forbid_database(monkeypatch)
    _enable_hosted(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)
    client.fake = fake  # type: ignore[attr-defined]
    return client


@pytest.fixture()
def db(tmp_path):
    return Database(str(tmp_path / "si-ai.db"))


@pytest.fixture()
def server(db, monkeypatch):
    """A server-mode client with a temp database and a patched get_provider."""
    fake = FakeProvider(GOOD_RESPONSE)
    seen: list[object] = []

    def fake_get_provider(provider_id=None, db=None):
        seen.append(provider_id)
        if not fake.available:
            raise ProviderNotConfiguredError("none")
        return fake

    monkeypatch.setattr(v1, "get_provider", fake_get_provider)
    monkeypatch.delenv("SMART_IMPORT_AI_FAKE", raising=False)
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, raise_server_exceptions=False)
    client.fake = fake  # type: ignore[attr-defined]
    client.seen = seen  # type: ignore[attr-defined]
    yield client
    app.dependency_overrides.pop(get_db, None)


def _consent(db, **flags):
    db.set_setting("smart_import", json.dumps({"retention_months": 24, **flags}))


def _block(text: str, tag: str):
    m = re.search(rf"<{tag}>\n(.*)\n</{tag}>", text, re.S)
    assert m
    return json.loads(m.group(1))


def _assert_fixed_error(resp, status, error_type):
    assert resp.status_code == status
    body = resp.json()
    assert set(body) == {"error_type", "detail"}
    assert body["error_type"] == error_type
    assert (
        PLANTED_MERCHANT not in resp.text and PLANTED_RESPONSE_MARKER not in resp.text
    )


# ---------------------------------------------------------------------------
# hosted v2 categorize


def test_v2_categorize_validates_and_maps(hosted):
    resp = hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY)
    assert resp.status_code == 200
    body = resp.json()
    assert body["suggestions"] == [
        {"id": "m1", "category": "Food & Dining", "kind": "expense", "confidence": 1.0},
        {"id": "m2", "category": None, "kind": "expense", "confidence": 0.4},
    ]
    assert body["provider"] == "Anthropic Claude"
    assert body["model"] == "claude-haiku-4-5-20251001"
    assert PLANTED_RESPONSE_MARKER not in resp.text


def test_v2_sent_prompt_is_exactly_the_preview_payload(hosted):
    body = dict(CATEGORIZE_BODY, provider_id="openai")
    assert hosted.post(V2_CATEGORIZE, json=body).status_code == 200
    [call] = hosted.fake.calls
    system, messages = ai_categorize.build_messages(ITEMS, CATEGORIES)
    assert call["system"] == system
    assert call["messages"] == [(m.role, m.content) for m in messages]
    assert call["temperature"] == 0 and call["max_tokens"] == 4000
    preview = ai_categorize.categorize_payload(ITEMS, CATEGORIES)
    # The preview function's output is the request minus provider_id ...
    assert preview == CATEGORIZE_BODY
    # ... and is exactly the data the provider receives.
    text = call["messages"][0][1]
    assert {
        "categories": _block(text, "categories"),
        "items": _block(text, "items"),
    } == preview
    # Hosted always uses the env-key Claude provider; provider_id is ignored.
    assert "openai" not in text


def test_v2_prompt_carries_only_allowed_fields(hosted):
    assert hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY).status_code == 200
    text = hosted.fake.calls[0]["messages"][0][1] + hosted.fake.calls[0]["system"]
    for item in ITEMS:
        assert json.dumps(item["merchant"]) in text
        assert f'"typical_amount":{item["typical_amount"]}' in text
    for forbidden in (
        "date",
        "description",
        "file_name",
        "posted",
        "balance",
        "account",
    ):
        assert f'"{forbidden}' not in text


@pytest.mark.parametrize(
    "extra",
    [
        {"description": "ZELLE TO SOMEONE"},
        {"date": "2026-03-01"},
        {"file_name": "statement.csv"},
    ],
)
def test_v2_item_extra_fields_are_rejected(hosted, extra):
    items = [dict(ITEMS[0], **extra)]
    resp = hosted.post(V2_CATEGORIZE, json={"categories": CATEGORIES, "items": items})
    _assert_fixed_error(resp, 422, "bad_request")
    assert hosted.fake.calls == []


@pytest.mark.parametrize(
    "body",
    [
        {
            "categories": CATEGORIES,
            "items": [dict(ITEMS[1], id=f"m{i}") for i in range(61)],
        },
        {"categories": [f"C{i}" for i in range(61)], "items": ITEMS},
        {"categories": CATEGORIES, "items": [dict(ITEMS[0], merchant="X" * 49)]},
        {"categories": CATEGORIES, "items": [dict(ITEMS[0], typical_amount=5.5)]},
        {"categories": CATEGORIES, "items": [dict(ITEMS[0], direction="sideways")]},
        {"categories": CATEGORIES, "items": [ITEMS[0], ITEMS[0]]},
        {"categories": CATEGORIES, "items": [dict(ITEMS[0], id="bad id!")]},
        {"items": ITEMS},
    ],
)
def test_v2_categorize_bounds(hosted, body):
    resp = hosted.post(V2_CATEGORIZE, json=body)
    _assert_fixed_error(resp, 422, "bad_request")
    assert hosted.fake.calls == []


@pytest.mark.parametrize(
    "env",
    [dict(key=False), dict(ai=False), dict(key=False, ai=False)],
)
def test_v2_categorize_gated(hosted, monkeypatch, env):
    _enable_hosted(monkeypatch, **env)
    _assert_fixed_error(
        hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY), 503, "ai_unavailable"
    )
    assert hosted.fake.calls == []


def test_v2_categorize_garbage_is_502(hosted):
    hosted.fake.text = "I cannot do that " + PLANTED_RESPONSE_MARKER
    _assert_fixed_error(
        hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY), 502, "ai_bad_response"
    )


def test_v2_categorize_provider_error_is_502(hosted):
    from src.services.providers.base import InferenceProviderError

    hosted.fake.raises = InferenceProviderError("Claude API error: " + PLANTED_MERCHANT)
    _assert_fixed_error(
        hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY), 502, "ai_provider_error"
    )


def test_v2_categorize_timeout_is_504(hosted, monkeypatch):
    import src.smart_import.ai_common as ai_common

    monkeypatch.setattr(ai_common, "AI_CALL_TIMEOUT_SECONDS", 0.05)
    hosted.fake.delay = 0.5
    _assert_fixed_error(
        hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY), 504, "ai_timeout"
    )


def test_time_budget_fits_under_heroku_limit():
    import src.smart_import.ai_common as ai_common

    assert ai_common.AI_CALL_TIMEOUT_SECONDS + 2 < 30
    assert ai_common.CLIENT_TIMEOUT_SECONDS < ai_common.AI_CALL_TIMEOUT_SECONDS


def test_hosted_provider_is_env_key_claude_with_bounded_client(monkeypatch):
    from src.services.providers.claude_provider import ClaudeProvider

    forbid_database(monkeypatch)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "placeholder-not-a-key")
    monkeypatch.delenv("SMART_IMPORT_AI_FAKE", raising=False)
    provider = v2._hosted_provider()
    assert isinstance(provider, ClaudeProvider)
    assert provider.get_api_key() == "placeholder-not-a-key"
    assert provider._db is None
    assert provider._timeout == v2.ai_common.CLIENT_TIMEOUT_SECONDS
    assert provider._max_retries == 0


def test_claude_provider_client_gets_timeout(monkeypatch):
    import sys
    import types

    from src.services.providers.claude_provider import ClaudeProvider

    captured: dict = {}

    class FakeAnthropic:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setitem(
        sys.modules, "anthropic", types.SimpleNamespace(Anthropic=FakeAnthropic)
    )
    ClaudeProvider(api_key="placeholder", timeout=7.0, max_retries=0)._get_client()
    assert captured == {"api_key": "placeholder", "timeout": 7.0, "max_retries": 0}
    captured.clear()
    ClaudeProvider(api_key="placeholder")._get_client()
    assert captured == {"api_key": "placeholder"}


def test_v2_categorize_logs_nothing_sensitive(hosted, caplog):
    caplog.set_level(logging.DEBUG)
    hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY)
    hosted.fake.text = "garbage " + PLANTED_RESPONSE_MARKER
    hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY)
    from src.services.providers.base import InferenceProviderError

    hosted.fake.raises = InferenceProviderError("Claude API error: " + PLANTED_MERCHANT)
    hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY)
    for record in caplog.records:
        msg = record.getMessage()
        assert PLANTED_MERCHANT not in msg
        assert PLANTED_RESPONSE_MARKER not in msg
        assert "Food & Dining" not in msg


# ---------------------------------------------------------------------------
# hosted v2 extract


def test_v2_extract_needs_pdf_flag(hosted, monkeypatch):
    hosted.fake.text = EXTRACT_RESPONSE
    _assert_fixed_error(
        hosted.post(V2_EXTRACT, json=EXTRACT_BODY), 503, "ai_unavailable"
    )
    _enable_hosted(monkeypatch, ai=True, pdf=True, key=False)
    _assert_fixed_error(
        hosted.post(V2_EXTRACT, json=EXTRACT_BODY), 503, "ai_unavailable"
    )
    assert hosted.fake.calls == []


def test_v2_extract_returns_an_analyze_response(hosted, monkeypatch):
    _enable_hosted(monkeypatch, ai=True, pdf=True)
    hosted.fake.text = EXTRACT_RESPONSE
    body = dict(
        EXTRACT_BODY,
        categories=[{"id": "c-ent", "name": "Entertainment"}],
        rules=[{"merchant_key": "ZQXPLANTED WIDGETS", "category_id": "c-ent"}],
    )
    resp = hosted.post(V2_EXTRACT, json=body)
    assert resp.status_code == 200
    out = resp.json()
    assert out["status"] == "ok"
    [stmt] = out["statements"]
    assert stmt["parser"] == "pdf:ai"
    assert [t["amount"] for t in stmt["transactions"]] == [-77.77, -15.99]
    assert stmt["transactions"][0]["category_id"] == "c-ent"
    # The prompt is exactly the extract payload; categories and rules never leave.
    [call] = hosted.fake.calls
    system, messages = ai_extract.build_messages(
        LINES, EXTRACT_BODY["period_hint"], "checking"
    )
    assert call["system"] == system
    assert call["messages"] == [(m.role, m.content) for m in messages]
    text = call["messages"][0][1]
    assert _block(text, "statement") == ai_extract.extract_payload(
        LINES, EXTRACT_BODY["period_hint"], "checking"
    )
    assert "c-ent" not in text and "rules" not in text


@pytest.mark.parametrize(
    "body",
    [
        {"lines": ["x"] * 401},
        {"lines": ["x" * 301]},
        {"lines": []},
        {"lines": ["x"], "account_kind": "brokerage"},
        {"lines": ["x"], "period_hint": {"start": "not a date"}},
        {"lines": ["x"], "surprise": 1},
    ],
)
def test_v2_extract_bounds(hosted, monkeypatch, body):
    _enable_hosted(monkeypatch, ai=True, pdf=True)
    _assert_fixed_error(hosted.post(V2_EXTRACT, json=body), 422, "bad_request")


def test_v2_extract_garbage_is_502(hosted, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    _enable_hosted(monkeypatch, ai=True, pdf=True)
    hosted.fake.text = '{"oops": "' + PLANTED_RESPONSE_MARKER + '"}'
    _assert_fixed_error(
        hosted.post(V2_EXTRACT, json=EXTRACT_BODY), 502, "ai_bad_response"
    )
    for record in caplog.records:
        assert PLANTED_RESPONSE_MARKER not in record.getMessage()
        assert "ZQXPLANTED" not in record.getMessage()


def test_v2_ai_routes_never_open_a_database(hosted, monkeypatch):
    _enable_hosted(monkeypatch, ai=True, pdf=True)
    assert hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY).status_code == 200
    hosted.fake.text = EXTRACT_RESPONSE
    assert hosted.post(V2_EXTRACT, json=EXTRACT_BODY).status_code == 200
    assert hosted.get(V2_STATUS).status_code == 200


def test_v2_status_reports_consent_fields(hosted, monkeypatch):
    body = hosted.get(V2_STATUS).json()
    assert body["ai_available"] is True and body["ai_enabled"] is True
    assert body["pdf_ai_available"] is False and body["pdf_ai_enabled"] is False
    _enable_hosted(monkeypatch, ai=False)
    body = hosted.get(V2_STATUS).json()
    assert body["ai_available"] is False and body["provider"] is None


# ---------------------------------------------------------------------------
# server mode


def test_v1_without_consent_is_403(server, db):
    _assert_fixed_error(
        server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY), 403, "ai_not_enabled"
    )
    _consent(db, ai_enabled=False)
    _assert_fixed_error(
        server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY), 403, "ai_not_enabled"
    )
    assert server.fake.calls == []


def test_v1_with_consent_and_provider_is_200(server, db):
    _consent(db, ai_enabled=True)
    resp = server.post(
        V1_CATEGORIZE, json=dict(CATEGORIZE_BODY, provider_id="cerebras")
    )
    assert resp.status_code == 200
    assert resp.json()["suggestions"][0] == {
        "id": "m1",
        "category": "Food & Dining",
        "kind": "expense",
        "confidence": 1.0,
    }
    assert server.seen == ["cerebras"]
    [call] = server.fake.calls
    system, messages = ai_categorize.build_messages(ITEMS, CATEGORIES)
    assert call["system"] == system
    assert call["messages"] == [(m.role, m.content) for m in messages]


def test_v1_non_claude_provider_uses_its_default_model(server, db):
    _consent(db, ai_enabled=True)
    server.fake._info.id = "openai"
    server.fake._info.display_name = "OpenAI"
    resp = server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY)
    assert resp.status_code == 200
    assert server.fake.calls[0]["model"] is None
    assert resp.json()["provider"] == "OpenAI"
    assert resp.json()["model"] == "fake-default"


def test_v1_without_provider_is_503(server, db):
    _consent(db, ai_enabled=True, pdf_ai_enabled=True)
    server.fake.available = False
    _assert_fixed_error(
        server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY), 503, "ai_unavailable"
    )
    _assert_fixed_error(
        server.post(V1_EXTRACT, json=EXTRACT_BODY), 503, "ai_unavailable"
    )


def test_v1_extract_needs_pdf_consent(server, db):
    _consent(db, ai_enabled=True)
    server.fake.text = EXTRACT_RESPONSE
    _assert_fixed_error(
        server.post(V1_EXTRACT, json=EXTRACT_BODY), 403, "ai_not_enabled"
    )
    _consent(db, ai_enabled=True, pdf_ai_enabled=True)
    resp = server.post(V1_EXTRACT, json=dict(EXTRACT_BODY, provider_id="gemini"))
    assert resp.status_code == 200
    assert resp.json()["statements"][0]["parser"] == "pdf:ai"
    assert server.seen[-1] == "gemini"


def test_v1_bad_settings_row_means_no_consent(server, db):
    db.set_setting("smart_import", "{not json")
    _assert_fixed_error(
        server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY), 403, "ai_not_enabled"
    )


def test_v1_ai_status(server, db):
    body = server.get(V1_STATUS).json()
    assert body["ai_available"] is True
    assert body["ai_enabled"] is False and body["pdf_ai_enabled"] is False
    assert body["provider"] == "Anthropic Claude"
    assert body["model"] == "claude-haiku-4-5-20251001"
    assert set(body["limits"]) >= {"max_file_bytes", "max_files_per_batch"}
    _consent(db, ai_enabled=True, pdf_ai_enabled=True)
    body = server.get(V1_STATUS, params={"provider_id": "gemini"}).json()
    assert body["ai_enabled"] is True and body["pdf_ai_enabled"] is True
    assert server.seen[-1] == "gemini"
    server.fake.available = False
    body = server.get(V1_STATUS).json()
    assert body["ai_available"] is False and body["pdf_ai_available"] is False
    assert body["provider"] is None and body["model"] is None


def test_v1_logs_nothing_sensitive(server, db, caplog):
    caplog.set_level(logging.DEBUG)
    _consent(db, ai_enabled=True, pdf_ai_enabled=True)
    server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY)
    server.fake.text = "nope " + PLANTED_RESPONSE_MARKER
    server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY)
    server.post(V1_EXTRACT, json=EXTRACT_BODY)
    for record in caplog.records:
        msg = record.getMessage()
        assert PLANTED_MERCHANT not in msg and "ZQXPLANTED" not in msg
        assert PLANTED_RESPONSE_MARKER not in msg


def test_v1_routes_are_rate_limited_patterns():
    from src.middleware.rate_limit import AI_ENDPOINT_PATTERNS

    pats = [re.compile(p) for p in AI_ENDPOINT_PATTERNS]
    for path in (V1_CATEGORIZE, V1_EXTRACT, V2_CATEGORIZE, V2_EXTRACT):
        assert any(p.match(path) for p in pats)
    assert not any(p.match(V1_STATUS) for p in pats)


# ---------------------------------------------------------------------------
# settings store and local fake mode


def test_settings_store_defaults(db):
    assert settings_store.read_settings(db) == settings_store.DEFAULTS
    _consent(db, ai_enabled=True, pdf_ai_enabled="yes")
    s = settings_store.read_settings(db)
    assert s["ai_enabled"] is True
    assert s["pdf_ai_enabled"] is False  # only a real boolean counts


def test_local_fake_mode_needs_no_key(monkeypatch):
    """SMART_IMPORT_AI_FAKE lets local check servers exercise AI paths offline."""
    _enable_hosted(monkeypatch, ai=True, pdf=True, key=False)
    monkeypatch.setenv("SMART_IMPORT_AI_FAKE", "true")
    forbid_database(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)
    status = client.get(V2_STATUS).json()
    assert status["ai_available"] is True and status["provider"] == "Offline fake"
    resp = client.post(V2_CATEGORIZE, json=CATEGORIZE_BODY)
    assert resp.status_code == 200
    assert [s["id"] for s in resp.json()["suggestions"]] == ["m1", "m2"]
    assert all(s["category"] in CATEGORIES for s in resp.json()["suggestions"])
    resp = client.post(V2_EXTRACT, json=EXTRACT_BODY)
    assert resp.status_code == 200
    assert resp.json()["statements"][0]["transactions"] == []


def test_local_fake_mode_flag_still_needs_operator_opt_in(monkeypatch):
    _enable_hosted(monkeypatch, ai=False, key=False)
    monkeypatch.setenv("SMART_IMPORT_AI_FAKE", "true")
    client = TestClient(app, raise_server_exceptions=False)
    assert client.post(V2_CATEGORIZE, json=CATEGORIZE_BODY).status_code == 503


def test_run_with_budget_runs_off_the_event_loop():
    import src.smart_import.ai_common as ai_common

    assert asyncio.run(ai_common.run_with_budget(lambda x: x + 1, 1)) == 2


def test_fake_is_never_served_on_heroku(monkeypatch, db, caplog):
    """With DYNO set the fake flag is ignored and AI is unavailable, even with a key."""
    import src.smart_import.fake_ai as fake_ai

    monkeypatch.setattr(fake_ai, "_ignored_logged", False)
    _enable_hosted(monkeypatch, ai=True, pdf=True, key=True)
    monkeypatch.setenv("SMART_IMPORT_AI_FAKE", "true")
    monkeypatch.setenv("DYNO", "web.1")
    called: list[object] = []
    monkeypatch.setattr(v2, "_hosted_provider", lambda: called.append(1))
    monkeypatch.setattr(v1, "get_provider", lambda *a, **k: called.append(1))
    caplog.set_level(logging.DEBUG)
    client = TestClient(app, raise_server_exceptions=False)

    status = client.get(V2_STATUS).json()
    assert status["ai_available"] is False and status["provider"] is None
    _assert_fixed_error(
        client.post(V2_CATEGORIZE, json=CATEGORIZE_BODY), 503, "ai_unavailable"
    )
    _assert_fixed_error(
        client.post(V2_EXTRACT, json=EXTRACT_BODY), 503, "ai_unavailable"
    )

    _consent(db, ai_enabled=True, pdf_ai_enabled=True)
    app.dependency_overrides[get_db] = lambda: db
    try:
        _assert_fixed_error(
            client.post(V1_CATEGORIZE, json=CATEGORIZE_BODY), 503, "ai_unavailable"
        )
        assert client.get(V1_STATUS).json()["ai_available"] is False
    finally:
        app.dependency_overrides.pop(get_db, None)

    assert called == []
    events = [
        r.getMessage()
        for r in caplog.records
        if "smart_import_fake_ignored" in r.getMessage()
    ]
    assert events == ["smart_import_fake_ignored"]


def test_fake_still_works_off_heroku(monkeypatch):
    _enable_hosted(monkeypatch, ai=True, key=False)
    monkeypatch.setenv("SMART_IMPORT_AI_FAKE", "true")
    monkeypatch.delenv("DYNO", raising=False)
    client = TestClient(app, raise_server_exceptions=False)
    assert client.post(V2_CATEGORIZE, json=CATEGORIZE_BODY).status_code == 200


# ---------------------------------------------------------------------------
# hosted deployments: the operator's key is never reached without the
# operator's flags and an active rate limiter

RATE_ENV = {"RATE_LIMIT_ENABLED": "true", "RATE_LIMIT_SECRET_KEY": "k" * 40}


@pytest.fixture()
def limiter(monkeypatch):
    """Turn the in-process rate limiter on or off; always reset afterwards."""
    from src.services.rate_limiter import reset_rate_limiter

    def set_active(active: bool) -> None:
        for name, value in RATE_ENV.items():
            if active:
                monkeypatch.setenv(name, value)
            else:
                monkeypatch.delenv(name, raising=False)
        reset_rate_limiter()

    set_active(False)
    yield set_active
    for name in RATE_ENV:
        monkeypatch.delenv(name, raising=False)
    reset_rate_limiter()


def test_hosted_ai_needs_an_active_rate_limiter_on_heroku(hosted, monkeypatch, limiter):
    _enable_hosted(monkeypatch, ai=True, pdf=True)
    assert v2.ai_available() and v2.pdf_ai_available()  # off Heroku
    monkeypatch.setenv("DYNO", "web.1")
    assert not v2.ai_available() and not v2.pdf_ai_available()
    status = hosted.get(V2_STATUS).json()
    assert status["ai_available"] is False and status["pdf_ai_available"] is False
    _assert_fixed_error(
        hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY), 503, "ai_unavailable"
    )
    assert hosted.fake.calls == []
    limiter(True)
    assert v2.ai_available() and v2.pdf_ai_available()
    assert hosted.post(V2_CATEGORIZE, json=CATEGORIZE_BODY).status_code == 200


@pytest.mark.parametrize("env", [{"DYNO": "web.1"}, {"MULTI_USER_MODE": "true"}])
def test_v1_on_a_shared_deployment_needs_the_operator_gate(
    server, db, monkeypatch, limiter, env
):
    """Consent alone must not reach the operator's env key on Heroku."""
    _enable_hosted(monkeypatch, ai=False, pdf=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    _consent(db, ai_enabled=True, pdf_ai_enabled=True)
    _assert_fixed_error(
        server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY), 503, "ai_unavailable"
    )
    _assert_fixed_error(
        server.post(V1_EXTRACT, json=EXTRACT_BODY), 503, "ai_unavailable"
    )
    assert server.seen == [] and server.fake.calls == []
    status = server.get(V1_STATUS).json()
    assert status["ai_available"] is False and status["pdf_ai_available"] is False

    # The operator's AI flag opens categorize but not extract.
    _enable_hosted(monkeypatch, ai=True, pdf=False)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    limiter(True)
    assert server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY).status_code == 200
    _assert_fixed_error(
        server.post(V1_EXTRACT, json=EXTRACT_BODY), 503, "ai_unavailable"
    )
    status = server.get(V1_STATUS).json()
    assert status["ai_available"] is True and status["pdf_ai_available"] is False

    _enable_hosted(monkeypatch, ai=True, pdf=True)
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    server.fake.text = EXTRACT_RESPONSE
    assert server.post(V1_EXTRACT, json=EXTRACT_BODY).status_code == 200
    assert server.get(V1_STATUS).json()["pdf_ai_available"] is True


def test_v1_consent_is_still_checked_first_on_a_shared_deployment(
    server, db, monkeypatch, limiter
):
    _enable_hosted(monkeypatch, ai=False)
    monkeypatch.setenv("DYNO", "web.1")
    _assert_fixed_error(
        server.post(V1_CATEGORIZE, json=CATEGORIZE_BODY), 403, "ai_not_enabled"
    )


def test_v1_status_pdf_follows_the_extract_gate_off_heroku(server, db, monkeypatch):
    """Single-user server mode has no operator flags: both follow the provider."""
    _enable_hosted(monkeypatch, ai=False, pdf=False, key=False)
    body = server.get(V1_STATUS).json()
    assert body["ai_available"] is True and body["pdf_ai_available"] is True
    server.fake.available = False
    body = server.get(V1_STATUS).json()
    assert body["ai_available"] is False and body["pdf_ai_available"] is False


# ---------------------------------------------------------------------------
# server-mode providers get a bounded client


@pytest.mark.parametrize("provider_cls_name", ["claude", "openai", "gemini", "cerebras"])
def test_v1_builtin_providers_are_rebuilt_with_a_client_timeout(
    db, monkeypatch, provider_cls_name
):
    from src.services.providers.cerebras_provider import CerebrasProvider
    from src.services.providers.claude_provider import ClaudeProvider
    from src.services.providers.gemini_provider import GeminiProvider
    from src.services.providers.openai_provider import OpenAIProvider
    from src.smart_import import ai_common

    cls = {
        "claude": ClaudeProvider,
        "openai": OpenAIProvider,
        "gemini": GeminiProvider,
        "cerebras": CerebrasProvider,
    }[provider_cls_name]
    shared = cls(None)
    monkeypatch.setattr(v1, "get_provider", lambda provider_id=None, db=None: shared)
    monkeypatch.setattr(cls, "is_available", lambda self: True)
    monkeypatch.delenv("SMART_IMPORT_AI_FAKE", raising=False)
    got = v1._resolve_provider(None, db)
    assert type(got) is cls and got is not shared
    assert got._db is db
    assert got._timeout == ai_common.CLIENT_TIMEOUT_SECONDS
    assert got._max_retries == 0
    # The registry's shared instance (used by commentary and the advisor) is untouched.
    assert shared._timeout is None


def test_v1_plugin_providers_are_used_as_they_are(db, monkeypatch):
    fake = FakeProvider()
    monkeypatch.setattr(v1, "get_provider", lambda provider_id=None, db=None: fake)
    monkeypatch.delenv("SMART_IMPORT_AI_FAKE", raising=False)
    assert v1._resolve_provider(None, db) is fake


@pytest.mark.parametrize("name", ["openai", "gemini", "cerebras"])
def test_openai_compatible_clients_get_timeout(monkeypatch, name):
    import sys
    import types

    from src.services.providers.cerebras_provider import CerebrasProvider
    from src.services.providers.gemini_provider import GeminiProvider
    from src.services.providers.openai_provider import OpenAIProvider

    cls = {"openai": OpenAIProvider, "gemini": GeminiProvider, "cerebras": CerebrasProvider}[name]
    captured: dict = {}

    class FakeOpenAI:
        def __init__(self, **kwargs):
            captured.update(kwargs)

    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=FakeOpenAI))
    monkeypatch.setattr(cls, "get_api_key", lambda self: "placeholder")
    cls(timeout=7.0, max_retries=0)._get_client()
    assert captured["timeout"] == 7.0 and captured["max_retries"] == 0
    captured.clear()
    cls()._get_client()
    assert "timeout" not in captured and "max_retries" not in captured


# ---------------------------------------------------------------------------
# large statements: batched extract with a partial result


def _extract_lines(count: int) -> list[str]:
    return [f"03/{1 + i % 28:02d} SHOP NUMBER {i} {i + 1}.25" for i in range(count)]


def _batch_answer(start: int, stop: int) -> str:
    return json.dumps(
        [
            [n, f"2026-03-{1 + n % 28:02d}", -(n + 1.25), f"SHOP NUMBER {n}"]
            for n in range(start, stop)
        ]
    )


def test_v2_extract_reads_400_lines_in_batches(hosted, monkeypatch):
    _enable_hosted(monkeypatch, ai=True, pdf=True)
    hosted.fake.texts = [_batch_answer(k, k + 80) for k in range(0, 400, 80)]
    body = dict(EXTRACT_BODY, lines=_extract_lines(400))
    resp = hosted.post(V2_EXTRACT, json=body)
    assert resp.status_code == 200
    [stmt] = resp.json()["statements"]
    assert len(stmt["transactions"]) == 400
    assert stmt["warnings"] == ["ai_extracted"]
    assert len(hosted.fake.calls) == 5


def test_v2_extract_returns_rows_so_far_when_the_budget_runs_out(hosted, monkeypatch):
    _enable_hosted(monkeypatch, ai=True, pdf=True)
    monkeypatch.setattr(ai_extract, "EXTRACT_BUDGET_SECONDS", 0.3)
    hosted.fake.texts = [_batch_answer(k, k + 80) for k in range(0, 400, 80)]
    hosted.fake.delay = 0.2
    resp = hosted.post(V2_EXTRACT, json=dict(EXTRACT_BODY, lines=_extract_lines(400)))
    assert resp.status_code == 200
    [stmt] = resp.json()["statements"]
    assert stmt["warnings"] == ["ai_extracted", "ai_partial"]
    assert len(stmt["transactions"]) == 80
    assert len(hosted.fake.calls) == 1


def test_v2_extract_request_budget_backstop_keeps_finished_batches(hosted, monkeypatch):
    """If a batch overruns the request budget, the finished batches still return."""
    import src.smart_import.ai_common as ai_common

    _enable_hosted(monkeypatch, ai=True, pdf=True)
    monkeypatch.setattr(ai_common, "AI_CALL_TIMEOUT_SECONDS", 0.5)
    hosted.fake.texts = [_batch_answer(k, k + 80) for k in range(0, 400, 80)]
    hosted.fake.delay = 0.3
    resp = hosted.post(V2_EXTRACT, json=dict(EXTRACT_BODY, lines=_extract_lines(400)))
    assert resp.status_code == 200
    [stmt] = resp.json()["statements"]
    assert stmt["warnings"] == ["ai_extracted", "ai_partial"]
    assert len(stmt["transactions"]) == 80


def test_v2_extract_timeout_before_any_batch_is_504(hosted, monkeypatch):
    import src.smart_import.ai_common as ai_common

    _enable_hosted(monkeypatch, ai=True, pdf=True)
    monkeypatch.setattr(ai_common, "AI_CALL_TIMEOUT_SECONDS", 0.1)
    hosted.fake.text = EXTRACT_RESPONSE
    hosted.fake.delay = 0.3
    _assert_fixed_error(hosted.post(V2_EXTRACT, json=EXTRACT_BODY), 504, "ai_timeout")
