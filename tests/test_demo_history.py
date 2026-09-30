"""Demo history regeneration: the demo portfolio always has a year of daily
snapshots ending yesterday (UTC), so every chart range has data."""
import shutil
from datetime import date, datetime, timedelta
from pathlib import Path

import pytest

from src.database.models import PortfolioSnapshot
from src.database.operations import Database
from src.services.demo_history import ensure_recent_demo_history

_REPO_ROOT = Path(__file__).parent.parent


@pytest.fixture
def demo_db(tmp_path):
    """A Database backed by a temporary copy of the tracked demo.db.

    Never operate on the repo's data/demo/demo.db directly: tests must not
    modify the committed fixture.
    """
    src_db = _REPO_ROOT / "data" / "demo" / "demo.db"
    dst_db = tmp_path / "demo.db"
    shutil.copy2(src_db, dst_db)
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
