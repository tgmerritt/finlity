"""Smart import data layer, read side and settings (server path).

Every test runs against a fresh temp Database injected through the get_db
override; the tracked demo database is never touched.
"""

import json
import logging
from datetime import date, datetime, timedelta

import pytest
from fastapi.testclient import TestClient

from src.api.dependencies import get_db
from src.database import Database
from src.database.models import (
    AppSettings,
    BankStatementImport,
    BudgetExpenseCategory,
    ImportTransaction,
    Liability,
    MerchantRule,
    SmartImportMeta,
)
from src.main import app

TODAY = date(2026, 10, 4)
HASH_A = "a" * 64
HASH_B = "b" * 64
LAYOUT_SIG = "c" * 64


@pytest.fixture()
def db(tmp_path):
    database = Database(str(tmp_path / "si.db"))
    with database.get_session() as s:
        for i, name in enumerate(["Groceries", "Dining", "Debt Payments"]):
            s.add(BudgetExpenseCategory(id=f"cat-{name}", name=name, sort_order=i))
        s.commit()
    return database


@pytest.fixture()
def client(db, monkeypatch):
    monkeypatch.setattr("src.liabilities.clock.today", lambda: TODAY)
    monkeypatch.setenv("PORTFOLIO_TEST_MODE", "true")
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_db, None)


def add_import(db, import_id, *, content_hash, key, kind="checking", label="Main",
               last4="1234", institution="Sample Bank", liability_id=None,
               created=None, origin="file", batch="batch-1", uploaded=None):
    with db.get_session() as s:
        s.add(BankStatementImport(
            id=import_id, file_name=f"{import_id}.csv", content_hash=content_hash,
            status="applied", row_count=1, analyzed_at=uploaded or datetime(2026, 9, 1, 12, 0),
        ))
        s.add(SmartImportMeta(
            import_id=import_id, batch_id=batch, origin=origin, format="csv", parser="csv",
            account_kind=kind, account_key=key, account_label=label, account_last4=last4,
            institution=institution, liability_id=liability_id,
            created_at=created or datetime(2026, 9, 1, 12, 0),
        ))
        s.commit()


def add_txn(db, import_id, key, *, dedupe, merchant="NETFLIX", amount=-15.0,
            posted=date(2026, 9, 1)):
    with db.get_session() as s:
        s.add(ImportTransaction(
            import_id=import_id, account_key=key, posted_date=posted, amount=amount,
            description=merchant, merchant_key=merchant, kind="expense",
            category_source="rule", dedupe_key=dedupe,
        ))
        s.commit()


def add_liability(db, lid, name, *, lender=None, ltype="credit_card", active=True):
    with db.get_session() as s:
        s.add(Liability(
            id=lid, name=name, liability_type=ltype, lender=lender, current_balance=100.0,
            balance_as_of=TODAY, is_amortizing=False, is_active=active,
        ))
        s.commit()


def add_rule(db, key, category_id=None, kind=None, rid=None, hits=1):
    with db.get_session() as s:
        s.add(MerchantRule(id=rid or f"rule-{key}", merchant_key=key, category_id=category_id,
                           kind=kind, hits=hits, source="user"))
        s.commit()


def counts(db):
    with db.get_session() as s:
        return {
            "meta": s.query(SmartImportMeta).count(),
            "txns": s.query(ImportTransaction).count(),
            "rules": s.query(MerchantRule).count(),
            "settings": s.query(AppSettings).count(),
        }


def stmt(**over):
    base = {
        "file_hash": HASH_A, "account_key": "acct:one", "account_kind": "checking",
        "institution": None, "dedupe_keys": [], "merchant_keys": [],
    }
    base.update(over)
    return base


def preview(client, *statements):
    return client.post("/api/smart-import/preview", json={"statements": list(statements)})


# ------------------------------------------------------------------ context


def test_context_empty(client):
    body = client.get("/api/smart-import/context").json()
    assert body["rules"] == []
    assert body["accounts"] == []
    assert body["csv_layouts"] == {}
    assert body["settings"] == {
        "retention_months": 24, "ai_enabled": False, "pdf_ai_enabled": False,
        "csv_layouts": {}, "accounts": {},
    }
    assert body["categories"] == [
        {"id": "cat-Groceries", "name": "Groceries"},
        {"id": "cat-Dining", "name": "Dining"},
        {"id": "cat-Debt Payments", "name": "Debt Payments"},
    ]


def test_context_rules_ignore_deleted_categories(client, db):
    add_rule(db, "NETFLIX", "cat-Dining", "expense")
    add_rule(db, "PAYROLL", None, "income")
    add_rule(db, "GONE", "cat-deleted", "expense")
    rules = client.get("/api/smart-import/context").json()["rules"]
    assert sorted(r["merchant_key"] for r in rules) == ["NETFLIX", "PAYROLL"]
    netflix = next(r for r in rules if r["merchant_key"] == "NETFLIX")
    assert netflix == {"id": "rule-NETFLIX", "merchant_key": "NETFLIX",
                       "category_id": "cat-Dining", "kind": "expense"}


def test_context_accounts_use_newest_meta_per_account_key_sorted_by_label(client, db):
    add_import(db, "i1", content_hash="h1", key="acct:one", label="Old name", last4="1111",
               created=datetime(2026, 8, 1))
    add_import(db, "i2", content_hash="h2", key="acct:one", label="Everyday", last4="1234",
               liability_id="L1", created=datetime(2026, 9, 1))
    add_import(db, "i3", content_hash="h3", key="label:cash", label="Cash", last4=None,
               kind="savings", institution=None, created=datetime(2026, 7, 1))
    accounts = client.get("/api/smart-import/context").json()["accounts"]
    assert accounts == [
        {"account_key": "label:cash", "label": "Cash", "last4": None, "kind": "savings",
         "institution": None, "liability_id": None},
        {"account_key": "acct:one", "label": "Everyday", "last4": "1234", "kind": "checking",
         "institution": "Sample Bank", "liability_id": "L1"},
    ]


def test_context_account_label_setting_overrides(client, db):
    add_import(db, "i1", content_hash="h1", key="acct:one", label="Everyday")
    client.put("/api/smart-import/settings", json={"accounts": {"acct:one": "Joint checking"}})
    accounts = client.get("/api/smart-import/context").json()["accounts"]
    assert accounts[0]["label"] == "Joint checking"


def test_context_returns_remembered_csv_layouts(client):
    layout = {LAYOUT_SIG: {"date": "Posted", "description": "Memo", "amount": "Amt"}}
    assert client.put("/api/smart-import/settings", json={"csv_layouts": layout}).status_code == 200
    assert client.get("/api/smart-import/context").json()["csv_layouts"] == layout


# ------------------------------------------------------------------ preview


def test_preview_existing_dedupe_keys(client, db):
    add_import(db, "i1", content_hash=HASH_B, key="acct:one")
    add_txn(db, "i1", "acct:one", dedupe="acct:one|k1")
    add_txn(db, "i1", "acct:one", dedupe="acct:one|k2")
    body = preview(client, stmt(dedupe_keys=["acct:one|k1", "acct:one|new", "acct:one|k2"])).json()
    assert body["existing_dedupe_keys"] == ["acct:one|k1", "acct:one|k2"]


def test_preview_existing_keys_across_chunks(client, db):
    add_import(db, "i1", content_hash=HASH_B, key="acct:one")
    with db.get_session() as s:
        for n in range(1200):
            s.add(ImportTransaction(
                import_id="i1", account_key="acct:one", posted_date=date(2026, 9, 1),
                amount=-1.0, description="X", merchant_key="X", kind="expense",
                category_source="none", dedupe_key=f"acct:one|{n}"))
        s.commit()
    keys = [f"acct:one|{n}" for n in range(0, 1500)]
    body = preview(client, stmt(dedupe_keys=keys)).json()
    assert len(body["existing_dedupe_keys"]) == 1200


def test_preview_prior_files(client, db):
    add_import(db, "i1", content_hash=HASH_A, key="acct:one", uploaded=datetime(2026, 9, 3, 8, 30))
    add_import(db, "i2", content_hash=HASH_B + ":1", key="acct:two", uploaded=datetime(2026, 9, 4))
    body = preview(client, stmt(file_hash=HASH_A), stmt(file_hash=HASH_B), stmt(file_hash="c" * 64)).json()
    assert body["prior_files"] == [
        {"file_hash": HASH_A, "import_id": "i1", "imported_at": "2026-09-03T08:30:00"},
        {"file_hash": HASH_B, "import_id": "i2", "imported_at": "2026-09-04T00:00:00"},
    ]


def test_preview_prior_file_listed_once_for_a_shared_hash(client, db):
    add_import(db, "i1", content_hash=HASH_A, key="acct:one")
    body = preview(client, stmt(file_hash=HASH_A), stmt(file_hash=HASH_A, account_key="acct:two")).json()
    assert [p["file_hash"] for p in body["prior_files"]] == [HASH_A]


def test_preview_liability_prefers_previous_import(client, db):
    add_liability(db, "L-prev", "Visa", lender="Other Bank")
    add_liability(db, "L-lender", "Sample Card", lender="Sample Bank")
    add_import(db, "i1", content_hash="h1", key="acct:card", kind="credit_card",
               liability_id="L-prev", created=datetime(2026, 8, 1))
    body = preview(client, stmt(account_key="acct:card", account_kind="credit_card",
                                institution="Sample Bank")).json()
    assert body["liability_suggestions"] == [
        {"file_hash": HASH_A, "account_key": "acct:card", "liability_id": "L-prev",
         "reason": "previous_import"}]


def test_preview_liability_lender_match(client, db):
    add_liability(db, "L1", "Rewards Card", lender="sample bank")
    body = preview(client, stmt(account_key="acct:card", account_kind="credit_card",
                                institution="Sample Bank")).json()
    assert body["liability_suggestions"] == [
        {"file_hash": HASH_A, "account_key": "acct:card", "liability_id": "L1",
         "reason": "lender_match"}]


def test_preview_liability_name_match_and_type_compat(client, db):
    add_liability(db, "L-mort", "Sample Bank Mortgage", ltype="mortgage", lender="Sample Bank")
    add_liability(db, "L-card", "Sample Bank Card", ltype="credit_card")
    card = preview(client, stmt(account_kind="credit_card", institution="Sample Bank")).json()
    assert card["liability_suggestions"][0]["liability_id"] == "L-card"
    loan = preview(client, stmt(account_kind="loan", institution="Sample Bank")).json()
    assert loan["liability_suggestions"][0]["liability_id"] == "L-mort"


def test_preview_never_suggests_archived_liability(client, db):
    add_liability(db, "L-old", "Sample Card", lender="Sample Bank", active=False)
    add_liability(db, "L-prev", "Visa", active=False)
    add_import(db, "i1", content_hash="h1", key="acct:card", kind="credit_card", liability_id="L-prev")
    body = preview(client, stmt(account_key="acct:card", account_kind="credit_card",
                                institution="Sample Bank")).json()
    assert body["liability_suggestions"] == []


def test_preview_previous_import_falls_back_when_liability_deleted(client, db):
    add_liability(db, "L1", "Rewards", lender="Sample Bank")
    add_import(db, "i1", content_hash="h1", key="acct:card", kind="credit_card", liability_id="gone")
    body = preview(client, stmt(account_key="acct:card", account_kind="credit_card",
                                institution="Sample Bank")).json()
    assert body["liability_suggestions"][0]["reason"] == "lender_match"


def test_preview_no_suggestion_for_checking(client, db):
    add_liability(db, "L1", "Rewards", lender="Sample Bank")
    body = preview(client, stmt(account_kind="checking", institution="Sample Bank")).json()
    assert body["liability_suggestions"] == []


def test_preview_history_outflows_in_last_400_days(client, db):
    add_import(db, "i1", content_hash="h1", key="acct:one")
    recent = TODAY - timedelta(days=30)
    old = TODAY - timedelta(days=401)
    edge = TODAY - timedelta(days=400)
    add_txn(db, "i1", "acct:one", dedupe="d1", merchant="NETFLIX", amount=-15.49, posted=recent)
    add_txn(db, "i1", "acct:one", dedupe="d2", merchant="NETFLIX", amount=-15.49, posted=old)
    add_txn(db, "i1", "acct:one", dedupe="d3", merchant="NETFLIX", amount=-15.49, posted=edge)
    add_txn(db, "i1", "acct:one", dedupe="d4", merchant="NETFLIX", amount=20.0, posted=recent)
    add_txn(db, "i1", "acct:one", dedupe="d5", merchant="OTHER", amount=-9.0, posted=recent)
    body = preview(client, stmt(merchant_keys=["NETFLIX"])).json()
    assert body["history"] == [
        {"merchant_key": "NETFLIX", "posted_date": edge.isoformat(), "amount": -15.49},
        {"merchant_key": "NETFLIX", "posted_date": recent.isoformat(), "amount": -15.49},
    ]


def test_preview_empty_statement_list(client):
    body = client.post("/api/smart-import/preview", json={"statements": []}).json()
    assert body == {"existing_dedupe_keys": [], "prior_files": [],
                    "liability_suggestions": [], "history": []}


@pytest.mark.parametrize("body", [
    {},
    {"statements": "x"},
    {"statements": [stmt(file_hash="")]},
    {"statements": [stmt(file_hash="has space")]},
    {"statements": [stmt(account_kind="boat")]},
    {"statements": [stmt(extra="no")]},
    {"statements": [stmt()] * 13},
    {"statements": [stmt(dedupe_keys=["k"] * 10_001)]},
    {"statements": [stmt(dedupe_keys=["k" * 401])]},
    {"statements": [stmt(merchant_keys=[1])]},
])
def test_preview_rejects_bad_requests_with_fixed_body(client, body):
    r = client.post("/api/smart-import/preview", json=body)
    assert r.status_code == 422
    assert r.json() == {"error_type": "bad_request", "detail": "The request could not be read."}


# -------------------------------------------------------------------- imports


def test_list_imports_newest_first(client, db):
    add_import(db, "i1", content_hash="h1", key="acct:one", created=datetime(2026, 8, 1), batch="b1")
    add_import(db, "i2", content_hash="h2", key="acct:one", created=datetime(2026, 9, 1), batch="b2",
               origin="sample")
    rows = client.get("/api/smart-import/imports").json()
    assert [r["import_id"] for r in rows] == ["i2", "i1"]
    assert rows[0] == {
        "import_id": "i2", "batch_id": "b2", "file_name": "i2.csv", "origin": "sample",
        "format": "csv", "parser": "csv", "account_kind": "checking", "account_key": "acct:one",
        "account_label": "Main", "account_last4": "1234", "institution": "Sample Bank",
        "period_start": None, "period_end": None, "closing_balance": None,
        "closing_balance_date": None, "liability_id": None, "txn_new": 0, "txn_duplicate": 0,
        "txn_excluded": 0, "ai_used": 0, "ai_provider": None,
        "imported_at": "2026-09-01T00:00:00",
    }


def test_list_imports_skips_legacy_imports(client, db):
    with db.get_session() as s:
        s.add(BankStatementImport(id="legacy", file_name="old.csv", content_hash="hz", status="analyzed"))
        s.commit()
    assert client.get("/api/smart-import/imports").json() == []


# ---------------------------------------------------------------------- rules


def test_list_rules(client, db):
    add_rule(db, "NETFLIX", "cat-Dining", "expense", hits=3)
    add_rule(db, "GONE", "cat-deleted", "expense")
    rules = client.get("/api/smart-import/rules").json()
    assert [r["merchant_key"] for r in rules] == ["GONE", "NETFLIX"]
    gone, netflix = rules
    assert gone["category_deleted"] is True and gone["category_name"] is None
    assert netflix["category_deleted"] is False and netflix["category_name"] == "Dining"
    assert netflix["hits"] == 3 and netflix["source"] == "user" and netflix["kind"] == "expense"
    assert set(netflix) == {"id", "merchant_key", "category_id", "category_name",
                            "category_deleted", "kind", "hits", "source", "updated_at"}


def test_delete_rule(client, db):
    add_rule(db, "NETFLIX", "cat-Dining", "expense", rid="r1")
    add_rule(db, "OTHER", None, "income", rid="r2")
    assert client.delete("/api/smart-import/rules/r1").json() == {"deleted": True}
    assert [r["id"] for r in client.get("/api/smart-import/rules").json()] == ["r2"]


def test_delete_unknown_rule_is_404(client):
    r = client.delete("/api/smart-import/rules/nope")
    assert r.status_code == 404
    assert r.json() == {"error_type": "rule_not_found", "detail": "Rule not found."}


# ------------------------------------------------------------------- settings


def test_settings_round_trip(client):
    assert client.get("/api/smart-import/settings").json()["retention_months"] == 24
    layout = {LAYOUT_SIG: {"date": "Posted", "description": "Memo", "amount": "Amt"}}
    r = client.put("/api/smart-import/settings", json={
        "retention_months": 36, "ai_enabled": True, "pdf_ai_enabled": True,
        "csv_layouts": layout, "accounts": {"acct:one": "Joint", "label:cash": "Cash"},
    })
    assert r.status_code == 200
    expected = {"retention_months": 36, "ai_enabled": True, "pdf_ai_enabled": True,
                "csv_layouts": layout, "accounts": {"acct:one": "Joint", "label:cash": "Cash"}}
    assert r.json() == expected
    assert client.get("/api/smart-import/settings").json() == expected


def test_settings_put_is_partial_and_stores_only_the_fixed_row(client, db):
    client.put("/api/smart-import/settings", json={"ai_enabled": True})
    client.put("/api/smart-import/settings", json={"retention_months": 0})
    body = client.get("/api/smart-import/settings").json()
    assert body["ai_enabled"] is True and body["retention_months"] == 0
    with db.get_session() as s:
        rows = s.query(AppSettings).all()
        assert [r.key for r in rows] == ["smart_import"]
        assert set(json.loads(rows[0].value)) == {
            "retention_months", "ai_enabled", "pdf_ai_enabled", "csv_layouts", "accounts"}


def test_settings_empty_put_changes_nothing(client, db):
    assert client.put("/api/smart-import/settings", json={}).status_code == 200


@pytest.mark.parametrize("months", [0, 12, 24, 36])
def test_settings_accept_retention_values(client, months):
    r = client.put("/api/smart-import/settings", json={"retention_months": months})
    assert r.status_code == 200 and r.json()["retention_months"] == months


@pytest.mark.parametrize("body", [
    {"retention_months": 13},
    {"retention_months": -1},
    {"retention_months": "12"},
    {"retention_months": 12.5},
    {"retention_months": False},
    {"retention_months": None},
    {"ai_enabled": "true"},
    {"ai_enabled": 1},
    {"ai_enabled": None},
    {"pdf_ai_enabled": "yes"},
    {"unknown_key": 1},
    {"app_password": "x"},
    {"csv_layouts": {"short": {"date": "A"}}},
    {"csv_layouts": {LAYOUT_SIG: {"bogus": "A"}}},
    {"csv_layouts": {LAYOUT_SIG: {"date": ""}}},
    {"csv_layouts": {LAYOUT_SIG: {"date": 5}}},
    {"csv_layouts": {LAYOUT_SIG: {"date": "x" * 201}}},
    {"csv_layouts": {f"{n:064x}": {"date": "A"} for n in range(51)}},
    {"csv_layouts": []},
    {"accounts": {"plain": "x"}},
    {"accounts": {"acct:one": ""}},
    {"accounts": {"acct:one": "x" * 121}},
    {"accounts": {"acct:one": 5}},
    {"accounts": {f"acct:{n}": "x" for n in range(201)}},
    {"accounts": ["acct:one"]},
])
def test_settings_reject_bad_values(client, db, body):
    before = counts(db)
    r = client.put("/api/smart-import/settings", json=body)
    assert r.status_code == 422
    assert r.json() == {"error_type": "bad_request", "detail": "The request could not be read."}
    assert counts(db) == before


def test_get_settings_ignores_junk_in_the_stored_row(client, db):
    with db.get_session() as s:
        s.add(AppSettings(key="smart_import", value=json.dumps({
            "retention_months": 7, "ai_enabled": "yes", "csv_layouts": [1], "accounts": "x",
            "evil": "x"})))
        s.commit()
    assert client.get("/api/smart-import/settings").json() == {
        "retention_months": 24, "ai_enabled": False, "pdf_ai_enabled": False,
        "csv_layouts": {}, "accounts": {}}


def test_settings_put_survives_a_corrupt_stored_row(client, db):
    with db.get_session() as s:
        s.add(AppSettings(key="smart_import", value="{not json"))
        s.commit()
    r = client.put("/api/smart-import/settings", json={"retention_months": 12})
    assert r.status_code == 200 and r.json()["retention_months"] == 12


# --------------------------------------------------------- demo protection


def test_writes_refused_under_demo_protection(client, db, monkeypatch):
    add_rule(db, "NETFLIX", "cat-Dining", "expense", rid="r1")
    monkeypatch.delenv("PORTFOLIO_TEST_MODE", raising=False)
    monkeypatch.setenv("PORTFOLIO_DEMO_MODE", "true")
    monkeypatch.setenv("PROTECT_DEMO_DATA", "true")
    before = counts(db)
    assert client.put("/api/smart-import/settings", json={"ai_enabled": True}).status_code == 403
    assert client.delete("/api/smart-import/rules/r1").status_code == 403
    assert counts(db) == before
    # Reads still work, and preview is a read.
    assert client.get("/api/smart-import/context").status_code == 200
    assert client.get("/api/smart-import/settings").status_code == 200
    assert client.get("/api/smart-import/rules").status_code == 200
    assert client.get("/api/smart-import/imports").status_code == 200
    assert preview(client, stmt()).status_code == 200


# ------------------------------------------------------ fixed errors, logging


def test_unexpected_errors_become_a_fixed_500_without_content(client, db, monkeypatch, caplog):
    add_rule(db, "ZQXSECRET", "cat-Dining", "expense", rid="r1")

    def boom(*a, **k):
        raise RuntimeError("leak ZQXSECRET 99.99")

    monkeypatch.setattr("src.smart_import.service._rules", boom)
    caplog.set_level(logging.DEBUG)
    r = client.get("/api/smart-import/rules")
    assert r.status_code == 500
    assert r.json() == {"error_type": "server_error", "detail": "Something went wrong."}
    assert "ZQXSECRET" not in r.text and "99.99" not in r.text
    assert "ZQXSECRET" not in "\n".join(x.getMessage() for x in caplog.records)


def test_settings_write_failure_is_a_fixed_500(client, db, monkeypatch, caplog):
    def boom(*a, **k):
        raise RuntimeError("leak ZQXSECRET")

    monkeypatch.setattr(Database, "set_setting", boom)
    caplog.set_level(logging.DEBUG)
    r = client.put("/api/smart-import/settings", json={"accounts": {"acct:one": "ZQXSECRET"}})
    assert r.status_code == 500
    assert r.json() == {"error_type": "save_failed", "detail": "The change could not be saved."}
    assert "ZQXSECRET" not in r.text
    assert "ZQXSECRET" not in "\n".join(x.getMessage() for x in caplog.records)


def test_no_planted_values_in_logs(client, db, caplog):
    planted = "ZQXPLANTED WIDGETS"
    add_import(db, "i1", content_hash=HASH_B, key="acct:one", label=planted)
    add_txn(db, "i1", "acct:one", dedupe="acct:one|zqx", merchant=planted, amount=-4242.42,
            posted=TODAY - timedelta(days=3))
    add_rule(db, planted, "cat-Dining", "expense", rid="r1")
    caplog.set_level(logging.DEBUG)
    client.get("/api/smart-import/context")
    preview(client, stmt(dedupe_keys=["acct:one|zqx"], merchant_keys=[planted], institution=planted))
    client.get("/api/smart-import/imports")
    client.get("/api/smart-import/rules")
    client.put("/api/smart-import/settings", json={"accounts": {"acct:one": planted}})
    client.put("/api/smart-import/settings", json={"retention_months": 99})
    client.delete("/api/smart-import/rules/r1")
    client.delete("/api/smart-import/rules/missing")
    text = "\n".join(r.getMessage() for r in caplog.records)
    for secret in (planted, "ZQXPLANTED", "4242", "acct:one|zqx"):
        assert secret not in text
