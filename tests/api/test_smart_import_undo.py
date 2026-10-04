"""Undo a smart import exactly, from its ledger (server path)."""

import logging
from datetime import date, datetime

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
    HASH_C,
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
    assert r.json() == {"undone": True, "kept": [], "reassigned": {"transactions": 0}, "deleted": {
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


def test_undo_legacy_unknown_and_already_undone_imports_are_404(client, db):
    seed(db)
    done, _ = applied(client, db)
    assert undo(client, done).status_code == 200
    with db.get_session() as s:
        s.add(BankStatementImport(id="legacy", file_name="o.csv", content_hash="h", status="analyzed"))
        s.commit()
    before = table_hashes(db)
    r = undo(client, "legacy")
    assert r.status_code == 404
    assert r.json() == {"error_type": "not_smart_import", "detail": "This is not a smart import."}
    for iid in ("nope", done):  # unknown, and undone a second time
        r = undo(client, iid)
        assert r.status_code == 404
        assert r.json() == {"error_type": "import_not_found",
                            "detail": "Import not found. It may have already been undone."}
    assert table_hashes(db) == before


def test_failed_undo_changes_nothing(client, db, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
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
    assert "ZQXSECRET" not in "\n".join(x.getMessage() for x in caplog.records)
    assert table_hashes(db) == before


def test_undo_then_reapply_imports_normally(client, db):
    seed(db)
    import_id, _ = applied(client, db)
    undo(client, import_id)
    again = do_apply(client, apply_body([statement(HASH_A, [txn(D1, -15.49)])]))
    assert again.json()["skipped_files"] == [] and again.json()["imports"][0]["txn_new"] == 1


# ------------------------------------------------- edited detection (every column)


@pytest.mark.parametrize("field,value", [
    ("entity_id", "ent-9"), ("start_date", datetime(2026, 1, 1)), ("end_date", datetime(2027, 1, 1)),
    ("is_pretax", True), ("is_mortgage", True), ("principal_portion", 5.0), ("interest_portion", 2.0)])
def test_undo_keeps_an_expense_edited_in_any_other_column(client, db, field, value):
    seed(db)
    import_id, expense_id = applied(client, db)
    with db.get_session() as s:
        setattr(s.get(BudgetExpense, expense_id), field, value)
        s.commit()
    out = undo(client, import_id).json()
    assert out["kept"] == [{"table": "budget_expenses", "id": expense_id, "reason": "edited"}]


def test_undo_keeps_an_expense_touched_with_no_visible_change(client, db):
    seed(db)
    import_id, expense_id = applied(client, db)
    with db.get_session() as s:
        s.get(BudgetExpense, expense_id).updated_at = datetime(2030, 1, 1)
        s.commit()
    assert undo(client, import_id).json()["kept"][0]["reason"] == "edited"


# ------------------------------------------------------- balances, retention


def test_manual_balance_on_an_older_day_after_the_import(client, db):
    seed(db)  # liability: 500 on 2026-09-01
    import_id, _ = applied(client, db)  # import records 321.5 on 2026-09-30 and moves the liability
    liab.record_balance(db, "L1", 410.0, date(2026, 9, 15))  # older than the import: no move
    with db.get_session() as s:
        row = s.get(Liability, "L1")
        assert (row.current_balance, row.balance_as_of) == (321.5, date(2026, 9, 30))
    assert undo(client, import_id).status_code == 200
    with db.get_session() as s:
        row = s.get(Liability, "L1")
        # the newest remaining snapshot is the manual one of the 15th
        assert (row.current_balance, row.balance_as_of) == (410.0, date(2026, 9, 15))


def test_undo_after_the_transactions_were_deleted_or_pruned(client, db):
    seed(db)
    import_id, expense_id = applied(client, db)
    client.delete("/api/smart-import/transactions")
    out = undo(client, import_id).json()
    assert out["deleted"]["transactions"] == 0 and out["deleted"]["expenses"] == 1
    other, _ = applied(client, db, file_hash=HASH_B, recurring=(), batch="b2")
    with db.get_session() as s:
        s.query(ImportTransaction).delete()
        s.commit()
    assert undo(client, other).status_code == 200
    with db.get_session() as s:
        assert s.query(SmartImportLedger).count() == 0 and s.query(SmartImportMeta).count() == 0


# --------------------------------------------- overlapping imports (claimed rows)


def overlap(client):
    """A holds k1..k3; B overlaps on k2 and k3 and adds k4."""
    a = statement(HASH_A, [txn(D1, -1.0, "M1", dedupe="k1"), txn(D1, -2.0, "M2", dedupe="k2"),
                           txn(D2, -3.0, "M3", dedupe="k3")])
    b = statement(HASH_B, [txn(D1, -2.0, "M2", dedupe="k2"), txn(D2, -3.0, "M3", dedupe="k3"),
                           txn(D2, -4.0, "M4", dedupe="k4")])
    ia = do_apply(client, apply_body([a])).json()["imports"][0]
    ib = do_apply(client, apply_body([b], batch="b2")).json()["imports"][0]
    assert (ib["txn_new"], ib["txn_duplicate"]) == (1, 2)
    return ia["import_id"], ib["import_id"]


def owners(db):
    with db.get_session() as s:
        return {t.dedupe_key: t.import_id for t in s.query(ImportTransaction).all()}


def claims(db):
    with db.get_session() as s:
        return sorted((c.import_id, c.target_id) for c in s.query(SmartImportLedger).filter_by(action="claimed"))


def test_apply_ledgers_a_claim_for_each_overlapping_row(client, db):
    ia, ib = overlap(client)
    with db.get_session() as s:
        ids = {t.dedupe_key: t.id for t in s.query(ImportTransaction).all()}
        rows = s.query(SmartImportLedger).filter_by(action="claimed").all()
        assert sorted(r.target_id for r in rows) == sorted([ids["k2"], ids["k3"]])
        assert all(r.import_id == ib and r.target_table == "import_transactions" and r.before_json is None
                   for r in rows)
        import json
        assert sorted(json.loads(r.after_json)["dedupe_key"] for r in rows) == ["k2", "k3"]


def test_undo_of_the_first_import_hands_overlapping_rows_to_the_second(client, db):
    ia, ib = overlap(client)
    before = client.get("/api/budget/spending-summary?months=1").json()["totals"]["actual_monthly"]
    assert before == 10.0  # k1..k4
    out = undo(client, ia).json()
    assert out["deleted"]["transactions"] == 1 and out["reassigned"] == {"transactions": 2}
    assert owners(db) == {"k2": ib, "k3": ib, "k4": ib}
    assert claims(db) == []
    with db.get_session() as s:
        meta = s.get(SmartImportMeta, ib)
        assert (meta.txn_new, meta.txn_duplicate) == (3, 0)
        assert s.get(BankStatementImport, ib).row_count == 3
    # only A's own row (k1, 1.0) is gone; everything B holds still counts
    assert client.get("/api/budget/spending-summary?months=1").json()["totals"]["actual_monthly"] == 9.0


def test_undo_second_then_first_deletes_everything(client, db):
    ia, ib = overlap(client)
    out = undo(client, ib).json()
    assert out["deleted"]["transactions"] == 1 and out["reassigned"] == {"transactions": 0}
    assert owners(db) == {"k1": ia, "k2": ia, "k3": ia}
    assert claims(db) == []
    assert undo(client, ia).json()["deleted"]["transactions"] == 3
    assert owners(db) == {}


def test_undo_hands_over_to_the_newest_claimer_then_the_next(client, db):
    ia, ib = overlap(client)
    c = statement(HASH_C, [txn(D1, -2.0, "M2", dedupe="k2")])
    ic = do_apply(client, apply_body([c], batch="b3")).json()["imports"][0]["import_id"]
    undo(client, ia)
    assert owners(db)["k2"] == ic and owners(db)["k3"] == ib
    assert claims(db) == [(ib, owners_row(db, "k2"))]
    undo(client, ic)
    assert owners(db)["k2"] == ib
    assert claims(db) == []
    undo(client, ib)
    assert owners(db) == {}


def owners_row(db, key):
    with db.get_session() as s:
        return s.query(ImportTransaction).filter_by(dedupe_key=key).one().id


def test_reapplying_the_first_file_after_undoing_it(client, db):
    ia, ib = overlap(client)
    undo(client, ia)
    a = statement(HASH_A, [txn(D1, -1.0, "M1", dedupe="k1"), txn(D1, -2.0, "M2", dedupe="k2"),
                           txn(D2, -3.0, "M3", dedupe="k3")])
    again = do_apply(client, apply_body([a], batch="b4")).json()
    assert again["skipped_files"] == []
    imp = again["imports"][0]
    assert (imp["txn_new"], imp["txn_duplicate"]) == (1, 2)
    assert owners(db)["k1"] == imp["import_id"] and owners(db)["k2"] == ib
    # and undoing B now hands k2, k3 to the re-applied A
    undo(client, ib)
    assert owners(db) == {"k1": imp["import_id"], "k2": imp["import_id"], "k3": imp["import_id"]}


def test_claims_between_statements_of_one_request_and_within_one_statement(client, db):
    a = statement(HASH_A, [txn(D1, -1.0, dedupe="k1"), txn(D1, -1.0, dedupe="k1")])
    b = statement(HASH_B, [txn(D1, -1.0, dedupe="k1")], key="acct:two")
    out = do_apply(client, apply_body([a, b])).json()["imports"]
    assert (out[0]["txn_new"], out[0]["txn_duplicate"]) == (1, 1)
    assert claims(db) == [(out[1]["import_id"], owners_row(db, "k1"))]  # no claim for the same import
    undo(client, out[0]["import_id"])
    assert owners(db) == {"k1": out[1]["import_id"]}
