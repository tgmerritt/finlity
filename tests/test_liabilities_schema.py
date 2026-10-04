"""Migration safety for the liabilities tables.

Every test works on a temp copy of the tracked demo database, never the
tracked file itself and never a real database.
"""

import hashlib
import re
import shutil
import sqlite3
from pathlib import Path

import pytest
from sqlalchemy import event
from sqlalchemy.engine import Engine

from src.database import Database, DatabaseManager

TRACKED_DEMO = Path(__file__).parent.parent / "data" / "demo" / "demo.db"
NEW_TABLES = ("liabilities", "liability_balance_snapshots")
WRITE_RE = re.compile(r"^\s*(ALTER|DROP|UPDATE|DELETE|INSERT)\b", re.IGNORECASE)
CREATE_RE = re.compile(r"^\s*CREATE\b", re.IGNORECASE)

LIABILITY_COLUMNS = [
    "id", "entity_id", "name", "liability_type", "lender", "current_balance",
    "balance_as_of", "interest_rate", "payment_amount", "payment_frequency",
    "next_payment_date", "escrow_amount", "original_principal", "origination_date",
    "term_months", "maturity_date", "credit_limit", "is_amortizing",
    "linked_position_id", "expense_id", "source", "source_ref", "source_detail",
    "is_active", "closed_date", "notes", "created_at", "updated_at",
]
SNAPSHOT_COLUMNS = ["id", "liability_id", "snapshot_date", "balance", "source", "source_ref", "created_at"]


@pytest.fixture()
def demo_copy(tmp_path: Path) -> Path:
    dest = tmp_path / "demo-copy.db"
    shutil.copy2(TRACKED_DEMO, dest)
    return dest


def _fingerprint(path: Path) -> dict:
    """DDL and row hash of every non-new table, plus user_version."""
    con = sqlite3.connect(path)
    try:
        tables = con.execute(
            "SELECT name, sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
        ).fetchall()
        out: dict = {}
        for name, sql in tables:
            if name in NEW_TABLES:
                continue
            h = hashlib.sha256()
            for row in con.execute(f'SELECT * FROM "{name}" ORDER BY rowid'):
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
    """Test-only, on the copy: simulate a pre-upgrade database."""
    con = sqlite3.connect(path)
    try:
        con.execute("DROP TABLE IF EXISTS liability_balance_snapshots")
        con.execute("DROP TABLE IF EXISTS liabilities")
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

    statements = _open_recorded(pre_upgrade_copy)

    assert set(NEW_TABLES) <= _table_names(pre_upgrade_copy)
    assert _fingerprint(pre_upgrade_copy) == before
    offenders = [s for s in statements if WRITE_RE.match(s)]
    assert offenders == []


def test_unique_snapshot_day_index_exists(pre_upgrade_copy: Path):
    _open_recorded(pre_upgrade_copy)
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        unique_cols = []
        for _, idx_name, unique, *_ in con.execute("PRAGMA index_list(liability_balance_snapshots)"):
            if unique:
                cols = [r[2] for r in con.execute(f'PRAGMA index_info("{idx_name}")')]
                unique_cols.append(cols)
        assert ["liability_id", "snapshot_date"] in unique_cols
        ddl = con.execute("SELECT sql FROM sqlite_master WHERE name='liability_balance_snapshots'").fetchone()[0]
        assert "ux_liability_snapshot_day" in ddl
    finally:
        con.close()


def test_new_table_columns(pre_upgrade_copy: Path):
    _open_recorded(pre_upgrade_copy)
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        assert [r[1] for r in con.execute("PRAGMA table_info(liabilities)")] == LIABILITY_COLUMNS
        assert [r[1] for r in con.execute("PRAGMA table_info(liability_balance_snapshots)")] == SNAPSHOT_COLUMNS
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


def test_re_position_is_not_converted_on_open(pre_upgrade_copy: Path):
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        account_id = con.execute("SELECT id FROM accounts LIMIT 1").fetchone()[0]
        con.execute(
            "INSERT INTO positions (id, account_id, ticker, name, shares, cost_basis, current_price, "
            "asset_class, position_type) VALUES ('re-1', ?, 'RE', 'Home', 1, 300000, 450000, "
            "'alternative', 'real_estate')",
            (account_id,),
        )
        con.commit()
    finally:
        con.close()

    _open_recorded(pre_upgrade_copy)

    con = sqlite3.connect(pre_upgrade_copy)
    try:
        assert con.execute("SELECT COUNT(*) FROM liabilities").fetchone()[0] == 0
        assert con.execute("SELECT COUNT(*) FROM positions WHERE id='re-1' AND ticker='RE'").fetchone()[0] == 1
    finally:
        con.close()


def test_date_columns_and_snapshot_roundtrip(pre_upgrade_copy: Path):
    _open_recorded(pre_upgrade_copy)
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        types = {r[1]: r[2] for r in con.execute("PRAGMA table_info(liabilities)")}
        for col in ("balance_as_of", "next_payment_date", "origination_date", "maturity_date", "closed_date"):
            assert types[col] == "DATE", col
        assert types["created_at"] == "DATETIME" and types["updated_at"] == "DATETIME"
        snap = {r[1]: r[2] for r in con.execute("PRAGMA table_info(liability_balance_snapshots)")}
        assert snap["snapshot_date"] == "DATE"
    finally:
        con.close()


def test_same_day_snapshot_hits_unique_constraint_and_stores_calendar_day(pre_upgrade_copy: Path):
    from datetime import date

    from src.database import LiabilityBalanceSnapshot, Liability

    db = Database(str(pre_upgrade_copy))
    try:
        with db.SessionLocal() as session:
            session.add(Liability(id="l1", name="M", liability_type="mortgage", current_balance=1.0,
                                  balance_as_of=date(2026, 10, 1), is_amortizing=True))
            session.add(LiabilityBalanceSnapshot(id="s1", liability_id="l1", snapshot_date=date(2026, 10, 1), balance=1.0))
            session.commit()
            session.add(LiabilityBalanceSnapshot(id="s2", liability_id="l1", snapshot_date=date(2026, 10, 1), balance=2.0))
            with pytest.raises(Exception, match="UNIQUE"):
                session.commit()
            session.rollback()
    finally:
        db.engine.dispose()
    con = sqlite3.connect(pre_upgrade_copy)
    try:
        assert con.execute("SELECT snapshot_date FROM liability_balance_snapshots").fetchone()[0] == "2026-10-01"
        assert con.execute("SELECT balance_as_of FROM liabilities").fetchone()[0] == "2026-10-01"
    finally:
        con.close()
