"""Demo history regeneration: the demo portfolio always has a year of daily
snapshots ending yesterday (UTC), so every chart range has data."""
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from src.database.models import Account, PortfolioSnapshot, Position
from src.database.operations import Database
from src.services.demo_history import ensure_recent_demo_history

_REPO_ROOT = Path(__file__).parent.parent


@pytest.fixture
def demo_db(tmp_path, monkeypatch):
    """A Database backed by a temporary copy of the tracked demo.db.

    Never operate on the repo's data/demo/demo.db directly: tests must not
    modify the committed fixture.

    ensure_recent_demo_history refuses to touch any database that isn't
    (resolvably) the demo manager's demo_db_path, so this fixture points the
    singleton demo manager's path at the temp copy for the test's duration.
    monkeypatch reverts it automatically on teardown, so other tests keep
    seeing the real (session-shared) demo db.
    """
    src_db = _REPO_ROOT / "data" / "demo" / "demo.db"
    dst_db = tmp_path / "demo.db"
    shutil.copy2(src_db, dst_db)

    from src.services.demo_mode import get_demo_manager

    monkeypatch.setattr(get_demo_manager(), "demo_db_path", dst_db)

    return Database(db_path=str(dst_db))


def _snapshot_dates(db):
    with db.get_session() as session:
        return sorted(s.snapshot_date.date() for s in session.query(PortfolioSnapshot).all())


def test_generates_a_year_ending_yesterday(demo_db):
    today = date(2026, 9, 30)
    written = ensure_recent_demo_history(demo_db, today=today)
    dates = _snapshot_dates(demo_db)
    assert written == 365
    assert dates[-1] == today - timedelta(days=1)
    assert dates[0] == today - timedelta(days=365)
    assert len(dates) == len(set(dates)) == 365


def test_last_snapshot_matches_current_portfolio_totals(demo_db):
    today = date(2026, 9, 30)
    ensure_recent_demo_history(demo_db, today=today)
    with demo_db.get_session() as session:
        last = session.query(PortfolioSnapshot).order_by(PortfolioSnapshot.snapshot_date.desc()).first()
    current_total = sum(p.market_value for p in demo_db.get_all_positions())
    assert abs(last.total_value - current_total) < 0.01
    assert abs((last.retirement_value + last.taxable_value) - last.total_value) < 0.01


def test_history_has_a_steady_upward_trend(demo_db):
    """The oldest snapshot sits one fixed +8% annual return below today's value."""
    ensure_recent_demo_history(demo_db, today=date(2026, 9, 30))
    with demo_db.get_session() as session:
        first = session.query(PortfolioSnapshot).order_by(PortfolioSnapshot.snapshot_date).first()
    current_total = sum(p.market_value for p in demo_db.get_all_positions())
    expected = current_total / 1.08
    assert abs(first.total_value - expected) / expected < 0.005


def test_is_a_no_op_when_history_is_current(demo_db):
    today = date(2026, 9, 30)
    ensure_recent_demo_history(demo_db, today=today)
    assert ensure_recent_demo_history(demo_db, today=today) == 0


def test_is_deterministic(demo_db):
    today = date(2026, 9, 30)
    ensure_recent_demo_history(demo_db, today=today)
    with demo_db.get_session() as session:
        first = [s.total_value for s in session.query(PortfolioSnapshot).order_by(PortfolioSnapshot.snapshot_date)]
    with demo_db.get_session() as session:
        session.query(PortfolioSnapshot).delete()
        session.commit()
    ensure_recent_demo_history(demo_db, today=today)
    with demo_db.get_session() as session:
        second = [s.total_value for s in session.query(PortfolioSnapshot).order_by(PortfolioSnapshot.snapshot_date)]
    assert first == second


def test_snapshot_dates_are_utc_midnight(demo_db):
    ensure_recent_demo_history(demo_db, today=date(2026, 9, 30))
    with demo_db.get_session() as session:
        s = session.query(PortfolioSnapshot).first()
    assert s.snapshot_date == datetime(s.snapshot_date.year, s.snapshot_date.month, s.snapshot_date.day)


def test_refuses_to_run_on_non_demo_database(tmp_path):
    """A database that isn't the demo manager's demo_db_path must never be
    touched, even if PORTFOLIO_DEMO_MODE is set. app.state.demo_mode (env
    derived) and get_demo_manager().is_enabled (on-disk state) can disagree;
    if the lifespan hook ever calls this against a real profile database in
    that situation, it must be a no-op rather than deleting real history."""
    db_path = tmp_path / "not_demo.db"
    db = Database(db_path=str(db_path))
    with db.get_session() as session:
        account = Account(name="Real Taxable", account_type="taxable")
        session.add(account)
        session.flush()
        session.add(
            Position(
                account_id=account.id,
                ticker="VTI",
                shares=10.0,
                current_price=200.0,
            )
        )
        session.add(
            PortfolioSnapshot(
                snapshot_date=datetime(2020, 1, 1),
                total_value=100.0,
                retirement_value=50.0,
                taxable_value=50.0,
                positions_json=None,
            )
        )
        session.commit()

    written = ensure_recent_demo_history(db, today=date(2026, 9, 30))

    assert written == 0
    with db.get_session() as session:
        remaining = session.query(PortfolioSnapshot).all()
    assert len(remaining) == 1
    assert remaining[0].snapshot_date == datetime(2020, 1, 1)
    assert remaining[0].total_value == 100.0


# --- demo liabilities kept current -------------------------------------------


def _build_liabilities(db):
    import importlib.util

    spec = importlib.util.spec_from_file_location("bdl", _REPO_ROOT / "scripts" / "build_demo_liabilities.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert module.main(["--db", str(db.db_path)]) == 0


def _liability_state(db):
    from src.database.models import Liability, LiabilityBalanceSnapshot

    with db.get_session() as session:
        liabs = [
            (row.id, row.current_balance, row.balance_as_of)
            for row in session.query(Liability).order_by(Liability.id).all()
        ]
        snaps = [
            (s.liability_id, s.snapshot_date, s.balance, s.source)
            for s in session.query(LiabilityBalanceSnapshot).order_by(
                LiabilityBalanceSnapshot.liability_id, LiabilityBalanceSnapshot.snapshot_date
            )
        ]
    return liabs, snaps


def test_stale_history_rewrites_demo_liability_snapshots(demo_db):
    from src.services.demo_liabilities import demo_liability_snapshots

    _build_liabilities(demo_db)
    today = date(2027, 3, 15)  # far enough ahead that every snapshot date moves
    ensure_recent_demo_history(demo_db, today=today)
    liabs, snaps = _liability_state(demo_db)
    expected = demo_liability_snapshots(today - timedelta(days=1))
    assert snaps == [
        (r["liability_id"], r["snapshot_date"], r["balance"], "demo")
        for r in sorted(expected, key=lambda r: (r["liability_id"], r["snapshot_date"]))
    ]
    assert len(snaps) == 36
    assert max(s[1] for s in snaps) == date(2027, 2, 28)
    by_id = {item[0]: item for item in liabs}
    for lid in ("demo-mortgage", "demo-auto", "demo-card"):
        last = [r for r in expected if r["liability_id"] == lid][-1]
        assert by_id[lid][1] == last["balance"]
        assert by_id[lid][2] == last["snapshot_date"]


def test_current_history_writes_nothing_to_liabilities(demo_db):
    from sqlalchemy import event

    _build_liabilities(demo_db)
    today = date(2026, 10, 4)
    ensure_recent_demo_history(demo_db, today=today)
    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(demo_db.engine, "before_cursor_execute", record)
    try:
        assert ensure_recent_demo_history(demo_db, today=today) == 0
    finally:
        event.remove(demo_db.engine, "before_cursor_execute", record)
    writes = [s for s in statements if s.lstrip().upper().startswith(("INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER"))]
    assert writes == []


def test_non_demo_database_gets_zero_liability_writes(tmp_path):
    """Startup runs this against the owner's real database. A SQL listener, not
    row counts, proves nothing is written to either liability table."""
    from sqlalchemy import event

    from src.database.models import Liability, LiabilityBalanceSnapshot

    path = tmp_path / "real.db"
    db = Database(db_path=str(path))
    with db.get_session() as session:
        account = Account(name="Real Taxable", account_type="taxable")
        session.add(account)
        session.flush()
        session.add(Position(account_id=account.id, ticker="VTI", shares=10.0, current_price=200.0))
        session.add(
            Liability(
                id="demo-mortgage",  # even a row that shares a demo id must be left alone
                name="Real loan",
                liability_type="mortgage",
                current_balance=1000.0,
                balance_as_of=date(2020, 1, 1),
                is_amortizing=True,
            )
        )
        session.add(
            LiabilityBalanceSnapshot(liability_id="demo-mortgage", snapshot_date=date(2020, 1, 1), balance=1000.0)
        )
        session.commit()
    before = _liability_state(db)

    statements = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(db.engine, "before_cursor_execute", record)
    try:
        assert ensure_recent_demo_history(db, today=date(2027, 3, 15)) == 0
    finally:
        event.remove(db.engine, "before_cursor_execute", record)

    assert statements == []
    assert _liability_state(db) == before


def test_liability_rewrite_function_has_its_own_demo_guard(tmp_path):
    from sqlalchemy import event

    from src.services.demo_liabilities import rewrite_demo_liability_history

    db = Database(db_path=str(tmp_path / "real.db"))
    statements = []
    event.listen(db.engine, "before_cursor_execute", lambda c, cu, st, p, ctx, m: statements.append(st))
    assert rewrite_demo_liability_history(db, date(2027, 3, 14)) == 0
    assert statements == []


def test_liability_history_refreshes_even_when_portfolio_history_is_current(demo_db):
    _build_liabilities(demo_db)
    today = date(2027, 3, 15)
    ensure_recent_demo_history(demo_db, today=today)  # portfolio history now ends yesterday
    # Age only the liability snapshots, leaving portfolio history current for `today`.
    from src.database.models import LiabilityBalanceSnapshot

    with demo_db.get_session() as session:
        session.query(LiabilityBalanceSnapshot).filter(
            LiabilityBalanceSnapshot.snapshot_date > date(2026, 12, 31)
        ).delete()
        session.commit()
    assert ensure_recent_demo_history(demo_db, today=today) == 0  # portfolio unchanged
    _, snaps = _liability_state(demo_db)
    assert max(s[1] for s in snaps) == date(2027, 2, 28)
    assert len(snaps) == 36
