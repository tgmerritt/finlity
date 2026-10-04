"""Liabilities API: create, read, update, delete, balances and history.

Every test runs against a fresh temp Database injected through the get_db
dependency override; the tracked demo database is never touched.
"""

import logging
from datetime import date

from sqlalchemy.exc import IntegrityError

import pytest
from fastapi.testclient import TestClient

from src.api.dependencies import get_db
from src.database import Database
from src.database.models import (
    Account,
    BudgetExpense,
    BudgetExpenseCategory,
    Liability,
    LiabilityBalanceSnapshot,
    Position,
)
from src.main import app

TODAY = date(2026, 10, 4)
TYPES = ["mortgage", "auto_loan", "student_loan", "credit_card", "personal_loan", "heloc", "other"]
EXPECTED_AMORTIZING = {
    "mortgage": True,
    "auto_loan": True,
    "student_loan": True,
    "credit_card": False,
    "personal_loan": True,
    "heloc": False,
    "other": False,
}


@pytest.fixture()
def db(tmp_path):
    database = Database(str(tmp_path / "liab.db"))
    with database.get_session() as s:
        for i, name in enumerate(["Housing", "Transportation", "Debt Payments", "Other"]):
            s.add(BudgetExpenseCategory(id=f"cat-{name}", name=name, sort_order=i))
        s.commit()
    return database


@pytest.fixture()
def client(db, monkeypatch):
    monkeypatch.setattr("src.liabilities.clock.today", lambda: TODAY)
    app.dependency_overrides[get_db] = lambda: db
    yield TestClient(app, raise_server_exceptions=False)
    app.dependency_overrides.pop(get_db, None)


def counts(db):
    with db.get_session() as s:
        return {
            "liabilities": s.query(Liability).count(),
            "snapshots": s.query(LiabilityBalanceSnapshot).count(),
            "accounts": s.query(Account).count(),
            "positions": s.query(Position).count(),
            "expenses": s.query(BudgetExpense).count(),
        }


def mortgage_body(**over):
    body = {
        "name": "Home loan",
        "liability_type": "mortgage",
        "current_balance": 520000,
        "balance_as_of": "2026-10-01",
        "interest_rate": 0.0625,
        "payment_amount": 3201.73,
        "next_payment_date": "2026-11-01",
    }
    body.update(over)
    return body


def seed_position(db, value=600000.0):
    with db.get_session() as s:
        acct = Account(name="Houses", account_type="property")
        s.add(acct)
        s.flush()
        pos = Position(
            account_id=acct.id, ticker="RE", name="Home", shares=1.0, current_price=value, position_type="real_estate"
        )
        s.add(pos)
        s.commit()
        return pos.id


def seed_expense(db, amount=1500.0, name="Mortgage"):
    with db.get_session() as s:
        exp = BudgetExpense(category_id="cat-Housing", name=name, amount=amount, frequency="monthly")
        s.add(exp)
        s.commit()
        return exp.id


@pytest.mark.parametrize("liability_type", TYPES)
def test_create_each_type_with_defaults_and_first_snapshot(client, db, liability_type):
    resp = client.post(
        "/api/liabilities",
        json={"name": "Debt", "liability_type": liability_type, "current_balance": 1000, "balance_as_of": "2026-09-30"},
    )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["is_amortizing"] is EXPECTED_AMORTIZING[liability_type]
    assert body["payment_frequency"] == "monthly"
    assert body["source"] == "manual"
    assert body["is_active"] is True
    assert body["balance_as_of"] == "2026-09-30"
    with db.get_session() as s:
        snaps = s.query(LiabilityBalanceSnapshot).all()
        assert len(snaps) == 1
        assert snaps[0].snapshot_date == date(2026, 9, 30)
        assert snaps[0].balance == 1000


def test_other_with_term_is_amortizing_and_explicit_flag_wins(client):
    r = client.post("/api/liabilities", json={"name": "x", "liability_type": "other", "current_balance": 5, "term_months": 24})
    assert r.json()["is_amortizing"] is True
    r = client.post(
        "/api/liabilities",
        json={"name": "x", "liability_type": "mortgage", "current_balance": 5, "is_amortizing": False},
    )
    assert r.json()["is_amortizing"] is False


def test_balance_as_of_defaults_to_today(client):
    r = client.post("/api/liabilities", json={"name": "x", "liability_type": "other", "current_balance": 5})
    assert r.json()["balance_as_of"] == "2026-10-04"


def test_computed_fields_for_golden_mortgage(client):
    body = client.post("/api/liabilities", json=mortgage_body(escrow_amount=500, origination_date="2026-10-01", term_months=360)).json()
    assert body["estimated_balance"] == pytest.approx(520000, abs=0.01)
    assert body["periods_remaining"] == 360
    assert body["payoff_date"] == "2056-10-01"
    assert body["monthly_payment"] == pytest.approx(3201.73, abs=0.01)
    assert body["monthly_cash_flow"] == pytest.approx(3701.73, abs=0.01)
    assert body["total_interest_remaining"] == pytest.approx(3201.73 * 360 - 520000, abs=5)
    assert body["maturity_date"] == "2056-10-01"
    assert body["last_reported_date"] == "2026-10-01"
    assert body["linked_position"] is None and body["expense"] is None
    assert body["linked_position_missing"] is False and body["expense_missing"] is False


def test_biweekly_monthly_payment_conversion(client):
    body = client.post(
        "/api/liabilities",
        json={"name": "x", "liability_type": "auto_loan", "current_balance": 10000, "interest_rate": 0.05,
              "payment_amount": 200, "payment_frequency": "biweekly", "next_payment_date": "2026-10-10"},
    ).json()
    assert body["monthly_payment"] == pytest.approx(200 * 26 / 12, abs=0.01)


def test_interest_only_never_pays_off(client):
    body = client.post(
        "/api/liabilities",
        json={"name": "h", "liability_type": "heloc", "current_balance": 100000, "interest_rate": 0.085, "payment_amount": 708.33},
    ).json()
    assert body["payoff_date"] is None and body["periods_remaining"] is None


@pytest.mark.parametrize(
    "patch",
    [
        {"current_balance": -1},
        {"current_balance": 1e11},
        {"interest_rate": 1.5},
        {"interest_rate": -0.1},
        {"liability_type": "boat"},
        {"term_months": 0},
        {"term_months": 601},
        {"name": ""},
        {"name": "x" * 121},
        {"payment_frequency": "daily"},
        {"balance_as_of": "not-a-date"},
        {"surprise": 1},
    ],
)
def test_create_validation_422_and_nothing_written(client, db, patch):
    before = counts(db)
    body = {"name": "x", "liability_type": "other", "current_balance": 10}
    body.update(patch)
    assert client.post("/api/liabilities", json=body).status_code == 422
    assert counts(db) == before


def test_create_response_is_only_the_resource(client):
    body = client.post("/api/liabilities", json=mortgage_body(property=None, cash_flow={"mode": "none"})).json()
    assert "property" not in body and "cash_flow" not in body and "source_detail" not in body
    assert body["id"] and body["name"] == "Home loan"


def test_property_create_makes_account_and_position(client, db):
    body = client.post(
        "/api/liabilities",
        json=mortgage_body(property={"mode": "create", "name": "Main St", "value": 700000, "cost_basis": 500000, "purchase_date": "2015-06-01"}),
    ).json()
    with db.get_session() as s:
        acct = s.query(Account).one()
        assert acct.name == "Real estate" and acct.account_type == "property" and acct.entity_id is None
        pos = s.query(Position).one()
        assert pos.position_type == "real_estate" and pos.asset_class == "alternative" and pos.account_id == acct.id
        assert pos.name == "Main St" and pos.current_price == 700000 and pos.shares == 1.0 and pos.cost_basis == 500000
        assert body["linked_position_id"] == pos.id
    assert body["linked_position"]["value"] == 700000
    # a second property reuses the account
    client.post("/api/liabilities", json=mortgage_body(property={"mode": "create", "name": "Cabin", "value": 1}))
    with db.get_session() as s:
        assert s.query(Account).count() == 1 and s.query(Position).count() == 2


def test_property_link_existing_and_missing(client, db):
    pos_id = seed_position(db)
    body = client.post("/api/liabilities", json=mortgage_body(property={"mode": "link", "position_id": pos_id})).json()
    assert body["linked_position"] == {"id": pos_id, "name": "Home", "value": 600000.0}
    before = counts(db)
    r = client.post("/api/liabilities", json=mortgage_body(property={"mode": "link", "position_id": "nope"}))
    assert r.status_code == 404
    assert counts(db) == before


def test_property_failure_rolls_back_created_rows(client, db, monkeypatch):
    before = counts(db)
    monkeypatch.setattr("src.liabilities.service._create_expense", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")))
    r = client.post(
        "/api/liabilities",
        json=mortgage_body(property={"mode": "create", "name": "p", "value": 1}, cash_flow={"mode": "create"}),
    )
    assert r.status_code == 500
    assert counts(db) == before


def test_cash_flow_create_mortgage_split(client, db):
    body = client.post(
        "/api/liabilities", json=mortgage_body(escrow_amount=500, cash_flow={"mode": "create"})
    ).json()
    with db.get_session() as s:
        exp = s.query(BudgetExpense).one()
        assert exp.id == body["expense_id"]
        assert exp.category_id == "cat-Housing"
        assert exp.name == "Home loan" and exp.frequency == "monthly"
        assert exp.amount == pytest.approx(3701.73, abs=0.005)
        assert exp.is_mortgage is True
        assert exp.interest_portion == pytest.approx(520000 * 0.0625 / 12, abs=0.01)
        assert exp.principal_portion == pytest.approx(3201.73 - 520000 * 0.0625 / 12, abs=0.01)
        assert exp.end_date.date() == date(2056, 10, 1)
    assert body["expense"]["monthly_amount"] == pytest.approx(3701.73, abs=0.01)


@pytest.mark.parametrize(
    "liability_type,category",
    [("auto_loan", "cat-Transportation"), ("student_loan", "cat-Debt Payments"), ("heloc", "cat-Housing")],
)
def test_cash_flow_category_by_type(client, db, liability_type, category):
    client.post(
        "/api/liabilities",
        json={"name": "d", "liability_type": liability_type, "current_balance": 1000, "interest_rate": 0.05,
              "payment_amount": 100, "next_payment_date": "2026-11-01", "cash_flow": {"mode": "create"}},
    )
    with db.get_session() as s:
        exp = s.query(BudgetExpense).one()
        assert exp.category_id == category and not exp.is_mortgage


def test_cash_flow_create_explicit_category(client, db):
    client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "create", "category_id": "cat-Other"}))
    with db.get_session() as s:
        assert s.query(BudgetExpense).one().category_id == "cat-Other"


def test_cash_flow_create_without_payment_is_422(client, db):
    before = counts(db)
    r = client.post("/api/liabilities", json={"name": "d", "liability_type": "other", "current_balance": 5, "cash_flow": {"mode": "create"}})
    assert r.status_code == 422
    assert counts(db) == before


def test_cash_flow_link_sets_mortgage_split(client, db):
    exp_id = seed_expense(db)
    body = client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "link", "expense_id": exp_id})).json()
    assert body["expense_id"] == exp_id
    with db.get_session() as s:
        exp = s.get(BudgetExpense, exp_id)
        assert exp.is_mortgage is True and exp.interest_portion and exp.principal_portion
        assert exp.amount == 1500.0  # link does not rewrite the user's amount
    before = counts(db)
    assert client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "link", "expense_id": "nope"})).status_code == 404
    assert counts(db) == before


def test_cash_flow_none_writes_no_expense(client, db):
    client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "none"}))
    assert counts(db)["expenses"] == 0


def make_with_expense(client):
    return client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "create"})).json()


def test_put_payment_syncs_expense_by_default(client, db):
    lid = make_with_expense(client)["id"]
    r = client.put(f"/api/liabilities/{lid}", json={"payment_amount": 3500})
    assert r.status_code == 200 and r.json()["payment_amount"] == 3500
    with db.get_session() as s:
        assert s.query(BudgetExpense).one().amount == pytest.approx(3500, abs=0.005)


def test_put_without_sync_leaves_expense(client, db):
    lid = make_with_expense(client)["id"]
    client.put(f"/api/liabilities/{lid}?sync_expense=false", json={"payment_amount": 3500})
    with db.get_session() as s:
        assert s.query(BudgetExpense).one().amount == pytest.approx(3201.73, abs=0.005)


def test_put_unrelated_field_does_not_touch_expense(client, db):
    lid = make_with_expense(client)["id"]
    with db.get_session() as s:
        s.query(BudgetExpense).one().amount = 1.0
        s.commit()
    client.put(f"/api/liabilities/{lid}", json={"notes": "hi", "lender": "Bank"})
    with db.get_session() as s:
        assert s.query(BudgetExpense).one().amount == 1.0


def test_put_archive_sets_closed_date_and_reactivate_clears(client):
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    body = client.put(f"/api/liabilities/{lid}", json={"is_active": False}).json()
    assert body["is_active"] is False and body["closed_date"] == "2026-10-04"
    assert body["estimated_balance"] == 0
    body = client.put(f"/api/liabilities/{lid}", json={"is_active": True}).json()
    assert body["closed_date"] is None


def test_put_404_and_validation(client):
    assert client.put("/api/liabilities/nope", json={"notes": "x"}).status_code == 404
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    assert client.put(f"/api/liabilities/{lid}", json={"interest_rate": 2}).status_code == 422
    assert client.put(f"/api/liabilities/{lid}", json={"current_balance": 1}).status_code == 422


def test_delete_keeps_expense_by_default(client, db):
    lid = make_with_expense(client)["id"]
    r = client.delete(f"/api/liabilities/{lid}")
    assert r.status_code == 200
    assert r.json() == {"deleted": True, "id": lid, "expense_deleted": False}
    c = counts(db)
    assert c["liabilities"] == 0 and c["snapshots"] == 0 and c["expenses"] == 1
    assert client.delete(f"/api/liabilities/{lid}").status_code == 404


def test_delete_with_expense(client, db):
    lid = make_with_expense(client)["id"]
    r = client.delete(f"/api/liabilities/{lid}?delete_expense=true")
    assert r.json()["expense_deleted"] is True
    assert counts(db)["expenses"] == 0


def test_record_balance_upserts_per_day_and_tracks_newest(client, db):
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]  # reported 2026-10-01
    r = client.post(f"/api/liabilities/{lid}/balance", json={"balance": 510000, "as_of": "2026-10-03"})
    assert r.status_code == 200
    assert r.json()["current_balance"] == 510000 and r.json()["balance_as_of"] == "2026-10-03"
    r = client.post(f"/api/liabilities/{lid}/balance", json={"balance": 509000, "as_of": "2026-10-03"})
    assert r.json()["current_balance"] == 509000
    with db.get_session() as s:
        assert s.query(LiabilityBalanceSnapshot).filter_by(liability_id=lid).count() == 2
    # older report: stored, but current balance unchanged
    r = client.post(f"/api/liabilities/{lid}/balance", json={"balance": 530000, "as_of": "2026-09-01"})
    assert r.json()["current_balance"] == 509000 and r.json()["balance_as_of"] == "2026-10-03"
    with db.get_session() as s:
        assert s.query(LiabilityBalanceSnapshot).filter_by(liability_id=lid).count() == 3
    # default as_of is today
    r = client.post(f"/api/liabilities/{lid}/balance", json={"balance": 500000})
    assert r.json()["balance_as_of"] == "2026-10-04"
    assert client.post(f"/api/liabilities/{lid}/balance", json={"balance": -5}).status_code == 422
    assert client.post("/api/liabilities/nope/balance", json={"balance": 5}).status_code == 404


def test_history_reported_and_monthly_series(client):
    lid = client.post(
        "/api/liabilities",
        json={"name": "c", "liability_type": "credit_card", "current_balance": 1000, "balance_as_of": "2026-07-15"},
    ).json()["id"]
    client.post(f"/api/liabilities/{lid}/balance", json={"balance": 1500, "as_of": "2026-09-10"})
    body = client.get(f"/api/liabilities/{lid}/history").json()
    assert [(p["date"], p["balance"]) for p in body["reported"]] == [("2026-07-15", 1000), ("2026-09-10", 1500)]
    dates = [p["date"] for p in body["series"]]
    assert dates == ["2026-07-31", "2026-08-31", "2026-09-30", "2026-10-04"]
    assert [p["balance"] for p in body["series"]] == [1000, 1000, 1500, 1500]
    assert client.get("/api/liabilities/nope/history").status_code == 404


def test_history_amortizing_series_declines(client):
    lid = client.post("/api/liabilities", json=mortgage_body(balance_as_of="2026-01-15", next_payment_date="2026-02-01")).json()["id"]
    series = client.get(f"/api/liabilities/{lid}/history").json()["series"]
    balances = [p["balance"] for p in series]
    assert balances == sorted(balances, reverse=True) and balances[-1] < balances[0]


def test_dangling_links_return_null_with_flags(client, db):
    pos_id = seed_position(db)
    exp_id = seed_expense(db)
    lid = client.post(
        "/api/liabilities",
        json=mortgage_body(property={"mode": "link", "position_id": pos_id}, cash_flow={"mode": "link", "expense_id": exp_id}),
    ).json()["id"]
    with db.get_session() as s:
        s.delete(s.get(Position, pos_id))
        s.delete(s.get(BudgetExpense, exp_id))
        s.commit()
    body = client.get(f"/api/liabilities/{lid}").json()
    assert body["linked_position"] is None and body["linked_position_missing"] is True
    assert body["expense"] is None and body["expense_missing"] is True


def test_list_filters_and_ordering(client):
    a = client.post("/api/liabilities", json={"name": "A", "liability_type": "other", "current_balance": 1, "entity_id": "e1"}).json()["id"]
    b = client.post("/api/liabilities", json={"name": "B", "liability_type": "other", "current_balance": 2}).json()["id"]
    client.put(f"/api/liabilities/{b}", json={"is_active": False})
    assert [x["id"] for x in client.get("/api/liabilities").json()] == [a]
    assert {x["id"] for x in client.get("/api/liabilities?include_archived=true").json()} == {a, b}
    assert [x["id"] for x in client.get("/api/liabilities?entity_id=e1").json()] == [a]
    assert client.get("/api/liabilities?entity_id=zzz").json() == []
    assert client.get("/api/liabilities/nope").status_code == 404


def test_demo_protection_refuses_writes(client, db, monkeypatch):
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    monkeypatch.delenv("PORTFOLIO_TEST_MODE", raising=False)
    monkeypatch.setenv("PORTFOLIO_DEMO_MODE", "true")
    monkeypatch.setenv("PROTECT_DEMO_DATA", "true")
    before = counts(db)
    assert client.post("/api/liabilities", json=mortgage_body()).status_code == 403
    assert client.put(f"/api/liabilities/{lid}", json={"notes": "x"}).status_code == 403
    assert client.delete(f"/api/liabilities/{lid}").status_code == 403
    assert client.post(f"/api/liabilities/{lid}/balance", json={"balance": 5}).status_code == 403
    assert counts(db) == before
    assert client.get(f"/api/liabilities/{lid}").status_code == 200


def test_no_balances_names_or_lenders_in_logs(client, caplog):
    caplog.set_level(logging.DEBUG)
    body = mortgage_body(current_balance=248000, name="SecretName", lender="SecretLender", cash_flow={"mode": "create"})
    lid = client.post("/api/liabilities", json=body).json()["id"]
    client.put(f"/api/liabilities/{lid}", json={"payment_amount": 1999.99})
    client.post(f"/api/liabilities/{lid}/balance", json={"balance": 247000})
    client.get(f"/api/liabilities/{lid}/history")
    client.post("/api/liabilities", json={"name": "x", "liability_type": "boat", "current_balance": 248000})
    client.delete(f"/api/liabilities/{lid}")
    text = "\n".join(r.getMessage() for r in caplog.records)
    for secret in ("248000", "247000", "1999.99", "SecretName", "SecretLender", "3201.73"):
        assert secret not in text


def test_put_null_or_zero_payment_with_sync_is_422_and_leaves_expense(client, db):
    lid = make_with_expense(client)["id"]
    with db.get_session() as s:
        before = s.query(BudgetExpense).one()
        snapshot = (before.amount, before.end_date, before.principal_portion)
    for bad in (None, 0):
        r = client.put(f"/api/liabilities/{lid}", json={"payment_amount": bad})
        assert r.status_code == 422
    with db.get_session() as s:
        exp = s.query(BudgetExpense).one()
        assert (exp.amount, exp.end_date, exp.principal_portion) == snapshot
        assert s.get(Liability, lid).payment_amount == 3201.73
    # without sync the payment can be cleared and the expense is untouched
    r = client.put(f"/api/liabilities/{lid}?sync_expense=false", json={"payment_amount": None})
    assert r.status_code == 200 and r.json()["payment_amount"] is None
    with db.get_session() as s:
        assert s.query(BudgetExpense).one().amount == snapshot[0]


def test_put_links_and_unlinks_expense_with_mortgage_split(client, db):
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    exp_id = seed_expense(db, amount=1500.0)
    body = client.put(f"/api/liabilities/{lid}", json={"expense_id": exp_id}).json()
    assert body["expense_id"] == exp_id
    with db.get_session() as s:
        exp = s.get(BudgetExpense, exp_id)
        assert exp.amount == 1500.0  # amount differs from the payment and is left alone
        assert exp.is_mortgage is True
        assert exp.interest_portion == pytest.approx(520000 * 0.0625 / 12, abs=0.01)
        assert exp.principal_portion == pytest.approx(3201.73 - 520000 * 0.0625 / 12, abs=0.01)
    body = client.put(f"/api/liabilities/{lid}", json={"expense_id": None}).json()
    assert body["expense_id"] is None and body["expense_missing"] is False
    assert client.put(f"/api/liabilities/{lid}", json={"expense_id": "nope"}).status_code == 404


def test_put_links_position_unlinks_and_404(client, db):
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    pos_id = seed_position(db)
    assert client.put(f"/api/liabilities/{lid}", json={"linked_position_id": pos_id}).json()["linked_position"]["id"] == pos_id
    assert client.put(f"/api/liabilities/{lid}", json={"linked_position_id": None}).json()["linked_position_id"] is None
    assert client.put(f"/api/liabilities/{lid}", json={"linked_position_id": "nope"}).status_code == 404


def test_expense_already_linked_elsewhere_is_409(client, db):
    exp_id = seed_expense(db)
    first = client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "link", "expense_id": exp_id}))
    assert first.status_code == 201
    before = counts(db)
    assert client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "link", "expense_id": exp_id})).status_code == 409
    assert counts(db) == before
    other = client.post("/api/liabilities", json=mortgage_body(name="Other")).json()["id"]
    assert client.put(f"/api/liabilities/{other}", json={"expense_id": exp_id}).status_code == 409
    # relinking the same expense to its own liability is fine
    assert client.put(f"/api/liabilities/{first.json()['id']}", json={"expense_id": exp_id}).status_code == 200


def test_unexpected_errors_become_fixed_500_without_leaking(client, db, caplog, monkeypatch):
    caplog.set_level(logging.DEBUG)
    lid = client.post("/api/liabilities", json=mortgage_body(current_balance=248000)).json()["id"]

    def boom(*a, **k):
        raise IntegrityError("INSERT INTO t VALUES (?)", {"balance": 248000, "name": "SecretName"}, Exception("UNIQUE 248000"))

    monkeypatch.setattr("src.liabilities.service._serialize", boom)
    calls = [
        lambda: client.post("/api/liabilities", json=mortgage_body(current_balance=248000, name="SecretName")),
        lambda: client.put(f"/api/liabilities/{lid}", json={"notes": "x"}),
        lambda: client.post(f"/api/liabilities/{lid}/balance", json={"balance": 248000}),
    ]
    for call in calls:
        r = call()
        assert r.status_code == 500 and r.json() == {"detail": "Could not save the liability"}
    monkeypatch.undo()
    monkeypatch.setattr("src.liabilities.service.LiabilityBalanceSnapshot", boom)
    r = client.delete(f"/api/liabilities/{lid}")
    assert r.status_code == 500 and r.json() == {"detail": "Could not save the liability"}
    for secret in ("248000", "SecretName", "Traceback"):
        assert secret not in caplog.text


def test_future_dates_are_422(client, db):
    before = counts(db)
    assert client.post("/api/liabilities", json=mortgage_body(balance_as_of="2026-10-05")).status_code == 422
    assert counts(db) == before
    lid = client.post("/api/liabilities", json=mortgage_body(balance_as_of="2026-10-04")).json()["id"]
    assert client.post(f"/api/liabilities/{lid}/balance", json={"balance": 1, "as_of": "2026-10-05"}).status_code == 422
    assert client.post(f"/api/liabilities/{lid}/balance", json={"balance": 1, "as_of": "2026-10-04"}).status_code == 200


@pytest.mark.parametrize("value", ["2026-10-01T00:00:00", "2026-10-01T00:00:00Z", "2026-10-01 00:00", "2026-02-30", "20261001", 20261001])
def test_datetimes_and_bad_days_rejected(client, db, value):
    before = counts(db)
    for field in ("balance_as_of", "next_payment_date", "origination_date", "maturity_date"):
        assert client.post("/api/liabilities", json=mortgage_body(**{field: value})).status_code == 422
    assert client.post("/api/liabilities", json=mortgage_body(property={"mode": "create", "name": "p", "value": 1, "purchase_date": value})).status_code == 422
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    assert client.post(f"/api/liabilities/{lid}/balance", json={"balance": 1, "as_of": value}).status_code == 422
    assert client.put(f"/api/liabilities/{lid}", json={"next_payment_date": value}).status_code == 422
    assert counts(db)["liabilities"] == before["liabilities"] + 1


def test_maturity_before_origination_is_422(client):
    body = mortgage_body(origination_date="2026-01-01", maturity_date="2025-12-31")
    assert client.post("/api/liabilities", json=body).status_code == 422
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    r = client.put(f"/api/liabilities/{lid}", json={"origination_date": "2026-01-01", "maturity_date": "2025-12-31"})
    assert r.status_code == 422
    assert client.post("/api/liabilities", json=mortgage_body(origination_date="2026-01-01", maturity_date="2026-01-01")).status_code == 201


def test_no_category_at_all_is_422_and_none_created(client, db):
    with db.get_session() as s:
        s.query(BudgetExpenseCategory).delete()
        s.commit()
    before = counts(db)
    assert client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "create"})).status_code == 422
    assert counts(db) == before
    with db.get_session() as s:
        assert s.query(BudgetExpenseCategory).count() == 0


def test_type_change_rederives_is_amortizing_unless_sent(client):
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    assert client.put(f"/api/liabilities/{lid}", json={"liability_type": "credit_card"}).json()["is_amortizing"] is False
    assert client.put(f"/api/liabilities/{lid}", json={"liability_type": "auto_loan"}).json()["is_amortizing"] is True
    r = client.put(f"/api/liabilities/{lid}", json={"liability_type": "credit_card", "is_amortizing": True})
    assert r.json()["is_amortizing"] is True
    assert client.put(f"/api/liabilities/{lid}", json={"notes": "n"}).json()["is_amortizing"] is True


def test_property_reuse_leaves_existing_positions_unchanged(client, db):
    pos_id = seed_position(db, value=600000.0)
    with db.get_session() as s:
        acct = s.query(Account).one()
        s.add(Position(account_id=acct.id, ticker="RE", name="Cabin", shares=1.0, current_price=90000.0, cost_basis=70000.0, position_type="real_estate"))
        s.commit()
        before = sorted((p.id, p.name, p.shares, p.current_price, p.cost_basis, p.position_type, p.asset_class) for p in s.query(Position))
    client.post("/api/liabilities", json=mortgage_body(property={"mode": "create", "name": "New", "value": 1000}))
    with db.get_session() as s:
        assert s.query(Account).count() == 1
        after = sorted((p.id, p.name, p.shares, p.current_price, p.cost_basis, p.position_type, p.asset_class) for p in s.query(Position) if p.name != "New")
        assert after == before
        assert s.query(Position).count() == 3
    assert pos_id in [a[0] for a in before]


def test_first_due_after_far_future_anchor():
    from src.liabilities.service import _first_due_after

    assert _first_due_after(date(2036, 10, 15), "monthly", TODAY) == date(2026, 10, 15)
    assert _first_due_after(date(2036, 10, 3), "monthly", TODAY) == date(2026, 11, 3)
    assert _first_due_after(date(2030, 10, 4), "biweekly", TODAY).toordinal() - TODAY.toordinal() in range(1, 15)
    assert _first_due_after(date(2040, 3, 1), "annual", TODAY) == date(2027, 3, 1)
    assert _first_due_after(date(2020, 1, 31), "monthly", TODAY) == date(2026, 10, 31)
    assert _first_due_after(None, "monthly", TODAY) == date(2026, 11, 4)


# Responses are built before the commit, so a failing response builder leaves nothing behind.

BUILDER_TABLES = ("liabilities", "liability_balance_snapshots", "positions", "accounts", "budget_expenses")


def _all_rows(tmp_path):
    import sqlite3

    conn = sqlite3.connect(str(tmp_path / "liab.db"))
    try:
        return {
            t: conn.execute(f"SELECT * FROM {t} ORDER BY id").fetchall()  # nosec B608 - fixed table names
            for t in BUILDER_TABLES
        }
    finally:
        conn.close()


def _break_builder(monkeypatch, name):
    def boom(*a, **k):
        raise IntegrityError("SELECT", {"balance": 248000}, Exception("248000"))

    monkeypatch.setattr(f"src.liabilities.service.{name}", boom)


def _assert_fixed_500(response):
    assert response.status_code == 500 and response.json() == {"detail": "Could not save the liability"}


def test_create_response_failure_persists_nothing(client, tmp_path, monkeypatch):
    before = _all_rows(tmp_path)
    _break_builder(monkeypatch, "_serialize")
    body = mortgage_body(property={"mode": "create", "name": "Home", "value": 600000}, cash_flow={"mode": "create"})
    _assert_fixed_500(client.post("/api/liabilities", json=body))
    assert _all_rows(tmp_path) == before


def test_update_response_failure_persists_nothing(client, tmp_path, monkeypatch):
    lid = client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "create"})).json()["id"]
    before = _all_rows(tmp_path)
    _break_builder(monkeypatch, "_serialize")
    _assert_fixed_500(client.put(f"/api/liabilities/{lid}", json={"payment_amount": 3500, "notes": "x"}))
    assert _all_rows(tmp_path) == before


def test_balance_response_failure_persists_nothing(client, tmp_path, monkeypatch):
    lid = client.post("/api/liabilities", json=mortgage_body()).json()["id"]
    before = _all_rows(tmp_path)
    _break_builder(monkeypatch, "_serialize")
    _assert_fixed_500(client.post(f"/api/liabilities/{lid}/balance", json={"balance": 519000}))
    assert _all_rows(tmp_path) == before


def test_delete_response_failure_persists_nothing(client, tmp_path, monkeypatch):
    lid = client.post("/api/liabilities", json=mortgage_body(cash_flow={"mode": "create"})).json()["id"]
    before = _all_rows(tmp_path)
    _break_builder(monkeypatch, "_delete_result")
    _assert_fixed_500(client.delete(f"/api/liabilities/{lid}?delete_expense=true"))
    assert _all_rows(tmp_path) == before
