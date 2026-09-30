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
