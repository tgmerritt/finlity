"""Undo a smart import exactly, from its ledger (server path)."""

import logging
from datetime import date

import pytest

from src.database.models import (
    BankStatementImport,
    BudgetExpense,
    ImportTransaction,
    Liability,
    LiabilityBalanceSnapshot,
    MerchantRule,
    RecurringCandidate,
    SmartImportLedger,
    SmartImportMeta,
)
from src.liabilities import service as liab
from tests.api.si_support import (  # noqa: F401
    HASH_A,
    HASH_B,
    TODAY,
    add_expense,
    add_liability,
    apply_body,
    candidate,
    client,
    db,
    do_apply,
    statement,
    table_hashes,
    txn,
)

D1, D2 = date(2026, 9, 1), date(2026, 9, 8)
CLOSING = {"amount": 321.5, "as_of": "2026-09-30"}


def applied(client, db, *, with_card=True, recurring=("create",), file_hash=HASH_A, batch="b1"):
    """Apply one credit card statement; returns (import_id, created_expense_id or None)."""
    st = statement(file_hash, [txn(D1, -15.49), txn(D2, -9.0, "GROCER", category="cat-Groceries")],
                   kind="credit_card", liability_id="L1" if with_card else None,
                   closing=CLOSING if with_card else None)
    rec = []
    if "create" in recurring:
        rec.append(candidate("create", file_hash=file_hash))
    if "link" in recurring:
        rec.append(candidate("link", "SPOTIFY", name="Spotify", expense_id="E-link", file_hash=file_hash))
    if "reject" in recurring:
        rec.append(candidate("reject", "GYM", name="Gym", file_hash=file_hash))
    body = do_apply(client, apply_body([st], rules=[{"merchant_key": "NETFLIX", "kind": "expense"}],
                                       recurring=rec, batch=batch))
    assert body.status_code == 200, body.text
    import_id = body.json()["imports"][0]["import_id"]
    with db.get_session() as s:
        cand = s.query(RecurringCandidate).filter_by(import_id=import_id, status="accepted",
                                                     name="Netflix").first()
        return import_id, (cand.created_expense_id if cand else None)


def undo(client, import_id):
    return client.delete(f"/api/smart-import/imports/{import_id}")


def seed(db):
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    add_expense(db, "E-link", "Spotify", 10.0)


def test_undo_removes_everything_the_import_created(client, db):
    seed(db)
    baseline = table_hashes(db)
    import_id, expense_id = applied(client, db, recurring=("create", "link", "reject"))
    assert expense_id
    r = undo(client, import_id)
    assert r.status_code == 200
    assert r.json() == {"undone": True, "kept": [], "deleted": {
        "transactions": 2, "recurring_candidates": 3, "expenses": 1, "snapshots": 1}}
    with db.get_session() as s:
        for model in (ImportTransaction, RecurringCandidate, SmartImportLedger, SmartImportMeta,
                      BankStatementImport):
            assert s.query(model).count() == 0
        assert s.get(BudgetExpense, expense_id) is None
        liab_row = s.get(Liability, "L1")
        assert (liab_row.current_balance, liab_row.balance_as_of) == (500.0, date(2026, 9, 1))
        # the remembered rule and the linked expense stay
        assert s.query(MerchantRule).count() == 1
        assert s.get(BudgetExpense, "E-link") is not None
        assert s.query(LiabilityBalanceSnapshot).count() == 1
    after = table_hashes(db)
    for table in ("budget_expenses", "liability_balance_snapshots"):
        assert after[table] == baseline[table]
    assert undo(client, import_id).status_code == 404


def test_undo_keeps_an_edited_expense(client, db):
    seed(db)
    import_id, expense_id = applied(client, db)
    with db.get_session() as s:
        s.get(BudgetExpense, expense_id).amount = 19.99
        s.commit()
    out = undo(client, import_id).json()
    assert out["kept"] == [{"table": "budget_expenses", "id": expense_id, "reason": "edited"}]
    assert out["deleted"]["expenses"] == 0
    with db.get_session() as s:
        assert s.get(BudgetExpense, expense_id).amount == 19.99
        assert s.query(RecurringCandidate).count() == 0


@pytest.mark.parametrize("field,value", [
    ("name", "Netflix HD"), ("frequency", "annual"), ("category_id", "cat-Other"), ("is_active", False)])
def test_undo_keeps_an_expense_edited_in_any_compared_field(client, db, field, value):
    seed(db)
    import_id, expense_id = applied(client, db)
    with db.get_session() as s:
        setattr(s.get(BudgetExpense, expense_id), field, value)
        s.commit()
    assert undo(client, import_id).json()["kept"][0]["reason"] == "edited"


def test_undo_keeps_an_expense_a_debt_now_links(client, db):
    seed(db)
    add_liability(db, "L2", "Car loan", ltype="auto_loan")
    import_id, expense_id = applied(client, db)
    with db.get_session() as s:
        s.get(Liability, "L2").expense_id = expense_id
        s.commit()
    out = undo(client, import_id).json()
    assert out["kept"] == [{"table": "budget_expenses", "id": expense_id, "reason": "linked_to_debt"}]
    with db.get_session() as s:
        assert s.get(BudgetExpense, expense_id) is not None


def test_undo_keeps_an_expense_another_import_links(client, db):
    seed(db)
    first, expense_id = applied(client, db)
    st = statement(HASH_B, [txn(D1, -1.0, dedupe="o1")])
    rec = [candidate("link", expense_id=expense_id, file_hash=HASH_B)]
    assert do_apply(client, apply_body([st], recurring=rec, batch="b2")).status_code == 200
    out = undo(client, first).json()
    assert out["kept"] == [{"table": "budget_expenses", "id": expense_id, "reason": "used_by_other_import"}]


def test_undo_skips_a_created_expense_the_user_already_deleted(client, db):
    seed(db)
    import_id, expense_id = applied(client, db)
    with db.get_session() as s:
        s.delete(s.get(BudgetExpense, expense_id))
        s.commit()
    out = undo(client, import_id).json()
    assert out["kept"] == [] and out["deleted"]["expenses"] == 0


def test_undo_never_touches_a_linked_expense_even_if_edited(client, db):
    seed(db)
    import_id, _ = applied(client, db, recurring=("link",))
    with db.get_session() as s:
        s.get(BudgetExpense, "E-link").amount = 99.0
        s.commit()
    out = undo(client, import_id).json()
    assert out["kept"] == []
    with db.get_session() as s:
        assert s.get(BudgetExpense, "E-link").amount == 99.0


def test_undo_after_a_later_manual_balance_keeps_that_balance(client, db):
    seed(db)
    import_id, _ = applied(client, db)
    liab.record_balance(db, "L1", 250.0, date(2026, 10, 2))
    assert undo(client, import_id).status_code == 200
    with db.get_session() as s:
        row = s.get(Liability, "L1")
        assert (row.current_balance, row.balance_as_of) == (250.0, date(2026, 10, 2))
        assert {x.source for x in s.query(LiabilityBalanceSnapshot).all()} == {"manual"}


def test_undo_recomputes_the_balance_from_the_newest_remaining_snapshot(client, db):
    seed(db)
    liab.record_balance(db, "L1", 480.0, date(2026, 9, 10))
    import_id, _ = applied(client, db)
    undo(client, import_id)
    with db.get_session() as s:
        row = s.get(Liability, "L1")
        assert (row.current_balance, row.balance_as_of) == (480.0, date(2026, 9, 10))


def test_undo_keeps_a_snapshot_the_user_overwrote(client, db):
    seed(db)
    import_id, _ = applied(client, db)
    liab.record_balance(db, "L1", 300.0, date(2026, 9, 30))  # same day: record_balance overwrites
    out = undo(client, import_id).json()
    with db.get_session() as s:
        snap = s.query(LiabilityBalanceSnapshot).filter_by(snapshot_date=date(2026, 9, 30)).one()
    assert out["kept"] == [{"table": "liability_balance_snapshots", "id": snap.id, "reason": "edited"}]
    assert out["deleted"]["snapshots"] == 0
    with db.get_session() as s:
        row = s.get(Liability, "L1")
        assert (row.current_balance, row.balance_as_of) == (300.0, date(2026, 9, 30))


def test_undo_restores_from_the_ledger_when_no_snapshot_remains(client, db):
    seed(db)
    with db.get_session() as s:
        s.query(LiabilityBalanceSnapshot).delete()
        s.commit()
    import_id, _ = applied(client, db)
    undo(client, import_id)
    with db.get_session() as s:
        row = s.get(Liability, "L1")
        assert (row.current_balance, row.balance_as_of) == (500.0, date(2026, 9, 1))


def test_undo_with_the_liability_deleted_is_fine(client, db):
    seed(db)
    import_id, _ = applied(client, db)
    with db.get_session() as s:
        s.query(LiabilityBalanceSnapshot).delete()
        s.delete(s.get(Liability, "L1"))
        s.commit()
    assert undo(client, import_id).status_code == 200


def test_undo_only_removes_that_imports_rows(client, db):
    seed(db)
    first, _ = applied(client, db, recurring=())
    second = do_apply(client, apply_body([statement(HASH_B, [txn(D1, -1.0, dedupe="x1")])],
                                         batch="b2")).json()["imports"][0]["import_id"]
    undo(client, first)
    with db.get_session() as s:
        assert [t.import_id for t in s.query(ImportTransaction).all()] == [second]
        assert s.query(SmartImportMeta).one().import_id == second


def test_undo_legacy_and_unknown_imports_are_404(client, db):
    with db.get_session() as s:
        s.add(BankStatementImport(id="legacy", file_name="o.csv", content_hash="h", status="analyzed"))
        s.commit()
    before = table_hashes(db)
    for iid in ("legacy", "nope"):
        r = undo(client, iid)
        assert r.status_code == 404
        assert r.json() == {"error_type": "not_smart_import", "detail": "This is not a smart import."}
    assert table_hashes(db) == before


def test_failed_undo_changes_nothing(client, db, monkeypatch):
    seed(db)
    import_id, _ = applied(client, db)
    before = table_hashes(db)

    def boom(*a, **k):
        raise RuntimeError("leak ZQXSECRET")

    monkeypatch.setattr("src.smart_import.service._restore_liability_balance", boom)
    r = undo(client, import_id)
    assert r.status_code == 500
    assert r.json() == {"error_type": "save_failed", "detail": "The change could not be saved."}
    assert "ZQXSECRET" not in r.text
    assert table_hashes(db) == before


def test_undo_then_reapply_imports_normally(client, db):
    seed(db)
    import_id, _ = applied(client, db)
    undo(client, import_id)
    again = do_apply(client, apply_body([statement(HASH_A, [txn(D1, -15.49)])]))
    assert again.json()["skipped_files"] == [] and again.json()["imports"][0]["txn_new"] == 1
