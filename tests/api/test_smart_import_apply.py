"""Smart import apply, transactions delete and spending summary (server path)."""

import logging
from datetime import date, datetime

import pytest

from src.database import Database
from src.database.models import (
    AppSettings,
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
from tests.api.si_support import (  # noqa: F401
    CONN_ID,
    HASH_A,
    HASH_B,
    HASH_C,
    TODAY,
    add_connection,
    add_connections,
    add_expense,
    add_liability,
    apply_body,
    candidate,
    client,
    connection_entry,
    db,
    do_apply,
    statement,
    table_hashes,
    txn,
)

D1, D2, D3 = date(2026, 9, 1), date(2026, 9, 8), date(2026, 9, 15)


def basic(file_hash=HASH_A, **kw):
    return statement(file_hash, [
        txn(D1, -15.49, "NETFLIX"),
        txn(D2, -42.10, "GROCER", category="cat-Groceries"),
        txn(D3, 2000.0, "PAYROLL", kind="income", category=None, source="none"),
        txn(D3, -9.0, "SKIPPED", excluded=True),
    ], **kw)


def count(db, model, **filters):
    with db.get_session() as s:
        return s.query(model).filter_by(**filters).count()


# ------------------------------------------------------------------- apply


def test_apply_writes_import_meta_and_transactions(client, db):
    r = do_apply(client, apply_body([basic()], entity_id="ent-1"))
    assert r.status_code == 200
    body = r.json()
    assert body["skipped_files"] == [] and body["pruned"] == 0
    assert body["rules_saved"] == 0 and body["expenses_created"] == 0 and body["expenses_linked"] == 0
    (imp,) = body["imports"]
    assert imp["file_hash"] == HASH_A and imp["balance"] == "none"
    assert (imp["txn_new"], imp["txn_duplicate"], imp["txn_excluded"]) == (3, 0, 1)
    with db.get_session() as s:
        bsi = s.get(BankStatementImport, imp["import_id"])
        assert (bsi.content_hash, bsi.status, bsi.row_count, bsi.file_name, bsi.entity_id) == (
            HASH_A, "applied", 3, "statement.csv", "ent-1")
        assert bsi.analyzed_at is not None
        meta = s.get(SmartImportMeta, imp["import_id"])
        assert (meta.batch_id, meta.origin, meta.format, meta.parser) == ("batch-1", "file", "csv", "csv")
        assert (meta.account_kind, meta.account_key, meta.account_label, meta.account_last4,
                meta.institution) == ("checking", "acct:one", "Main", "1234", "Sample Bank")
        assert (meta.txn_new, meta.txn_duplicate, meta.txn_excluded, meta.ai_used) == (3, 0, 1, 0)
        rows = s.query(ImportTransaction).order_by(ImportTransaction.posted_date).all()
        assert [r.merchant_key for r in rows] == ["NETFLIX", "GROCER", "PAYROLL"]
        assert all(r.entity_id == "ent-1" and r.import_id == imp["import_id"] and r.account_key == "acct:one"
                   for r in rows)
        assert rows[0].amount == -15.49 and rows[0].category_id == "cat-Dining"
        assert rows[0].category_source == "rule" and rows[0].posted_date == D1


def test_apply_stores_ai_fields_period_and_balance_columns(client, db):
    st = statement(HASH_A, [txn(D1, -1.0)], period={"start": "2026-09-01", "end": "2026-09-30"},
                   closing={"amount": 321.5, "as_of": "2026-09-30"}, ai_used=True, ai_provider="Claude")
    imp = do_apply(client, apply_body([st])).json()["imports"][0]
    with db.get_session() as s:
        m = s.get(SmartImportMeta, imp["import_id"])
        assert (m.ai_used, m.ai_provider) == (1, "Claude")
        assert (m.period_start, m.period_end) == (date(2026, 9, 1), date(2026, 9, 30))
        assert (m.closing_balance, m.closing_balance_date) == (321.5, date(2026, 9, 30))


def test_apply_truncates_stored_text(client, db):
    long_key = "ü" * 150
    st = statement(HASH_A, [txn(D1, -1.0, long_key, description="d" * 500)])
    st["account"]["last4"] = "98761234"
    assert do_apply(client, apply_body([st], rules=[{"merchant_key": long_key, "kind": "expense"}])).status_code == 200
    with db.get_session() as s:
        t = s.query(ImportTransaction).one()
        assert len(t.merchant_key) == 120 and len(t.description) == 120
        assert s.query(SmartImportMeta).one().account_last4 == "1234"
        assert len(s.query(MerchantRule).one().merchant_key) == 120


def test_apply_two_statements_get_separate_imports_and_indexed_hashes(client, db):
    a = statement(HASH_A, [txn(D1, -1.0, dedupe="k1")])
    b = statement(HASH_A, [txn(D2, -2.0, dedupe="k2")], key="acct:two")
    body = do_apply(client, apply_body([a, b])).json()
    assert len(body["imports"]) == 2
    with db.get_session() as s:
        hashes = sorted(r.content_hash for r in s.query(BankStatementImport).all())
    assert hashes == [HASH_A, HASH_A + ":1"]


def test_apply_same_dedupe_key_twice_in_a_request_counts_one_duplicate(client, db):
    st = statement(HASH_A, [txn(D1, -1.0, dedupe="same"), txn(D1, -1.0, dedupe="same")])
    imp = do_apply(client, apply_body([st])).json()["imports"][0]
    assert (imp["txn_new"], imp["txn_duplicate"]) == (1, 1)


def test_reapplying_the_same_batch_writes_nothing(client, db):
    body = apply_body([basic(HASH_A), basic(HASH_B)], rules=[{"merchant_key": "NETFLIX", "kind": "expense"}],
                      recurring=[candidate("create")])
    # same transactions in both files: the second file only holds duplicates
    first = do_apply(client, body).json()
    assert first["imports"][1]["txn_duplicate"] == 3
    before = table_hashes(db)
    again = do_apply(client, body).json()
    assert again["imports"] == [] and again["skipped_files"] == [HASH_A, HASH_B]
    assert again["rules_saved"] == 0 and again["expenses_created"] == 0 and again["pruned"] == 0
    assert table_hashes(db) == before


def test_overlapping_statement_adds_only_new_rows(client, db):
    do_apply(client, apply_body([basic(HASH_A)]))
    more = statement(HASH_B, [txn(D1, -15.49, "NETFLIX"), txn(date(2026, 9, 20), -5.0, "NEW")])
    imp = do_apply(client, apply_body([more], batch="batch-2")).json()["imports"][0]
    assert (imp["txn_new"], imp["txn_duplicate"]) == (1, 1)
    assert count(db, ImportTransaction) == 4


def test_apply_skips_a_file_hash_known_from_a_legacy_import(client, db):
    with db.get_session() as s:
        s.add(BankStatementImport(id="legacy", file_name="o.csv", content_hash=HASH_A, status="analyzed"))
        s.commit()
    body = do_apply(client, apply_body([basic(HASH_A)])).json()
    assert body["skipped_files"] == [HASH_A] and body["imports"] == []
    assert count(db, ImportTransaction) == 0


# -------------------------------------------------------------------- rules


def test_rules_are_upserted_with_source_and_last_import(client, db):
    with db.get_session() as s:
        s.add(MerchantRule(id="r-old", merchant_key="NETFLIX", category_id="cat-Other", kind="expense",
                           hits=4, source="import", updated_at=datetime(2020, 1, 1)))
        s.commit()
    rules = [
        {"merchant_key": "NETFLIX", "category_id": "cat-Dining", "kind": "expense"},
        {"merchant_key": "GROCER", "category_id": "cat-Groceries", "kind": "expense", "source": "ai"},
        {"merchant_key": "PAYROLL", "kind": "income"},
    ]
    body = do_apply(client, apply_body([basic()], rules=rules)).json()
    assert body["rules_saved"] == 3
    import_id = body["imports"][0]["import_id"]
    with db.get_session() as s:
        by = {r.merchant_key: r for r in s.query(MerchantRule).all()}
        n = by["NETFLIX"]
        assert (n.id, n.category_id, n.hits, n.source, n.last_import_id) == (
            "r-old", "cat-Dining", 5, "user", import_id)
        assert n.updated_at > datetime(2025, 1, 1)
        g = by["GROCER"]
        assert (g.hits, g.source, g.last_import_id) == (1, "ai", import_id)
        p = by["PAYROLL"]
        assert (p.category_id, p.kind, p.hits) == (None, "income", 1)


def test_rule_with_missing_category_is_refused_and_nothing_is_written(client, db):
    before = table_hashes(db)
    r = do_apply(client, apply_body([basic()], rules=[{"merchant_key": "X", "category_id": "nope"}]))
    assert r.status_code == 404
    assert r.json() == {"error_type": "category_not_found", "detail": "Category not found."}
    assert table_hashes(db) == before


# ---------------------------------------------------------------- recurring


def test_recurring_create_link_reject(client, db):
    add_expense(db, "E-exist", "Spotify", 10.0)
    rec = [
        candidate("create", "NETFLIX", name="Netflix", amount=15.49),
        candidate("link", "SPOTIFY", name="Spotify", amount=10.0, expense_id="E-exist"),
        candidate("reject", "GYM", name="Gym", amount=30.0, frequency="weekly"),
    ]
    body = do_apply(client, apply_body([basic()], recurring=rec, entity_id="ent-1")).json()
    assert (body["expenses_created"], body["expenses_linked"]) == (1, 1)
    import_id = body["imports"][0]["import_id"]
    with db.get_session() as s:
        cands = {c.name: c for c in s.query(RecurringCandidate).all()}
        assert {k: (c.status, c.import_id) for k, c in cands.items()} == {
            "Netflix": ("accepted", import_id), "Spotify": ("accepted", import_id),
            "Gym": ("rejected", import_id)}
        assert cands["Gym"].created_expense_id is None
        assert cands["Spotify"].created_expense_id == "E-exist"
        created = s.get(BudgetExpense, cands["Netflix"].created_expense_id)
        assert (created.name, created.amount, created.frequency, created.category_id, created.entity_id,
                created.is_active) == ("Netflix", 15.49, "monthly", "cat-Dining", "ent-1", True)
        assert cands["Netflix"].amount == 15.49 and cands["Netflix"].occurrences == 3
        ledger = {(l.action, l.target_table, l.target_id): l for l in s.query(SmartImportLedger).all()}
        key = ("created", "budget_expenses", created.id)
        assert key in ledger and ("linked", "budget_expenses", "E-exist") in ledger
        import json
        after = json.loads(ledger[key].after_json)
        assert set(after) == {"entity_id", "category_id", "name", "amount", "frequency", "is_pretax",
                              "is_mortgage", "principal_portion", "interest_portion", "is_active",
                              "start_date", "end_date", "updated_at"}
        assert after["name"] == "Netflix" and after["amount"] == 15.49 and after["entity_id"] == "ent-1"
        assert after["frequency"] == "monthly" and after["category_id"] == "cat-Dining"
        assert after["is_active"] is True and after["updated_at"] == created.updated_at.isoformat()
        assert ledger[key].before_json is None and ledger[key].import_id == import_id


def test_recurring_attaches_to_the_file_holding_the_latest_occurrence(client, db):
    body = apply_body([basic(HASH_A), basic(HASH_B)], recurring=[candidate("create", file_hash=HASH_B)])
    out = do_apply(client, body).json()
    second = next(i for i in out["imports"] if i["file_hash"] == HASH_B)["import_id"]
    with db.get_session() as s:
        assert s.query(RecurringCandidate).one().import_id == second


def test_recurring_from_a_skipped_file_attaches_to_the_first_new_import(client, db):
    do_apply(client, apply_body([basic(HASH_A)]))
    body = apply_body([basic(HASH_A), statement(HASH_B, [txn(D1, -1.0, dedupe="n1")])],
                      recurring=[candidate("create", file_hash=HASH_A)], batch="batch-2")
    out = do_apply(client, body).json()
    assert out["skipped_files"] == [HASH_A]
    with db.get_session() as s:
        assert s.query(RecurringCandidate).one().import_id == out["imports"][0]["import_id"]


def test_recurring_dropped_when_the_batch_creates_no_import(client, db):
    do_apply(client, apply_body([basic(HASH_A)]))
    before = table_hashes(db)
    out = do_apply(client, apply_body([basic(HASH_A)], recurring=[candidate("create")])).json()
    assert out["expenses_created"] == 0 and out["imports"] == []
    assert table_hashes(db) == before


@pytest.mark.parametrize("rec,status", [
    (candidate("link"), 422),
    (candidate("link", expense_id="missing"), 404),
    (candidate("create", category="nope"), 404),
    (candidate("create", frequency="daily"), 422),
    (candidate("maybe"), 422),
])
def test_recurring_validation(client, db, rec, status):
    before = table_hashes(db)
    assert do_apply(client, apply_body([basic()], recurring=[rec])).status_code == status
    assert table_hashes(db) == before


# ----------------------------------------------------------------- balances


def balance_body(closing, **kw):
    return apply_body([statement(HASH_A, [txn(D1, -1.0)], kind="credit_card", liability_id="L1",
                                 closing=closing, **kw)])


def test_balance_is_recorded_and_moves_the_liability(client, db):
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    out = do_apply(client, balance_body({"amount": 321.5, "as_of": "2026-09-30"})).json()
    assert out["imports"][0]["balance"] == "recorded"
    import_id = out["imports"][0]["import_id"]
    with db.get_session() as s:
        snap = s.query(LiabilityBalanceSnapshot).filter_by(source="import").one()
        assert (snap.liability_id, snap.snapshot_date, snap.balance, snap.source_ref) == (
            "L1", date(2026, 9, 30), 321.5, import_id)
        liab = s.get(Liability, "L1")
        assert (liab.current_balance, liab.balance_as_of) == (321.5, date(2026, 9, 30))
        import json
        ledger = {l.action: l for l in s.query(SmartImportLedger).all()}
        assert set(ledger) == {"snapshot", "balance_moved"}
        snap_row = ledger["snapshot"]
        assert (snap_row.target_table, snap_row.target_id, snap_row.before_json) == (
            "liability_balance_snapshots", snap.id, None)
        assert json.loads(snap_row.after_json) == {"liability_id": "L1", "snapshot_date": "2026-09-30",
                                                   "balance": 321.5}
        moved = ledger["balance_moved"]
        assert (moved.target_table, moved.target_id) == ("liabilities", "L1")
        before = json.loads(moved.before_json)
        assert set(before) == {"current_balance", "balance_as_of", "updated_at"}
        assert before["current_balance"] == 500.0 and before["balance_as_of"] == "2026-09-01"
        assert json.loads(moved.after_json) == {"current_balance": 321.5, "balance_as_of": "2026-09-30"}
        assert s.get(SmartImportMeta, import_id).liability_id == "L1"


def test_same_day_snapshot_is_kept_and_reported(client, db):
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 30))
    out = do_apply(client, balance_body({"amount": 321.5, "as_of": "2026-09-30"})).json()
    assert out["imports"][0]["balance"] == "skipped_existing"
    with db.get_session() as s:
        assert s.query(LiabilityBalanceSnapshot).count() == 1
        assert s.get(Liability, "L1").current_balance == 500.0
        assert s.query(SmartImportLedger).count() == 0
        assert s.query(SmartImportMeta).one().closing_balance == 321.5


def test_older_balance_inserts_a_snapshot_without_moving_the_liability(client, db):
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    out = do_apply(client, balance_body({"amount": 700.0, "as_of": "2026-08-15"})).json()
    assert out["imports"][0]["balance"] == "recorded"
    with db.get_session() as s:
        assert s.query(LiabilityBalanceSnapshot).count() == 2
        assert s.get(Liability, "L1").current_balance == 500.0
        assert [l.action for l in s.query(SmartImportLedger).all()] == ["snapshot"]


def test_future_balance_is_skipped(client, db):
    add_liability(db, "L1")
    out = do_apply(client, balance_body({"amount": 1.0, "as_of": "2026-10-05"})).json()
    assert out["imports"][0]["balance"] == "skipped_future"
    assert count(db, LiabilityBalanceSnapshot) == 1


def test_no_balance_without_a_liability_or_a_closing_balance(client, db):
    add_liability(db, "L1")
    a = statement(HASH_A, [txn(D1, -1.0, dedupe="1")], kind="credit_card",
                  closing={"amount": 5.0, "as_of": "2026-09-30"})
    b = statement(HASH_B, [txn(D1, -1.0, dedupe="2")], kind="credit_card", liability_id="L1")
    out = do_apply(client, apply_body([a, b])).json()
    assert [i["balance"] for i in out["imports"]] == ["none", "none"]
    assert count(db, LiabilityBalanceSnapshot) == 1


def test_negative_closing_balance_never_reaches_a_liability(client, db):
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    out = do_apply(client, balance_body({"amount": -25.0, "as_of": "2026-09-30"})).json()
    assert out["imports"][0]["balance"] == "none"
    with db.get_session() as s:
        assert s.query(LiabilityBalanceSnapshot).count() == 1
        assert s.get(Liability, "L1").current_balance == 500.0
        assert s.query(SmartImportMeta).one().closing_balance == -25.0
        assert s.query(SmartImportLedger).count() == 0


def test_link_needs_an_active_expense_in_the_same_entity_or_household(client, db):
    add_expense(db, "E-inactive", "Old", 5.0, active=False)
    add_expense(db, "E-other", "Theirs", 5.0, entity_id="ent-2")
    add_expense(db, "E-mine", "Mine", 5.0, entity_id="ent-1")
    add_expense(db, "E-house", "House", 5.0)
    before = table_hashes(db)
    for eid in ("E-inactive", "E-other"):
        rec = candidate("link", expense_id=eid)
        assert do_apply(client, apply_body([basic()], recurring=[rec], entity_id="ent-1")).status_code == 404
    assert table_hashes(db) == before
    rec = [candidate("link", "A", expense_id="E-mine"), candidate("link", "B", expense_id="E-house")]
    assert do_apply(client, apply_body([basic()], recurring=rec, entity_id="ent-1")).json()["expenses_linked"] == 2


def test_a_hash_with_a_new_later_statement_is_reported_only_in_imports(client, db):
    two = [statement(HASH_A, [txn(D1, -1.0, dedupe="p1")]),
           statement(HASH_A, [txn(D2, -2.0, dedupe="p2")], key="acct:two")]
    assert len(do_apply(client, apply_body(two)).json()["imports"]) == 2
    three = two + [statement(HASH_A, [txn(D3, -3.0, dedupe="p3")], key="acct:three")]
    out = do_apply(client, apply_body(three, batch="b2")).json()
    assert [i["file_hash"] for i in out["imports"]] == [HASH_A]
    assert out["skipped_files"] == []
    with db.get_session() as s:
        assert sorted(r.content_hash for r in s.query(BankStatementImport)) == [
            HASH_A, HASH_A + ":1", HASH_A + ":2"]


def test_unknown_liability_is_refused(client, db):
    before = table_hashes(db)
    r = do_apply(client, balance_body({"amount": 1.0, "as_of": "2026-09-30"}))
    assert r.status_code == 404
    assert r.json() == {"error_type": "liability_not_found", "detail": "Debt not found."}
    assert table_hashes(db) == before


# ------------------------------------------------------------------- atomic


FULL_RECURRING = [candidate("create"), candidate("reject", "GYM", name="Gym")]


def full_body():
    return apply_body(
        [basic(HASH_A), statement(HASH_B, [txn(D1, -3.0, dedupe="b1")], kind="credit_card",
                                  liability_id="L1", closing={"amount": 9.0, "as_of": "2026-09-30"})],
        rules=[{"merchant_key": "NETFLIX", "kind": "expense"}], recurring=FULL_RECURRING)


def test_failure_mid_apply_leaves_every_table_unchanged(client, db, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    add_liability(db, "L1")
    add_expense(db, "E1")
    before = table_hashes(db)

    def boom(*a, **k):
        raise RuntimeError("leak ZQXSECRET")

    monkeypatch.setattr("src.smart_import.service._add_ledger", boom)
    r = client.post("/api/smart-import/apply", json=full_body())
    assert r.status_code == 500
    assert r.json() == {"error_type": "save_failed", "detail": "The change could not be saved."}
    assert "ZQXSECRET" not in r.text
    assert "ZQXSECRET" not in "\n".join(x.getMessage() for x in caplog.records)
    assert table_hashes(db) == before


def test_failure_after_the_balance_move_rolls_back_liability_and_snapshots(client, db, monkeypatch, caplog):
    caplog.set_level(logging.DEBUG)
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    before = table_hashes(db)
    from src.smart_import import service
    real = service._add_ledger

    def boom_on_move(session, import_id, action, *a, **k):
        if action == "balance_moved":
            raise RuntimeError("leak ZQXSECRET")
        return real(session, import_id, action, *a, **k)

    monkeypatch.setattr(service, "_add_ledger", boom_on_move)
    r = do_apply(client, balance_body({"amount": 321.5, "as_of": "2026-09-30"}))
    assert r.status_code == 500 and "ZQXSECRET" not in r.text
    assert "ZQXSECRET" not in "\n".join(x.getMessage() for x in caplog.records)
    assert table_hashes(db) == before
    with db.get_session() as s:
        assert s.get(Liability, "L1").current_balance == 500.0
        assert s.query(LiabilityBalanceSnapshot).count() == 1


def test_failure_in_prune_leaves_every_table_unchanged(client, db, monkeypatch):
    add_liability(db, "L1")
    before = table_hashes(db)
    monkeypatch.setattr("src.smart_import.service._prune",
                        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("x")))
    assert client.post("/api/smart-import/apply", json=full_body()).status_code == 500
    assert table_hashes(db) == before


def test_apply_commits_once_everything_succeeds(client, db):
    add_liability(db, "L1")
    assert do_apply(client, full_body()).status_code == 200
    assert count(db, SmartImportMeta) == 2 and count(db, SmartImportLedger) > 0


# ----------------------------------------------------------- prune, delete


def set_retention(client, months):
    assert client.put("/api/smart-import/settings", json={"retention_months": months}).status_code == 200


def seed_old(db, origin="file", import_id="old-imp", days=(date(2022, 1, 5), date(2024, 10, 3), date(2024, 10, 4))):
    with db.get_session() as s:
        s.add(BankStatementImport(id=import_id, file_name="o.csv", content_hash=import_id, status="applied"))
        s.add(SmartImportMeta(import_id=import_id, batch_id="b0", origin=origin, format="csv", parser="csv",
                              account_kind="checking", account_key="acct:one"))
        for n, day in enumerate(days):
            s.add(ImportTransaction(import_id=import_id, account_key="acct:one", posted_date=day, amount=-1.0,
                                    description="OLD", merchant_key="OLD", kind="expense",
                                    category_source="none", dedupe_key=f"{import_id}|{n}"))
        s.commit()


def test_prune_deletes_older_than_retention_only_during_apply(client, db):
    seed_old(db)
    add_expense(db, "E1")
    add_liability(db, "L1")
    with db.get_session() as s:
        s.add(MerchantRule(id="r1", merchant_key="OLD", kind="expense", hits=1, source="user"))
        s.commit()
    # retention 24 months from 2026-10-04: cutoff 2024-10-04, rows before it go
    out = do_apply(client, apply_body([basic()])).json()
    assert out["pruned"] == 2
    with db.get_session() as s:
        left = sorted(t.posted_date for t in s.query(ImportTransaction).filter_by(import_id="old-imp"))
        assert left == [date(2024, 10, 4)]
        assert s.get(BudgetExpense, "E1") is not None and s.get(MerchantRule, "r1") is not None
        assert s.query(LiabilityBalanceSnapshot).count() == 1


def test_prune_never_touches_sample_imports(client, db):
    seed_old(db, origin="sample")
    out = do_apply(client, apply_body([basic()])).json()
    assert out["pruned"] == 0
    assert count(db, ImportTransaction, import_id="old-imp") == 3


def test_retention_zero_keeps_everything(client, db):
    seed_old(db)
    set_retention(client, 0)
    assert do_apply(client, apply_body([basic()])).json()["pruned"] == 0
    assert count(db, ImportTransaction, import_id="old-imp") == 3


def test_retention_cutoff_clamps_the_month_end(client, db, monkeypatch):
    monkeypatch.setattr("src.liabilities.clock.today", lambda: date(2026, 5, 31))
    seed_old(db, days=(date(2025, 5, 30), date(2025, 5, 31)))
    set_retention(client, 12)
    # one year back from 2026-05-31 is 2025-05-31: the 30th goes, the 31st stays
    out = do_apply(client, apply_body([statement(HASH_A, [txn(date(2026, 5, 1), -1.0)])])).json()
    assert out["pruned"] == 1
    with db.get_session() as s:
        assert [t.posted_date for t in s.query(ImportTransaction).filter_by(import_id="old-imp")] == [
            date(2025, 5, 31)]


def test_a_sample_statement_with_old_rows_is_not_pruned_by_its_own_apply(client, db):
    st = statement(HASH_A, [txn(date(2020, 1, 5), -1.0, dedupe="o1"), txn(D1, -2.0, dedupe="o2")], origin="sample")
    out = do_apply(client, apply_body([st])).json()
    assert out["pruned"] == 0 and out["imports"][0]["txn_new"] == 2
    assert count(db, ImportTransaction) == 2


def test_delete_transactions_only_removes_transactions(client, db):
    add_liability(db, "L1")
    do_apply(client, full_body())
    with db.get_session() as s:
        before = {
            "expenses": s.query(BudgetExpense).count(), "rules": s.query(MerchantRule).count(),
            "snaps": s.query(LiabilityBalanceSnapshot).count(), "imports": s.query(BankStatementImport).count(),
            "meta": s.query(SmartImportMeta).count(), "ledger": s.query(SmartImportLedger).count(),
            "cands": s.query(RecurringCandidate).count(), "txns": s.query(ImportTransaction).count()}
    assert before["txns"] > 0
    assert client.delete("/api/smart-import/transactions").json() == {"deleted": before["txns"]}
    with db.get_session() as s:
        after = {
            "expenses": s.query(BudgetExpense).count(), "rules": s.query(MerchantRule).count(),
            "snaps": s.query(LiabilityBalanceSnapshot).count(), "imports": s.query(BankStatementImport).count(),
            "meta": s.query(SmartImportMeta).count(), "ledger": s.query(SmartImportLedger).count(),
            "cands": s.query(RecurringCandidate).count(), "txns": s.query(ImportTransaction).count()}
    assert after == {**before, "txns": 0}
    assert client.delete("/api/smart-import/transactions").json() == {"deleted": 0}


# --------------------------------------------------------------- validation


@pytest.mark.parametrize("mutate", [
    lambda b: b.pop("batch_id"),
    lambda b: b.update(batch_id=""),
    lambda b: b.update(extra=1),
    lambda b: b.update(statements=[basic()] * 13),
    lambda b: b["statements"][0].update(origin="web"),
    lambda b: b["statements"][0].update(file_hash="bad hash"),
    lambda b: b["statements"][0]["account"].update(key=None),
    lambda b: b["statements"][0]["account"].update(kind="boat"),
    lambda b: b["statements"][0]["transactions"][0].update(posted_date="2026-09-01T10:00:00"),
    lambda b: b["statements"][0]["transactions"][0].update(amount="x"),
    lambda b: b["statements"][0]["transactions"][0].update(kind="gift"),
    lambda b: b["statements"][0]["transactions"][0].update(category_source="magic"),
    lambda b: b["statements"][0]["transactions"][0].update(dedupe_key=""),
    lambda b: b["statements"][0]["transactions"][0].update(unknown=1),
    lambda b: b["statements"][0].update(transactions=[txn(D1, -1.0, dedupe=f"k{n}") for n in range(10_001)]),
    lambda b: b.update(rules=[{"merchant_key": "X", "source": "bogus"}]),
    lambda b: b.update(rules=[{"merchant_key": ""}]),
    lambda b: b["statements"][0].update(closing_balance={"amount": 1e12, "as_of": "2026-09-30"}),
    # Strict like the browser parser: numbers must be JSON numbers, never strings or booleans.
    lambda b: b["statements"][0]["transactions"][0].update(ai_confidence="0.5"),
    lambda b: b["statements"][0]["transactions"][0].update(ai_confidence=True),
    lambda b: b.update(recurring=[candidate("create", amount="15.49")]),
    lambda b: b.update(recurring=[candidate("create", amount=True)]),
    lambda b: b.update(recurring=[dict(candidate("create"), occurrences="3")]),
    lambda b: b.update(recurring=[dict(candidate("create"), occurrences=2.5)]),
])
def test_apply_rejects_bad_requests_with_a_fixed_body(client, db, mutate):
    body = apply_body([basic()])
    mutate(body)
    before = table_hashes(db)
    r = do_apply(client, body)
    assert r.status_code == 422
    assert r.json() == {"error_type": "bad_request", "detail": "The request could not be read."}
    assert table_hashes(db) == before


def test_apply_with_no_statements_is_a_noop(client, db):
    out = do_apply(client, apply_body([])).json()
    assert out == {"imports": [], "skipped_files": [], "rules_saved": 0, "expenses_created": 0,
                   "expenses_linked": 0, "pruned": 0}


# ------------------------------------------------------------ demo, logging


def test_writes_refused_under_demo_protection(client, db, monkeypatch):
    add_liability(db, "L1")
    first = do_apply(client, apply_body([basic()])).json()["imports"][0]["import_id"]
    monkeypatch.delenv("PORTFOLIO_TEST_MODE", raising=False)
    monkeypatch.setenv("PORTFOLIO_DEMO_MODE", "true")
    monkeypatch.setenv("PROTECT_DEMO_DATA", "true")
    before = table_hashes(db)
    assert do_apply(client, apply_body([basic(HASH_B)])).status_code == 403
    assert client.delete(f"/api/smart-import/imports/{first}").status_code == 403
    assert client.delete("/api/smart-import/transactions").status_code == 403
    assert table_hashes(db) == before
    assert client.get("/api/budget/spending-summary").status_code == 200


def test_no_planted_values_in_logs(client, db, caplog):
    planted = "ZQXPLANTED WIDGETS"
    add_liability(db, "L1", name=planted)
    st = statement(HASH_C, [txn(D1, -4242.42, planted, description=planted)], kind="credit_card",
                   liability_id="L1", closing={"amount": 7777.77, "as_of": "2026-09-30"})
    st["file_name"] = "ZQXFILE.csv"
    st["account"]["label"] = planted
    caplog.set_level(logging.DEBUG)
    out = do_apply(client, apply_body([st], rules=[{"merchant_key": planted, "kind": "expense"}],
                                      recurring=[candidate("create", planted, name=planted, file_hash=HASH_C)]))
    assert out.status_code == 200
    do_apply(client, apply_body([st]))
    client.get("/api/budget/spending-summary")
    client.delete("/api/smart-import/transactions")
    client.delete(f"/api/smart-import/imports/{out.json()['imports'][0]['import_id']}")
    text = "\n".join(r.getMessage() for r in caplog.records)
    for secret in (planted, "ZQX", "4242", "7777", HASH_C):
        assert secret not in text


# ---------------------------------------------------------- spending summary


def seed_spending(db, entity="e1"):
    """Three covered months (Jul to Sep 2026) with known totals."""
    with db.get_session() as s:
        s.add(BankStatementImport(id="s1", file_name="s.csv", content_hash="s1", status="applied", entity_id=entity))
        s.add(SmartImportMeta(import_id="s1", batch_id="b", origin="file", format="csv", parser="csv",
                              account_kind="checking", account_key="acct:one",
                              period_start=date(2026, 7, 1), period_end=date(2026, 9, 30)))
        rows = [
            (date(2026, 7, 5), -300.0, "expense", "cat-Groceries"),
            (date(2026, 8, 5), -300.0, "fee", "cat-Groceries"),
            (date(2026, 9, 5), -300.0, "interest", "cat-Groceries"),
            (date(2026, 9, 9), 60.0, "refund", "cat-Groceries"),
            (date(2026, 9, 6), -90.0, "expense", "cat-Dining"),
            (date(2026, 9, 7), -30.0, "expense", None),
            (date(2026, 9, 8), -30.0, "expense", "cat-deleted"),
            (date(2026, 9, 10), -500.0, "payment", "cat-Debt Payments"),
            (date(2026, 9, 11), -500.0, "transfer", None),
            (date(2026, 9, 12), 3000.0, "income", None),
            (date(2026, 10, 2), -999.0, "expense", "cat-Dining"),  # current month: incomplete
            (date(2026, 6, 20), -999.0, "expense", "cat-Dining"),  # outside the covered months
        ]
        for n, (day, amount, kind, cat) in enumerate(rows):
            s.add(ImportTransaction(import_id="s1", entity_id=entity, account_key="acct:one", posted_date=day,
                                    amount=amount, description="X", merchant_key="X", kind=kind,
                                    category_id=cat, category_source="none", dedupe_key=f"sp|{n}"))
        s.commit()


def lines(body):
    return {c["category_name"]: c for c in body["categories"]}


def test_spending_summary_averages_over_covered_complete_months(client, db):
    seed_spending(db)
    add_expense(db, "p1", "Groceries plan", 100.0, "weekly", "cat-Groceries", entity_id="e1")
    add_expense(db, "p2", "Phone", 120.0, "annual", "cat-Dining", entity_id="e1")
    add_expense(db, "p3", "Gym", 30.0, "biweekly", "cat-Dining", entity_id="e1")
    add_expense(db, "p4", "Insurance", 300.0, "quarterly", "cat-Other", entity_id="e1")
    add_expense(db, "p5", "Old", 50.0, "monthly", "cat-Other", active=False)
    add_expense(db, "p6", "Once", 50.0, "one_time", "cat-Other")
    body = client.get("/api/budget/spending-summary?months=3").json()
    assert body["months_covered"] == 3 and body["months"] == ["2026-07", "2026-08", "2026-09"]
    by = lines(body)
    # refunds subtract: (300 + 300 + 300 - 60) / 3
    assert by["Groceries"]["actual_monthly"] == pytest.approx(280.0, abs=0.01)
    assert by["Groceries"]["planned_monthly"] == pytest.approx(100 * 52 / 12, abs=0.01)
    assert by["Groceries"]["difference"] == pytest.approx(280.0 - 100 * 52 / 12, abs=0.01)
    assert by["Dining"]["actual_monthly"] == pytest.approx(30.0, abs=0.01)
    assert by["Dining"]["planned_monthly"] == pytest.approx(120 / 12 + 30 * 26 / 12, abs=0.01)
    assert by["Uncategorized"]["actual_monthly"] == pytest.approx(20.0, abs=0.01)
    assert by["Uncategorized"]["category_id"] is None
    assert by["Other"]["planned_monthly"] == pytest.approx(100.0, abs=0.01)
    assert by["Other"]["actual_monthly"] == 0
    assert "Debt Payments" not in by
    assert body["totals"]["actual_monthly"] == pytest.approx(280 + 30 + 20, abs=0.01)


def test_spending_summary_uses_the_most_recent_n_months(client, db):
    seed_spending(db)
    body = client.get("/api/budget/spending-summary?months=1").json()
    assert body["months"] == ["2026-09"] and body["months_covered"] == 1
    # September: groceries 300 interest minus 60 refund
    assert lines(body)["Groceries"]["actual_monthly"] == pytest.approx(240.0, abs=0.01)


def test_spending_summary_entity_filter(client, db):
    seed_spending(db, entity="e1")
    add_expense(db, "p1", "Mine", 60.0, "monthly", "cat-Dining", entity_id="e1")
    add_expense(db, "p2", "Theirs", 80.0, "monthly", "cat-Dining", entity_id="e2")
    mine = client.get("/api/budget/spending-summary?entity_id=e1").json()
    assert lines(mine)["Dining"]["planned_monthly"] == 60.0 and mine["months_covered"] == 3
    other = client.get("/api/budget/spending-summary?entity_id=e2").json()
    assert other["months_covered"] == 0 and other["months"] == []
    assert lines(other)["Dining"]["planned_monthly"] == 80.0
    assert lines(other)["Dining"]["actual_monthly"] == 0


def test_spending_summary_coverage_from_transactions_when_period_unknown(client, db):
    with db.get_session() as s:
        s.add(BankStatementImport(id="s1", file_name="s.csv", content_hash="s1", status="applied"))
        s.add(SmartImportMeta(import_id="s1", batch_id="b", origin="sample", format="csv", parser="csv",
                              account_kind="checking", account_key="acct:one"))
        for n, day in enumerate([date(2026, 3, 3), date(2026, 3, 9), date(2026, 5, 2)]):
            s.add(ImportTransaction(import_id="s1", account_key="acct:one", posted_date=day, amount=-10.0,
                                    description="X", merchant_key="X", kind="expense", category_id="cat-Dining",
                                    category_source="none", dedupe_key=f"u{n}"))
        s.commit()
    body = client.get("/api/budget/spending-summary?months=3").json()
    assert body["months"] == ["2026-03", "2026-05"]
    assert lines(body)["Dining"]["actual_monthly"] == pytest.approx(15.0, abs=0.01)


def test_coverage_needs_a_stored_transaction_in_the_month(client, db):
    seed_spending(db)
    assert client.get("/api/budget/spending-summary").json()["months"] == ["2026-07", "2026-08", "2026-09"]
    with db.get_session() as s:  # a prune of the oldest rows
        s.query(ImportTransaction).filter(ImportTransaction.posted_date < date(2026, 8, 1)).delete()
        s.commit()
    assert client.get("/api/budget/spending-summary").json()["months"] == ["2026-08", "2026-09"]
    client.delete("/api/smart-import/transactions")
    empty = client.get("/api/budget/spending-summary").json()
    assert empty["months"] == [] and empty["months_covered"] == 0


def test_coverage_after_a_real_prune(client, db):
    seed_old(db, days=(date(2024, 1, 5), date(2026, 8, 5)))
    with db.get_session() as s:
        m = s.get(SmartImportMeta, "old-imp")
        m.period_start, m.period_end = date(2024, 1, 1), date(2026, 8, 31)
        s.commit()
    assert "2024-01" in client.get("/api/budget/spending-summary?months=24").json()["months"]
    do_apply(client, apply_body([basic()]))  # retention 24 months prunes January 2024
    assert "2024-01" not in client.get("/api/budget/spending-summary?months=24").json()["months"]


def test_spending_summary_empty(client):
    body = client.get("/api/budget/spending-summary").json()
    assert body == {"months_covered": 0, "months": [], "categories": [],
                    "totals": {"actual_monthly": 0, "planned_monthly": 0, "difference": 0}}


@pytest.mark.parametrize("query", ["months=0", "months=25", "months=x", "entity_id=" + "x" * 65])
def test_spending_summary_rejects_bad_query(client, query):
    r = client.get(f"/api/budget/spending-summary?{query}")
    assert r.status_code == 422 and r.json()["error_type"] == "bad_request"


# ------------------------------------------------- connection_id (plan B3)

BAD_REQUEST = {"error_type": "bad_request", "detail": "The request could not be read."}
NOT_FOUND = {"error_type": "connection_not_found", "detail": "Connection not found."}


def synced(file_hash=HASH_A, txns=None, *, cid=CONN_ID, **kw):
    """A connector statement as the wizard sends it after a sync."""
    body = statement(file_hash, txns if txns is not None else [txn(D1, -1.0)], origin="connector", **kw)
    body.update(format="connector", parser="connector:demo", file_name="Demo sync")
    if cid is not None:
        body["connection_id"] = cid
    return body


@pytest.mark.parametrize("make", [
    lambda: synced(cid=None),
    lambda: dict(statement(HASH_A, [txn(D1, -1.0)]), connection_id=CONN_ID),
    lambda: dict(statement(HASH_A, [txn(D1, -1.0)], origin="sample"), connection_id=CONN_ID),
    lambda: synced(cid=""),
    lambda: synced(cid="c" * 65),
    lambda: synced(cid=7),
])
def test_connection_id_goes_with_connector_origin_and_only_there(client, db, make):
    add_connection(db)
    before = table_hashes(db)
    r = do_apply(client, apply_body([make()]))
    assert r.status_code == 422
    assert r.json() == BAD_REQUEST
    assert table_hashes(db) == before


def test_file_statement_with_a_null_connection_id_is_accepted(client, db):
    r = do_apply(client, apply_body([dict(statement(HASH_A, [txn(D1, -1.0)]), connection_id=None)]))
    assert r.status_code == 200, r.text


@pytest.mark.parametrize("cid", [
    "11111111-2222-4333-8444-555555555555",  # well formed, not stored
    CONN_ID.upper(),  # stored ids are canonical lowercase
    "connections",  # never names a settings row
])
def test_unknown_connection_is_refused_and_nothing_is_written(client, db, cid):
    add_connection(db)
    before = table_hashes(db)
    r = do_apply(client, apply_body([synced(cid=cid)]))
    assert r.status_code == 404
    assert r.json() == NOT_FOUND
    assert table_hashes(db) == before


def test_connection_must_exist_with_no_connections_row(client, db):
    r = do_apply(client, apply_body([synced()]))
    assert (r.status_code, r.json()) == (404, NOT_FOUND)


def test_an_entry_the_store_would_drop_does_not_count(client, db):
    """The check reads the sanitized document, so an invalid entry is missing."""
    add_connections(db, {CONN_ID: connection_entry(provider="plaid")})
    r = do_apply(client, apply_body([synced()]))
    assert (r.status_code, r.json()) == (404, NOT_FOUND)


def test_unknown_connection_in_a_later_statement_refuses_the_whole_batch(client, db):
    add_connection(db)
    before = table_hashes(db)
    body = apply_body([
        synced(HASH_A, [txn(D1, -1.0, dedupe="1")]),
        synced(HASH_B, [txn(D1, -2.0, dedupe="2")], cid="11111111-2222-4333-8444-555555555555"),
    ])
    assert do_apply(client, body).status_code == 404
    assert table_hashes(db) == before


def test_apply_stores_the_connection_and_lists_it(client, db):
    add_connection(db)
    out = do_apply(client, apply_body([
        synced(HASH_A, [txn(D1, -1.0, dedupe="1")], period={"start": "2026-09-01", "end": "2026-10-04"}),
        statement(HASH_B, [txn(D1, -2.0, dedupe="2")]),
    ])).json()
    connector_id, file_id = (i["import_id"] for i in out["imports"])
    with db.get_session() as s:
        assert s.get(SmartImportMeta, connector_id).connection_id == CONN_ID
        assert s.get(SmartImportMeta, connector_id).origin == "connector"
        assert s.get(SmartImportMeta, file_id).connection_id is None
    rows = {r["import_id"]: r for r in client.get("/api/smart-import/imports").json()}
    assert rows[connector_id]["connection_id"] == CONN_ID
    assert rows[connector_id]["origin"] == "connector"
    assert rows[file_id]["connection_id"] is None


def test_undo_of_a_connector_import_is_unchanged(client, db):
    add_connection(db)
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    before = table_hashes(db)
    out = do_apply(client, apply_body([
        synced(HASH_A, [txn(D1, -1.0)], kind="credit_card", liability_id="L1",
               closing={"amount": 321.5, "as_of": "2026-09-30"}),
    ], rules=[{"merchant_key": "NETFLIX", "category_id": "cat-Dining", "source": "connector"}])).json()
    import_id = out["imports"][0]["import_id"]
    r = client.delete(f"/api/smart-import/imports/{import_id}")
    assert r.status_code == 200, r.text
    assert client.get("/api/smart-import/imports").json() == []
    after = table_hashes(db)
    for table in ("budget_expenses", "liability_balance_snapshots"):
        assert after[table] == before[table]
    with db.get_session() as s:
        for model in (ImportTransaction, SmartImportLedger, SmartImportMeta, BankStatementImport):
            assert s.query(model).count() == 0
        liab = s.get(Liability, "L1")
        assert (liab.current_balance, liab.balance_as_of) == (500.0, date(2026, 9, 1))
        # Undo keeps remembered merchants, as for a file import.
        assert s.query(MerchantRule).count() == 1


# Connector balances: a provider dates a balance by UTC, so the local day can be
# one behind it (A4 handoff). For origin 'connector' only, Apply treats a
# balance dated tomorrow as today's.


def test_connector_balance_dated_tomorrow_is_recorded_as_today(client, db):
    add_connection(db)
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    tomorrow = "2026-10-05"
    out = do_apply(client, apply_body([
        synced(kind="credit_card", liability_id="L1", closing={"amount": 321.5, "as_of": tomorrow}),
    ])).json()
    assert out["imports"][0]["balance"] == "recorded"
    import_id = out["imports"][0]["import_id"]
    with db.get_session() as s:
        snap = s.query(LiabilityBalanceSnapshot).filter_by(source="import").one()
        assert (snap.snapshot_date, snap.balance) == (TODAY, 321.5)
        liab = s.get(Liability, "L1")
        assert (liab.current_balance, liab.balance_as_of) == (321.5, TODAY)
        ledger = {x.action: x for x in s.query(SmartImportLedger).all()}
        import json
        assert json.loads(ledger["snapshot"].after_json)["snapshot_date"] == TODAY.isoformat()
        assert json.loads(ledger["balance_moved"].after_json)["balance_as_of"] == TODAY.isoformat()
        # The import keeps the provider's own date.
        assert s.get(SmartImportMeta, import_id).closing_balance_date == date(2026, 10, 5)
    assert client.delete(f"/api/smart-import/imports/{import_id}").status_code == 200
    with db.get_session() as s:
        liab = s.get(Liability, "L1")
        assert (liab.current_balance, liab.balance_as_of) == (500.0, date(2026, 9, 1))
        assert s.query(LiabilityBalanceSnapshot).count() == 1


def test_connector_balance_dated_tomorrow_keeps_a_snapshot_already_on_today(client, db):
    add_connection(db)
    add_liability(db, "L1", balance=500.0, as_of=TODAY)
    out = do_apply(client, apply_body([
        synced(kind="credit_card", liability_id="L1", closing={"amount": 321.5, "as_of": "2026-10-05"}),
    ])).json()
    assert out["imports"][0]["balance"] == "skipped_existing"
    assert count(db, LiabilityBalanceSnapshot) == 1


def test_connector_balance_two_days_ahead_is_still_skipped(client, db):
    add_connection(db)
    add_liability(db, "L1")
    out = do_apply(client, apply_body([
        synced(kind="credit_card", liability_id="L1", closing={"amount": 1.0, "as_of": "2026-10-06"}),
    ])).json()
    assert out["imports"][0]["balance"] == "skipped_future"
    assert count(db, LiabilityBalanceSnapshot) == 1


def test_file_balance_dated_tomorrow_is_still_skipped(client, db):
    add_liability(db, "L1")
    out = do_apply(client, balance_body({"amount": 1.0, "as_of": "2026-10-05"})).json()
    assert out["imports"][0]["balance"] == "skipped_future"
