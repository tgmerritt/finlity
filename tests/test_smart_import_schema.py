"""Migration safety for the smart import tables.

Every test works on a temp copy of the tracked demo database, never the
tracked file itself and never a real database.
"""

import hashlib
import re
import shutil
import sqlite3
from datetime import date
from pathlib import Path

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine
from sqlalchemy.exc import IntegrityError

from src.database import (
    Database,
    DatabaseManager,
    ImportTransaction,
    MerchantRule,
    SmartImportLedger,
    SmartImportMeta,
)

TRACKED_DEMO = Path(__file__).parent.parent / "data" / "demo" / "demo.db"
NEW_TABLES = ("smart_import_meta", "import_transactions", "merchant_rules", "smart_import_ledger")
REUSED_TABLES = ("bank_statement_imports", "recurring_candidates")
WRITE_RE = re.compile(r"^\s*(ALTER|DROP|UPDATE|DELETE|INSERT)\b", re.IGNORECASE)
CREATE_RE = re.compile(r"^\s*CREATE\b", re.IGNORECASE)

# Written out by hand; src/web/test/database/smart-import-schema.test.ts holds
# the same lists, so the two schemas are compared through these literals.
META_COLUMNS = [
    "import_id", "batch_id", "origin", "format", "parser", "account_kind",
    "account_key", "account_label", "account_last4", "institution",
    "period_start", "period_end", "closing_balance", "closing_balance_date",
    "liability_id", "txn_new", "txn_duplicate", "txn_excluded", "ai_used",
    "ai_provider", "created_at",
]
TXN_COLUMNS = [
    "id", "import_id", "entity_id", "account_key", "posted_date", "amount",
    "description", "merchant_key", "kind", "category_id", "category_source",
    "ai_confidence", "external_id", "dedupe_key", "created_at",
]
RULE_COLUMNS = ["id", "merchant_key", "category_id", "kind", "hits", "created_at", "updated_at"]
LEDGER_COLUMNS = [
    "id", "import_id", "action", "target_table", "target_id", "before_json",
    "after_json", "created_at",
]
COLUMNS = {
    "smart_import_meta": META_COLUMNS,
    "import_transactions": TXN_COLUMNS,
    "merchant_rules": RULE_COLUMNS,
    "smart_import_ledger": LEDGER_COLUMNS,
}
MODELS = {
    "smart_import_meta": SmartImportMeta,
    "import_transactions": ImportTransaction,
    "merchant_rules": MerchantRule,
    "smart_import_ledger": SmartImportLedger,
}
# index name -> (table, columns, unique)
INDEXES = {
    "ix_import_txn_import": ("import_transactions", ["import_id"], False),
    "ix_import_txn_date": ("import_transactions", ["posted_date"], False),
    "ix_import_txn_merchant": ("import_transactions", ["merchant_key"], False),
    "ux_import_txn_dedupe": ("import_transactions", ["dedupe_key"], True),
    "ux_merchant_rule_key": ("merchant_rules", ["merchant_key"], True),
    "ix_smart_import_ledger_import": ("smart_import_ledger", ["import_id"], False),
}


@pytest.fixture()
def demo_copy(tmp_path: Path) -> Path:
    dest = tmp_path / "demo-copy.db"
    shutil.copy2(TRACKED_DEMO, dest)
    return dest


def _fingerprint(path: Path) -> dict:
    """DDL and row hash of every non-new table, every non-new index's DDL, plus user_version."""
    con = sqlite3.connect(path)
    try:
        objects = con.execute(
            "SELECT type, name, tbl_name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ).fetchall()
        out: dict = {}
        for kind, name, tbl_name, sql in objects:
            if tbl_name in NEW_TABLES:
                continue
            if kind != "table":
                out[f"{kind}:{name}"] = sql
                continue
            h = hashlib.sha256()
            # Table names come from sqlite_master of a temp test copy, not input.
            query = f'SELECT * FROM "{name}" ORDER BY rowid'  # nosec B608
            for row in con.execute(query):
                h.update(repr(row).encode())
            out[name] = (sql, h.hexdigest())
        out["__user_version__"] = con.execute("PRAGMA user_version").fetchone()[0]
        return out
    finally:
        con.close()


def _table_names(path: Path) -> set[str]:
    con = sqlite3.connect(path)
    try:
        return {r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        con.close()


def _drop_new_tables(path: Path) -> None:
    """Test-only, on the copy: simulate a pre-upgrade database (drops the indexes too)."""
    con = sqlite3.connect(path)
    try:
        for table in NEW_TABLES:
            con.execute(f"DROP TABLE IF EXISTS {table}")
        con.commit()
    finally:
        con.close()


class _Recorder:
    def __init__(self, path: Path):
        self.needle = str(path)
        self.statements: list[str] = []

    def __call__(self, conn, cursor, statement, parameters, context, executemany):
        if self.needle in str(conn.engine.url):
            self.statements.append(statement)


# NOTE: this listener cannot vouch for the whole startup path. It does not
# cover _migrate_schema's pre-existing OCC-ticker UPDATE on option positions,
# which the tracked demo.db does not trigger.
def _open_recorded(path: Path) -> list[str]:
    rec = _Recorder(path)
    event.listen(Engine, "before_cursor_execute", rec)
    try:
        db = Database(str(path))
        db.engine.dispose()
    finally:
        event.remove(Engine, "before_cursor_execute", rec)
    return rec.statements


@pytest.fixture()
def pre_upgrade_copy(demo_copy: Path) -> Path:
    Database(str(demo_copy)).engine.dispose()  # bring to current schema
    _drop_new_tables(demo_copy)
    return demo_copy


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@pytest.fixture(scope="module", autouse=True)
def tracked_demo_untouched():
    before = _sha256(TRACKED_DEMO)
    yield
    assert _sha256(TRACKED_DEMO) == before, "tracked demo.db was modified by these tests"


def test_upgrade_adds_tables_without_touching_existing(pre_upgrade_copy: Path):
    before = _fingerprint(pre_upgrade_copy)
    assert not (set(NEW_TABLES) & _table_names(pre_upgrade_copy))
    assert set(REUSED_TABLES) <= _table_names(pre_upgrade_copy)
    assert all(t in before for t in REUSED_TABLES)

    statements = _open_recorded(pre_upgrade_copy)

    assert set(NEW_TABLES) <= _table_names(pre_upgrade_copy)
    assert _fingerprint(pre_upgrade_copy) == before
    offenders = [s for s in statements if WRITE_RE.match(s)]
    assert offenders == []


def test_indexes_exist_by_name(pre_upgrade_copy: Path):
    _open_recorded(pre_upgrade_copy)
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        for name, (table, cols, unique) in INDEXES.items():
            row = con.execute(
                "SELECT tbl_name FROM sqlite_master WHERE type='index' AND name=?", (name,)
            ).fetchone()
            assert row == (table,), name
            assert [r[2] for r in con.execute(f'PRAGMA index_info("{name}")')] == cols, name
            flags = {r[1]: r[2] for r in con.execute(f'PRAGMA index_list("{table}")')}
            assert flags[name] == (1 if unique else 0), name
        named = {
            r[0]
            for r in con.execute(
                "SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL "
                "AND tbl_name IN (?, ?, ?, ?)",
                NEW_TABLES,
            )
        }
        assert named == set(INDEXES)
    finally:
        con.close()


def test_new_table_columns_match_models(pre_upgrade_copy: Path):
    _open_recorded(pre_upgrade_copy)
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        for table, expected in COLUMNS.items():
            assert [r[1] for r in con.execute(f"PRAGMA table_info({table})")] == expected, table
            assert [c.name for c in MODELS[table].__table__.columns] == expected, table
    finally:
        con.close()


def test_column_types_and_defaults(pre_upgrade_copy: Path):
    _open_recorded(pre_upgrade_copy)
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        def info(table: str) -> dict:
            return {r[1]: (r[2], r[3], r[4]) for r in con.execute(f"PRAGMA table_info({table})")}

        meta = info("smart_import_meta")
        for col in ("period_start", "period_end", "closing_balance_date"):
            assert meta[col] == ("DATE", 0, None), col
        for col in ("txn_new", "txn_duplicate", "txn_excluded", "ai_used"):
            assert meta[col][1:] == (1, "0"), col
        assert meta["created_at"][0] == "DATETIME"
        txn = info("import_transactions")
        assert txn["posted_date"] == ("DATE", 1, None)
        assert txn["amount"][0] == "FLOAT"
        rules = info("merchant_rules")
        assert rules["hits"][1:] == (1, "0")
        # Soft references only: none of the new tables declares a foreign key.
        for table in NEW_TABLES:
            assert con.execute(f"PRAGMA foreign_key_list({table})").fetchall() == [], table
    finally:
        con.close()


def test_third_open_is_a_no_op(pre_upgrade_copy: Path):
    _open_recorded(pre_upgrade_copy)
    after_second = _fingerprint(pre_upgrade_copy)

    statements = _open_recorded(pre_upgrade_copy)

    assert [s for s in statements if CREATE_RE.match(s)] == []
    assert [s for s in statements if WRITE_RE.match(s)] == []
    assert _fingerprint(pre_upgrade_copy) == after_second


def test_manager_check_status_unchanged(pre_upgrade_copy: Path):
    before = DatabaseManager(pre_upgrade_copy).check().status
    _open_recorded(pre_upgrade_copy)
    assert DatabaseManager(pre_upgrade_copy).check().status == before


def test_unique_dedupe_key_and_merchant_key(pre_upgrade_copy: Path):
    db = Database(str(pre_upgrade_copy))
    try:
        with db.SessionLocal() as session:
            def txn(tid: str) -> ImportTransaction:
                return ImportTransaction(
                    id=tid, import_id="imp1", posted_date=date(2026, 10, 1), amount=-4.5,
                    description="COFFEE", merchant_key="COFFEE", kind="expense",
                    category_source="none", dedupe_key="acct:x|abc",
                )

            session.add(txn("t1"))
            session.commit()
            session.add(txn("t2"))
            with pytest.raises(IntegrityError, match="UNIQUE"):
                session.commit()
            session.rollback()

            session.add(MerchantRule(id="r1", merchant_key="COFFEE"))
            session.commit()
            session.add(MerchantRule(id="r2", merchant_key="COFFEE"))
            with pytest.raises(IntegrityError, match="UNIQUE"):
                session.commit()
            session.rollback()
    finally:
        db.engine.dispose()


def test_rows_roundtrip_with_calendar_days_and_defaults(pre_upgrade_copy: Path):
    db = Database(str(pre_upgrade_copy))
    try:
        with db.SessionLocal() as session:
            session.add(SmartImportMeta(
                import_id="imp1", batch_id="b1", origin="sample", format="csv", parser="csv",
                account_kind="checking", period_start=date(2026, 7, 1), period_end=date(2026, 9, 30),
                closing_balance_date=date(2026, 9, 30),
            ))
            session.add(ImportTransaction(
                id="t1", import_id="imp1", posted_date=date(2026, 9, 2), amount=-12.5,
                description="X", merchant_key="X", kind="expense", category_source="seed",
                dedupe_key="label:checking|d1",
            ))
            session.add(SmartImportLedger(
                id="l1", import_id="imp1", action="created", target_table="budget_expenses",
                target_id="e1", after_json="{}",
            ))
            session.add(MerchantRule(id="r1", merchant_key="X"))
            session.commit()
    finally:
        db.engine.dispose()
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        assert con.execute(
            "SELECT period_start, period_end, closing_balance_date, txn_new, txn_duplicate, "
            "txn_excluded, ai_used FROM smart_import_meta"
        ).fetchone() == ("2026-07-01", "2026-09-30", "2026-09-30", 0, 0, 0, 0)
        assert con.execute("SELECT posted_date FROM import_transactions").fetchone() == ("2026-09-02",)
        assert con.execute("SELECT hits FROM merchant_rules").fetchone() == (0,)
        assert con.execute("SELECT created_at IS NOT NULL FROM smart_import_ledger").fetchone() == (1,)
    finally:
        con.close()
