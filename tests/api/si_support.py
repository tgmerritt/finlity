"""Shared fixtures and builders for the smart import data layer tests."""

import hashlib
import json
from datetime import date

import pytest
from fastapi.testclient import TestClient

from src.api.dependencies import get_db
from src.database import Database
from src.database.models import (
    AppSettings,
    BankStatementImport,
    BudgetExpense,
    BudgetExpenseCategory,
    ImportTransaction,
    Liability,
    LiabilityBalanceSnapshot,
    MerchantRule,
    RecurringCandidate,
    SmartImportLedger,
    SmartImportMeta,
)
from src.main import app
from tests.connectors.apply_contract import CONNECTION_ID

TODAY = date(2026, 10, 4)
HASH_A = "a" * 64
HASH_B = "b" * 64
HASH_C = "c" * 64
CONN_ID = CONNECTION_ID

ALL_TABLES = (
    BankStatementImport,
    SmartImportMeta,
    ImportTransaction,
    MerchantRule,
    SmartImportLedger,
    RecurringCandidate,
    BudgetExpense,
    Liability,
    LiabilityBalanceSnapshot,
)


@pytest.fixture()
def db(tmp_path):
    database = Database(str(tmp_path / "si.db"))
    with database.get_session() as s:
        for i, name in enumerate(["Groceries", "Dining", "Debt Payments", "Other"]):
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


def table_hashes(db):
    """A content hash of every table apply or undo can touch."""
    out = {}
    with db.get_session() as s:
        for model in ALL_TABLES:
            rows = []
            for row in s.query(model).all():
                rows.append({c.name: repr(getattr(row, c.name)) for c in model.__table__.columns})
            rows.sort(key=lambda r: json.dumps(r, sort_keys=True))
            out[model.__tablename__] = hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()
    return out


def add_liability(db, lid="L1", name="Visa", *, balance=500.0, as_of=date(2026, 9, 1), ltype="credit_card",
                  lender="Sample Bank", snapshot=True, expense_id=None):
    with db.get_session() as s:
        s.add(Liability(id=lid, name=name, liability_type=ltype, lender=lender, current_balance=balance,
                        balance_as_of=as_of, is_amortizing=False, expense_id=expense_id))
        if snapshot:
            s.add(LiabilityBalanceSnapshot(liability_id=lid, snapshot_date=as_of, balance=balance, source="manual"))
        s.commit()


def connection_entry(provider="demo", **extra):
    """One sanitize-valid entry of the ``connections`` settings document."""
    entry = {
        "provider": provider, "label": "Demo", "created_at": "2026-10-01T09:00:00Z", "status": "ok",
        "status_at": "2026-10-01T09:00:00Z", "last_synced_at": None, "first_sync_days": 90,
        "requests": [], "accounts": {},
    }
    entry.update(extra)
    return entry


def add_connections(db, items):
    """Write the raw ``connections`` row, as the connection store keeps it."""
    with db.get_session() as s:
        s.add(AppSettings(key="connections", value=json.dumps({"version": 1, "items": items}), encrypted=False))
        s.commit()


def add_connection(db, cid=CONN_ID, provider="demo"):
    add_connections(db, {cid: connection_entry(provider)})


def add_expense(db, eid="E1", name="Netflix", amount=15.49, frequency="monthly", category="cat-Dining",
                active=True, entity_id=None):
    with db.get_session() as s:
        s.add(BudgetExpense(id=eid, name=name, amount=amount, frequency=frequency, category_id=category,
                            is_active=active, entity_id=entity_id))
        s.commit()


def txn(posted, amount, merchant="NETFLIX", dedupe=None, kind="expense", category="cat-Dining",
        source="rule", excluded=False, **extra):
    body = {
        "posted_date": posted if isinstance(posted, str) else posted.isoformat(),
        "amount": amount, "description": merchant, "merchant_key": merchant, "kind": kind,
        "category_id": category, "category_source": source,
        "dedupe_key": dedupe or f"acct:one|{merchant}|{posted}|{amount}", "excluded": excluded,
    }
    body.update(extra)
    return body


def statement(file_hash=HASH_A, txns=(), *, key="acct:one", kind="checking", origin="file", closing=None,
              liability_id=None, period=None, **extra):
    body = {
        "file_hash": file_hash, "file_name": "statement.csv", "origin": origin, "format": "csv",
        "parser": "csv",
        "account": {"kind": kind, "key": key, "label": "Main", "last4": "1234", "institution": "Sample Bank"},
        "period": period or {"start": None, "end": None},
        "closing_balance": closing, "liability_id": liability_id, "ai_used": False,
        "transactions": list(txns),
    }
    body.update(extra)
    return body


def apply_body(statements, *, rules=(), recurring=(), batch="batch-1", entity_id=None):
    body = {"batch_id": batch, "statements": list(statements), "rules": list(rules),
            "recurring": list(recurring)}
    if entity_id:
        body["entity_id"] = entity_id
    return body


def do_apply(client, body):
    return client.post("/api/smart-import/apply", json=body)


def candidate(decision, merchant="NETFLIX", *, file_hash=HASH_A, name="Netflix", amount=15.49,
              frequency="monthly", category="cat-Dining", expense_id=None):
    body = {"merchant_key": merchant, "name": name, "amount": amount, "frequency": frequency,
            "category_id": category, "occurrences": 3, "file_hash": file_hash, "decision": decision}
    if expense_id:
        body["expense_id"] = expense_id
    return body
