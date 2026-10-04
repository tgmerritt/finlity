"""Convert a real estate position into a mortgage, and undo it (design section 8).

Every test runs against a fresh temp Database injected through the get_db
dependency override; the tracked demo database is never touched. Row-level
checks read the raw SQLite rows (sqlite3, no SQLAlchemy type processing) so
"unchanged" means byte for byte.
"""

import hashlib
import json
import logging
import sqlite3
from datetime import date, datetime

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.exc import IntegrityError

from src.api.dependencies import get_db
from src.database import Database
from src.database.models import (
    Account,
    BudgetExpense,
    BudgetExpenseCategory,
    Liability,
    LiabilityBalanceSnapshot,
    Position,
    PositionLot,
)
from src.main import app

TODAY = date(2026, 10, 4)
CONVERT = "/api/liabilities/convert-position"
SAVE_FAILED = {"detail": "Could not save the liability"}


@pytest.fixture()
def db_path(tmp_path):
    return str(tmp_path / "convert.db")


@pytest.fixture()
def db(db_path):
    database = Database(db_path)
    with database.get_session() as s:
        for i, name in enumerate(["Housing", "Transportation", "Debt Payments", "Other"]):
            s.add(BudgetExpenseCategory(id=f"cat-{name}", name=name, sort_order=i))
        s.add(Account(id="acct-b", name="Brokerage", account_type="taxable"))
        s.flush()
        s.add(
            Position(
                id="pos-vti", account_id="acct-b", ticker="VTI", name="Total Market", shares=10.0, current_price=330.0
            )
        )
        s.add(
            Position(
                id="pos-re",
                account_id="acct-b",
                ticker="RE",
                name="Home",
                shares=1.0,
                current_price=612000.0,
                cost_basis=400000.0,
                position_type="real_estate",
                asset_class="alternative",
                purchase_date=datetime(2015, 6, 1),
            )
        )
        s.commit()
    return database


@pytest.fixture()
def client(db, monkeypatch):
    monkeypatch.setattr("src.liabilities.clock.today", lambda: TODAY)
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_db, None)


def raw_rows(db_path, table):
    conn = sqlite3.connect(db_path)
    try:
        conn.row_factory = sqlite3.Row
        return [dict(r) for r in conn.execute(f"SELECT * FROM {table} ORDER BY id")]  # nosec B608 - fixed test table names
    finally:
        conn.close()


def raw_row(db_path, table, row_id):
    return next((r for r in raw_rows(db_path, table) if r["id"] == row_id), None)


def table_hash(db_path, table):
    return hashlib.sha256(repr(raw_rows(db_path, table)).encode()).hexdigest()


def hashes(db_path):
    return {t: table_hash(db_path, t) for t in ("positions", "accounts", "budget_expenses", "position_lots")}


def counts(db):
    with db.get_session() as s:
        return {
            "liabilities": s.query(Liability).count(),
            "snapshots": s.query(LiabilityBalanceSnapshot).count(),
            "accounts": s.query(Account).count(),
            "positions": s.query(Position).count(),
            "expenses": s.query(BudgetExpense).count(),
        }


def mortgage(**over):
    body = {
        "name": "Mortgage",
        "lender": "First Bank",
        "current_balance": 248000,
        "balance_as_of": "2026-10-01",
        "interest_rate": 0.0625,
        "payment_amount": 1980.0,
        "next_payment_date": "2026-11-01",
    }
    body.update(over)
    return body


def convert(client, mode, position_id="pos-re", **over):
    body = {"position_id": position_id, "mode": mode, "mortgage": mortgage()}
    if mode == "equity":
        body["home_value"] = 860000
    body.update(over)
    return client.post(CONVERT, json=body)


def source_detail(db, liability_id):
    with db.get_session() as s:
        return json.loads(s.get(Liability, liability_id).source_detail)


def seed_expense(db, amount=1500.0, name="Mortgage"):
    with db.get_session() as s:
        exp = BudgetExpense(category_id="cat-Housing", name=name, amount=amount, frequency="monthly")
        s.add(exp)
        s.commit()
        return exp.id


# ---------------------------------------------------------------------------
# Mode property_value
# ---------------------------------------------------------------------------


def test_property_value_leaves_position_byte_for_byte(client, db, db_path):
    before = hashes(db_path)
    r = convert(client, "property_value")
    assert r.status_code == 201
    body = r.json()
    liab = body["liability"]
    assert liab["liability_type"] == "mortgage" and liab["is_amortizing"] is True
    assert liab["source"] == "converted_position" and liab["source_ref"] == "pos-re"
    assert liab["linked_position_id"] == "pos-re" and liab["linked_position"]["value"] == 612000
    assert liab["current_balance"] == 248000 and liab["lender"] == "First Bank"
    assert body["position"] == {"id": "pos-re", "name": "Home", "value": 612000}
    assert body["created"] == {"account_id": None, "position_id": None, "expense_id": None}
    assert "source_detail" not in liab and "source_detail" not in body
    assert hashes(db_path) == before
    detail = source_detail(db, liab["id"])
    assert detail["mode"] == "property_value"
    assert detail["position_before"] == raw_row(db_path, "positions", "pos-re")
    with db.get_session() as s:
        snap = s.query(LiabilityBalanceSnapshot).one()
        assert snap.balance == 248000 and snap.source == "converted_position"


# ---------------------------------------------------------------------------
# Mode equity
# ---------------------------------------------------------------------------


def test_equity_changes_only_current_price(client, db, db_path):
    original = raw_row(db_path, "positions", "pos-re")
    others = {t: table_hash(db_path, t) for t in ("accounts", "budget_expenses")}
    r = convert(client, "equity")
    assert r.status_code == 201
    liab = r.json()["liability"]
    assert liab["current_balance"] == 248000 and liab["linked_position_id"] == "pos-re"
    assert r.json()["position"] == {"id": "pos-re", "name": "Home", "value": 860000}
    after = raw_row(db_path, "positions", "pos-re")
    assert after["current_price"] == 860000
    assert {k: v for k, v in after.items() if k != "current_price"} == {
        k: v for k, v in original.items() if k != "current_price"
    }
    assert raw_row(db_path, "positions", "pos-vti") is not None
    assert {t: table_hash(db_path, t) for t in ("accounts", "budget_expenses")} == others
    detail = source_detail(db, liab["id"])
    assert detail["position_before"]["current_price"] == 612000
    assert detail["set_current_price"] == 860000


def test_equity_with_several_units_prices_per_unit(client, db, db_path):
    with db.get_session() as s:
        s.get(Position, "pos-re").shares = 4.0
        s.commit()
    r = convert(client, "equity", home_value=800000)
    assert r.status_code == 201
    assert raw_row(db_path, "positions", "pos-re")["current_price"] == 200000
    assert r.json()["position"]["value"] == 800000


def test_equity_requires_home_value_and_zero_units_is_409(client, db, db_path):
    body = {"position_id": "pos-re", "mode": "equity", "mortgage": mortgage()}
    assert client.post(CONVERT, json=body).status_code == 422
    with db.get_session() as s:
        s.get(Position, "pos-re").shares = 0.0
        s.commit()
    before = hashes(db_path)
    r = convert(client, "equity")
    assert r.status_code == 409
    assert hashes(db_path) == before and counts(db)["liabilities"] == 0


# ---------------------------------------------------------------------------
# Mode loan
# ---------------------------------------------------------------------------


def test_loan_deletes_position_and_stores_full_row(client, db, db_path):
    with db.get_session() as s:
        s.get(Position, "pos-re").current_price = -251234.56
        s.commit()
    original = raw_row(db_path, "positions", "pos-re")
    body = {"position_id": "pos-re", "mode": "loan", "mortgage": mortgage(current_balance=None)}
    r = client.post(CONVERT, json=body)
    assert r.status_code == 201
    liab = r.json()["liability"]
    assert liab["current_balance"] == 251234.56  # defaults to the absolute position value
    assert liab["linked_position_id"] is None
    assert r.json()["position"] is None
    assert raw_row(db_path, "positions", "pos-re") is None
    assert source_detail(db, liab["id"])["position_before"] == original


def test_loan_with_add_home_creates_account_and_position(client, db, db_path):
    r = convert(client, "loan", add_home={"name": "Our house", "value": 700000, "purchase_date": "2015-06-01"})
    assert r.status_code == 201
    created = r.json()["created"]
    liab = r.json()["liability"]
    assert created["account_id"] and created["position_id"] and created["expense_id"] is None
    assert liab["linked_position_id"] == created["position_id"]
    assert liab["current_balance"] == 248000  # an entered balance wins over the default
    with db.get_session() as s:
        acct = s.get(Account, created["account_id"])
        assert acct.account_type == "property"
        pos = s.get(Position, created["position_id"])
        assert pos.account_id == acct.id and pos.current_price == 700000 and pos.position_type == "real_estate"
    assert source_detail(db, liab["id"])["created"] == created


def test_loan_add_home_reuses_existing_property_account(client, db):
    with db.get_session() as s:
        s.add(Account(id="acct-p", name="Houses", account_type="property"))
        s.commit()
    r = convert(client, "loan", add_home={"name": "Our house", "value": 700000})
    created = r.json()["created"]
    assert created["account_id"] is None  # not created by the conversion, never deleted by a revert
    with db.get_session() as s:
        assert s.get(Position, created["position_id"]).account_id == "acct-p"


def test_loan_refuses_positions_with_lots(client, db, db_path):
    with db.get_session() as s:
        s.add(PositionLot(position_id="pos-re", purchase_date=datetime(2015, 6, 1), shares=1.0, cost_basis=400000.0))
        s.commit()
    before = hashes(db_path)
    assert convert(client, "loan").status_code == 409
    assert hashes(db_path) == before and counts(db)["liabilities"] == 0


# ---------------------------------------------------------------------------
# Validation and refusals
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "patch",
    [
        {"mode": "rent"},
        {"position_id": ""},
        {"mortgage": mortgage(current_balance=None)},  # required outside loan mode
        {"mortgage": mortgage(liability_type="heloc")},
        {"mortgage": mortgage(source="wizard")},
        {"mortgage": mortgage(linked_position_id="pos-vti")},
        {"mortgage": mortgage(interest_rate=2)},
        {"mortgage": mortgage(balance_as_of="2026-10-01T00:00:00")},
        {"mortgage": mortgage(name=None)},
        {"home_value": 5},  # equity only
        {"add_home": {"name": "x", "value": 1}},  # loan only
        {"surprise": True},
    ],
)
def test_convert_validation_422_writes_nothing(client, db, db_path, patch):
    before = hashes(db_path)
    body = {"position_id": "pos-re", "mode": "property_value", "mortgage": mortgage(), **patch}
    assert client.post(CONVERT, json=body).status_code == 422
    assert hashes(db_path) == before and counts(db)["liabilities"] == 0


def test_convert_refusals(client, db, db_path):
    before = hashes(db_path)
    assert convert(client, "property_value", position_id="nope").status_code == 404
    r = convert(client, "property_value", position_id="pos-vti")
    assert r.status_code == 409 and r.json()["detail"] == "Only real estate positions can be converted"
    assert convert(client, "property_value", mortgage=mortgage(balance_as_of="2026-10-05")).status_code == 422
    assert hashes(db_path) == before and counts(db)["liabilities"] == 0
    assert convert(client, "property_value").status_code == 201
    r = convert(client, "equity")
    assert r.status_code == 409 and r.json()["detail"] == "This position is already converted"


def test_name_defaults_to_mortgage(client):
    body = {"position_id": "pos-re", "mode": "property_value", "mortgage": {"current_balance": 1000}}
    r = client.post(CONVERT, json=body)
    assert r.status_code == 201 and r.json()["liability"]["name"] == "Mortgage"


# ---------------------------------------------------------------------------
# Cash flow block (as in create)
# ---------------------------------------------------------------------------


def test_cash_flow_create_makes_mortgage_expense(client, db):
    r = convert(client, "equity", cash_flow={"mode": "create"})
    created = r.json()["created"]
    assert created["expense_id"] and r.json()["liability"]["expense_id"] == created["expense_id"]
    with db.get_session() as s:
        exp = s.get(BudgetExpense, created["expense_id"])
        assert exp.category_id == "cat-Housing" and exp.amount == 1980.0 and exp.is_mortgage is True
        assert exp.interest_portion == pytest.approx(248000 * 0.0625 / 12, abs=0.01)


def test_cash_flow_link_sets_split_and_none_writes_nothing(client, db, db_path):
    exp_id = seed_expense(db)
    r = convert(client, "property_value", cash_flow={"mode": "link", "expense_id": exp_id})
    assert r.status_code == 201 and r.json()["liability"]["expense_id"] == exp_id
    assert r.json()["created"]["expense_id"] is None
    with db.get_session() as s:
        exp = s.get(BudgetExpense, exp_id)
        assert exp.amount == 1500.0 and exp.is_mortgage is True
    detail = source_detail(db, r.json()["liability"]["id"])
    assert detail["linked_expense"]["id"] == exp_id and not detail["linked_expense"]["is_mortgage"]


def test_cash_flow_none(client, db):
    before = counts(db)["expenses"]
    assert convert(client, "property_value", cash_flow={"mode": "none"}).status_code == 201
    assert counts(db)["expenses"] == before


# ---------------------------------------------------------------------------
# Atomicity
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["property_value", "equity", "loan"])
def test_cash_flow_failure_rolls_back_everything(client, db, db_path, mode):
    extra = {"add_home": {"name": "New", "value": 1}} if mode == "loan" else {}
    before, before_counts = hashes(db_path), counts(db)
    for cash_flow, status in (
        ({"mode": "link", "expense_id": "nope"}, 404),
        ({"mode": "create", "category_id": "nope"}, 404),
    ):
        assert convert(client, mode, cash_flow=cash_flow, **extra).status_code == status
        assert hashes(db_path) == before and counts(db) == before_counts


@pytest.mark.parametrize("mode", ["property_value", "equity", "loan"])
def test_unexpected_failure_is_fixed_500_rolls_back_and_does_not_leak(client, db, db_path, caplog, monkeypatch, mode):
    caplog.set_level(logging.DEBUG)
    before, before_counts = hashes(db_path), counts(db)

    def boom(*a, **k):
        raise IntegrityError("INSERT INTO t VALUES (?)", {"balance": 248000, "name": "Home"}, Exception("UNIQUE 612000"))

    monkeypatch.setattr("src.liabilities.service._serialize", boom)
    extra = {"add_home": {"name": "SecretHouse", "value": 1}} if mode == "loan" else {}
    r = convert(client, mode, cash_flow={"mode": "create"}, **extra)
    assert r.status_code == 500 and r.json() == SAVE_FAILED
    assert hashes(db_path) == before and counts(db) == before_counts
    for secret in ("248000", "612000", "860000", "SecretHouse", "First Bank", "Traceback"):
        assert secret not in caplog.text


# ---------------------------------------------------------------------------
# Revert
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("mode", ["property_value", "equity", "loan"])
@pytest.mark.parametrize("cash_flow", [None, {"mode": "create"}])
def test_revert_restores_everything_exactly(client, db, db_path, mode, cash_flow):
    before, before_counts = hashes(db_path), counts(db)
    extra = {"add_home": {"name": "Our house", "value": 700000}} if mode == "loan" else {}
    if cash_flow:
        extra["cash_flow"] = cash_flow
    lid = convert(client, mode, **extra).json()["liability"]["id"]
    client.post(f"/api/liabilities/{lid}/balance", json={"balance": 247000})
    r = client.post(f"/api/liabilities/{lid}/revert-conversion")
    assert r.status_code == 200 and r.json() == {"reverted": True}
    assert hashes(db_path) == before
    assert counts(db) == before_counts
    assert client.get(f"/api/liabilities/{lid}").status_code == 404


def test_revert_restores_linked_expense_split(client, db, db_path):
    exp_id = seed_expense(db)
    before = hashes(db_path)
    lid = convert(client, "property_value", cash_flow={"mode": "link", "expense_id": exp_id}).json()["liability"]["id"]
    assert raw_row(db_path, "budget_expenses", exp_id)["is_mortgage"] == 1
    assert client.post(f"/api/liabilities/{lid}/revert-conversion").status_code == 200
    assert hashes(db_path) == before


def test_revert_keeps_property_account_holding_later_positions(client, db):
    created = convert(client, "loan", add_home={"name": "Our house", "value": 700000}).json()
    acct = created["created"]["account_id"]
    with db.get_session() as s:
        s.add(Position(id="pos-later", account_id=acct, ticker="RE", name="Cabin", shares=1.0, current_price=1.0))
        s.commit()
    assert client.post(f"/api/liabilities/{created['liability']['id']}/revert-conversion").status_code == 200
    with db.get_session() as s:
        assert s.get(Account, acct) is not None
        assert s.get(Position, "pos-later") is not None
        assert s.get(Position, created["created"]["position_id"]) is None
        assert s.get(Position, "pos-re") is not None


def test_revert_refuses_non_converted_and_unknown(client, db):
    lid = client.post(
        "/api/liabilities", json={"name": "Card", "liability_type": "credit_card", "current_balance": 5}
    ).json()["id"]
    r = client.post(f"/api/liabilities/{lid}/revert-conversion")
    assert r.status_code == 409 and r.json()["detail"] == "Only converted debts can be undone"
    assert client.get(f"/api/liabilities/{lid}").status_code == 200
    assert client.post("/api/liabilities/nope/revert-conversion").status_code == 404


def test_revert_twice_is_404(client):
    lid = convert(client, "equity").json()["liability"]["id"]
    assert client.post(f"/api/liabilities/{lid}/revert-conversion").status_code == 200
    assert client.post(f"/api/liabilities/{lid}/revert-conversion").status_code == 404


# Post-conversion edits (the rule in the C3a report): refuse rather than overwrite.


def test_equity_revert_refuses_after_price_edit(client, db, db_path):
    lid = convert(client, "equity").json()["liability"]["id"]
    with db.get_session() as s:
        s.get(Position, "pos-re").current_price = 900000.0
        s.commit()
    snapshot = (hashes(db_path), counts(db))
    r = client.post(f"/api/liabilities/{lid}/revert-conversion")
    assert r.status_code == 409
    assert r.json()["detail"] == "The property value changed after the conversion, so it cannot be undone"
    assert (hashes(db_path), counts(db)) == snapshot


def test_equity_revert_refuses_after_position_deleted(client, db, db_path):
    lid = convert(client, "equity").json()["liability"]["id"]
    with db.get_session() as s:
        s.delete(s.get(Position, "pos-re"))
        s.commit()
    snapshot = (hashes(db_path), counts(db))
    r = client.post(f"/api/liabilities/{lid}/revert-conversion")
    assert r.status_code == 409
    assert r.json()["detail"] == "The property was removed after the conversion, so it cannot be undone"
    assert (hashes(db_path), counts(db)) == snapshot


def test_equity_revert_keeps_later_edits_to_other_fields(client, db, db_path):
    lid = convert(client, "equity").json()["liability"]["id"]
    with db.get_session() as s:
        s.get(Position, "pos-re").name = "Renamed"
        s.commit()
    edited = raw_row(db_path, "positions", "pos-re")
    assert client.post(f"/api/liabilities/{lid}/revert-conversion").status_code == 200
    restored = raw_row(db_path, "positions", "pos-re")
    assert restored == {**edited, "current_price": 612000}


def test_loan_revert_refuses_when_account_is_gone(client, db, db_path):
    lid = convert(client, "loan").json()["liability"]["id"]
    with db.get_session() as s:
        s.delete(s.get(Position, "pos-vti"))
        s.delete(s.get(Account, "acct-b"))
        s.commit()
    snapshot = (hashes(db_path), counts(db))
    r = client.post(f"/api/liabilities/{lid}/revert-conversion")
    assert r.status_code == 409
    assert r.json()["detail"] == "The account that held this position no longer exists"
    assert (hashes(db_path), counts(db)) == snapshot


def test_property_value_revert_ignores_position_edits(client, db, db_path):
    lid = convert(client, "property_value").json()["liability"]["id"]
    with db.get_session() as s:
        s.get(Position, "pos-re").current_price = 650000.0
        s.commit()
    edited = hashes(db_path)
    assert client.post(f"/api/liabilities/{lid}/revert-conversion").status_code == 200
    assert hashes(db_path) == edited


def test_revert_refuses_corrupt_detail(client, db, db_path):
    lid = convert(client, "equity").json()["liability"]["id"]
    with db.get_session() as s:
        s.get(Liability, lid).source_detail = "{not json"
        s.commit()
    snapshot = (hashes(db_path), counts(db))
    r = client.post(f"/api/liabilities/{lid}/revert-conversion")
    assert r.status_code == 409 and r.json()["detail"] == "This conversion cannot be undone"
    assert (hashes(db_path), counts(db)) == snapshot


def test_revert_unexpected_failure_rolls_back(client, db, db_path, caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    lid = convert(client, "loan", add_home={"name": "SecretHouse", "value": 700000}, cash_flow={"mode": "create"})
    lid = lid.json()["liability"]["id"]
    snapshot = (hashes(db_path), counts(db))

    def boom(*a, **k):
        raise IntegrityError("DELETE", {"balance": 248000}, Exception("248000"))

    monkeypatch.setattr("src.liabilities.service.LiabilityBalanceSnapshot", boom)
    r = client.post(f"/api/liabilities/{lid}/revert-conversion")
    assert r.status_code == 500 and r.json() == SAVE_FAILED
    assert (hashes(db_path), counts(db)) == snapshot
    for secret in ("248000", "SecretHouse", "Traceback"):
        assert secret not in caplog.text


# ---------------------------------------------------------------------------
# Demo protection and routing
# ---------------------------------------------------------------------------


def test_demo_protection_refuses_convert_and_revert(client, db, db_path, monkeypatch):
    lid = convert(client, "equity").json()["liability"]["id"]
    monkeypatch.delenv("PORTFOLIO_TEST_MODE", raising=False)
    monkeypatch.setenv("PORTFOLIO_DEMO_MODE", "true")
    monkeypatch.setenv("PROTECT_DEMO_DATA", "true")
    snapshot = (hashes(db_path), counts(db))
    assert convert(client, "property_value", position_id="pos-vti").status_code == 403
    assert client.post(f"/api/liabilities/{lid}/revert-conversion").status_code == 403
    assert (hashes(db_path), counts(db)) == snapshot


def test_convert_route_is_registered_before_id_routes():
    paths = [getattr(r, "path", "") for r in app.routes]
    convert_at = paths.index("/api/liabilities/convert-position")
    assert convert_at < paths.index("/api/liabilities/{liability_id}")
    assert "/api/liabilities/{liability_id}/revert-conversion" in paths


def test_no_money_or_names_in_logs(client, db, caplog):
    caplog.set_level(logging.DEBUG)
    for mode in ("property_value", "equity", "loan"):
        extra = {"add_home": {"name": "SecretHouse", "value": 700001}} if mode == "loan" else {}
        lid = convert(client, mode, cash_flow={"mode": "create"}, **extra).json()["liability"]["id"]
        client.post(f"/api/liabilities/{lid}/revert-conversion")
    text = "\n".join(r.getMessage() for r in caplog.records)
    for secret in ("248000", "612000", "860000", "700001", "1980", "SecretHouse", "First Bank", "Home"):
        assert secret not in text
