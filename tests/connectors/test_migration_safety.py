"""Connections add no schema (design 7.3, plan B1).

Works on a temp copy of the tracked demo database, never the tracked file and
never a real database: open it twice, every pre-existing table's schema and
rows are unchanged, no statement writes, and the ``connections`` and
``connection_secret:<id>`` rows appear only after a store write.
"""

from __future__ import annotations

import hashlib
import re
import shutil
import sqlite3
from pathlib import Path

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import event
from sqlalchemy.engine import Engine

from src.connectors import store
from src.connectors.types import DemoCredentials
from src.database import Database

TRACKED_DEMO = Path(__file__).resolve().parents[2] / "data" / "demo" / "demo.db"
WRITE_RE = re.compile(r"^\s*(ALTER|DROP|UPDATE|DELETE|INSERT|CREATE)\b", re.IGNORECASE)
CID = "6f1c2b9e-3d4a-4b5c-8d7e-9f0a1b2c3d4e"


@pytest.fixture(autouse=True)
def _isolated(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for name in ("DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("SECRET_KEY", Fernet.generate_key().decode())
    fake_home = tmp_path / "home"
    fake_home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: fake_home))


@pytest.fixture(scope="module", autouse=True)
def tracked_demo_untouched():
    before = hashlib.sha256(TRACKED_DEMO.read_bytes()).hexdigest()
    yield
    assert hashlib.sha256(TRACKED_DEMO.read_bytes()).hexdigest() == before


@pytest.fixture()
def demo_copy(tmp_path: Path) -> Path:
    dest = tmp_path / "demo-copy.db"
    shutil.copy2(TRACKED_DEMO, dest)
    return dest


def _fingerprint(path: Path) -> dict:
    """DDL and a row hash of every table and index, plus user_version."""
    con = sqlite3.connect(path)
    try:
        out: dict = {}
        for kind, name, sql in con.execute(
            "SELECT type, name, sql FROM sqlite_master "
            "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name"
        ):
            if kind != "table":
                out[f"{kind}:{name}"] = sql
                continue
            h = hashlib.sha256()
            # Table names come from sqlite_master of a temp test copy, not input.
            query = f'SELECT * FROM "{name}" ORDER BY rowid'  # nosec B608
            count = 0
            for row in con.execute(query):
                count += 1
                h.update(repr(row).encode())
            out[name] = (sql, count, h.hexdigest())
        out["__user_version__"] = con.execute("PRAGMA user_version").fetchone()[0]
        return out
    finally:
        con.close()


def _connection_rows(path: Path) -> list[tuple]:
    con = sqlite3.connect(path)
    try:
        return con.execute(
            "SELECT key, encrypted FROM app_settings "
            "WHERE key = 'connections' OR key LIKE 'connection_secret:%' ORDER BY key"
        ).fetchall()
    finally:
        con.close()


def _open_recorded(path: Path) -> list[str]:
    needle = str(path)
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if needle in str(conn.engine.url):
            statements.append(statement)

    event.listen(Engine, "before_cursor_execute", record)
    try:
        db = Database(str(path))
        db.engine.dispose()
    finally:
        event.remove(Engine, "before_cursor_execute", record)
    return statements


# What the first open of the tracked demo.db may add: the project 3 smart import
# tables and their indexes (it predates them). Connections add nothing.
SMART_IMPORT_OBJECTS = {
    "smart_import_meta",
    "import_transactions",
    "merchant_rules",
    "smart_import_ledger",
    "index:ix_import_txn_import",
    "index:ix_import_txn_date",
    "index:ix_import_txn_merchant",
    "index:ux_import_txn_dedupe",
    "index:ux_merchant_rule_key",
    "index:ix_smart_import_ledger_import",
}
DATA_WRITE_RE = re.compile(r"^\s*(ALTER|DROP|UPDATE|DELETE|INSERT)\b", re.IGNORECASE)


def test_first_open_of_the_raw_copy_only_adds_smart_import_tables(demo_copy: Path):
    raw = _fingerprint(demo_copy)
    statements = _open_recorded(demo_copy)
    assert [s for s in statements if DATA_WRITE_RE.match(s)] == []
    after = _fingerprint(demo_copy)
    for name, value in raw.items():
        assert after.get(name) == value, name
    added = set(after) - set(raw)
    assert added <= SMART_IMPORT_OBJECTS
    assert not any("connection" in name for name in added)
    assert _connection_rows(demo_copy) == []


def test_opening_twice_changes_nothing_and_adds_no_rows(demo_copy: Path):
    Database(str(demo_copy)).engine.dispose()  # bring to the current schema
    before = _fingerprint(demo_copy)
    for _ in range(2):
        statements = _open_recorded(demo_copy)
        assert [s for s in statements if WRITE_RE.match(s)] == []
        assert _fingerprint(demo_copy) == before
    assert _connection_rows(demo_copy) == []


def test_rows_appear_only_after_a_write_and_nothing_else_changes(demo_copy: Path):
    Database(str(demo_copy)).engine.dispose()
    before = _fingerprint(demo_copy)

    db = Database(str(demo_copy))
    try:
        assert store.read_connections(db)["items"] == {}
        assert _connection_rows(demo_copy) == []
        doc = {
            "version": 1,
            "items": {
                CID: {
                    "provider": "demo",
                    "label": "Demo bank",
                    "created_at": "2026-10-06T09:00:00Z",
                    "status": "accounts_pending",
                    "accounts": {},
                }
            },
        }
        store.write_connections(db, doc)
        store.save_secret(db, CID, DemoCredentials())
    finally:
        db.engine.dispose()

    after = _fingerprint(demo_copy)
    changed = {k for k in before if before[k] != after.get(k)}
    assert changed == {"app_settings"}
    assert set(after) == set(before)
    assert _connection_rows(demo_copy) == [
        ("connection_secret:" + CID, 1),
        ("connections", 0),
    ]

    # Opening again keeps the rows and writes nothing.
    statements = _open_recorded(demo_copy)
    assert [s for s in statements if WRITE_RE.match(s)] == []
    assert _fingerprint(demo_copy) == after
