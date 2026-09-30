"""Prices must refresh once after each close, even if the market is closed
whenever the user opens the app (e.g. a user in New Zealand).

Uses an isolated temp Database and injected ``now`` values; the real NYSE
calendar answers last_market_close, nothing touches the network or clock.
"""

from datetime import datetime, timedelta, timezone

import pytest

from src.database.models import Account, Position, PriceCache
from src.database.operations import Database
from src.services.market_hours import last_market_close
from src.services.price_refresh_gate import (
    ALLOWED,
    MARKET_CLOSED,
    TOO_SOON,
    catch_up_tickers,
    evaluate_refresh_gate,
    record_refresh_pass,
)

# Wed 2026-09-30 22:00 UTC = 18:00 ET: closed, last close 20:00 UTC today.
NOW = datetime(2026, 9, 30, 22, 0, tzinfo=timezone.utc)
LAST_CLOSE = datetime(2026, 9, 30, 20, 0)


@pytest.fixture
def db(tmp_path):
    database = Database(str(tmp_path / "t.db"))
    with database.get_session() as session:
        account = Account(name="A", account_type="taxable")
        session.add(account)
        session.flush()
        rows = [
            ("VTI", "equity"),
            ("VXUS", "equity"),
            ("RE", "real_estate"),
            ("CASH", "cash"),
        ]
        for ticker, ptype in rows:
            session.add(
                Position(
                    account_id=account.id, ticker=ticker, name=ticker, shares=1.0,
                    current_price=10.0, cost_basis=10.0, position_type=ptype,
                )
            )
        session.commit()
    return database


def _stamp(db, ticker, when):
    db.update_price_cache(ticker, 10.0, previous_close=9.0)
    with db.get_session() as session:
        row = session.query(PriceCache).filter_by(ticker=ticker).first()
        row.last_updated = when
        session.commit()


def _cache_all(db, when):
    for t in ("VTI", "VXUS", "RE", "CASH"):
        _stamp(db, t, when)


def test_sanity_last_close_for_now():
    assert last_market_close(NOW) == LAST_CLOSE


class TestTickersPricedBefore:
    def test_lists_only_updatable_tickers_cached_before_cutoff(self, db):
        _stamp(db, "VTI", LAST_CLOSE - timedelta(days=12))
        _stamp(db, "VXUS", LAST_CLOSE + timedelta(hours=1))
        _stamp(db, "RE", LAST_CLOSE - timedelta(days=12))  # not updatable

        assert db.get_tickers_priced_before(LAST_CLOSE) == ["VTI"]

    def test_never_cached_tickers_are_not_included(self, db):
        assert db.get_tickers_priced_before(LAST_CLOSE) == []


class TestStatusWhenClosed:
    def test_nz_scenario_twelve_day_old_cache_is_stale(self, db):
        _cache_all(db, NOW.replace(tzinfo=None) - timedelta(days=12))

        status = db.get_price_cache_status(stale_before=LAST_CLOSE)

        assert status["stale_tickers"] == 2  # VTI, VXUS only
        assert status["all_fresh"] is False

    def test_cache_written_after_close_is_fresh(self, db):
        _cache_all(db, LAST_CLOSE + timedelta(minutes=5))

        status = db.get_price_cache_status(stale_before=LAST_CLOSE)

        assert status["stale_tickers"] == 0
        assert status["all_fresh"] is True


class TestGateWhenClosed:
    def test_nz_scenario_gate_allows_one_catch_up_pass_then_closes(self, db):
        _cache_all(db, NOW.replace(tzinfo=None) - timedelta(days=12))

        decision = evaluate_refresh_gate(db, now=NOW)
        assert decision.allowed is True
        assert decision.reason == ALLOWED
        assert decision.catch_up_cutoff == LAST_CLOSE
        assert sorted(catch_up_tickers(db, decision)) == ["VTI", "VXUS"]

        # The pass fetches prices (cache stamped after the close) ...
        _cache_all(db, NOW.replace(tzinfo=None))
        record_refresh_pass(db, now=NOW)

        # ... so the gate goes back to MARKET_CLOSED and status is fresh.
        later = NOW + timedelta(hours=3)
        decision = evaluate_refresh_gate(db, now=later)
        assert decision.allowed is False
        assert decision.reason == MARKET_CLOSED
        assert db.get_price_cache_status(stale_before=LAST_CLOSE)["all_fresh"] is True

    def test_force_on_closed_market_also_catches_up(self, db):
        _stamp(db, "VTI", LAST_CLOSE - timedelta(days=12))
        _stamp(db, "VXUS", LAST_CLOSE + timedelta(hours=1))

        decision = evaluate_refresh_gate(db, now=NOW, force=True)

        assert decision.allowed is True
        assert catch_up_tickers(db, decision) == ["VTI"]

    def test_closed_and_current_cache_stays_market_closed(self, db):
        _cache_all(db, LAST_CLOSE + timedelta(minutes=1))

        decision = evaluate_refresh_gate(db, now=NOW)

        assert decision.allowed is False
        assert decision.reason == MARKET_CLOSED

    def test_non_updatable_only_stale_stays_market_closed(self, db):
        _stamp(db, "VTI", LAST_CLOSE + timedelta(minutes=1))
        _stamp(db, "VXUS", LAST_CLOSE + timedelta(minutes=1))
        _stamp(db, "RE", LAST_CLOSE - timedelta(days=30))

        assert evaluate_refresh_gate(db, now=NOW).reason == MARKET_CLOSED

    def test_hourly_cap_applies_to_unforced_catch_up(self, db):
        _cache_all(db, LAST_CLOSE - timedelta(days=12))
        record_refresh_pass(db, now=NOW - timedelta(minutes=10))

        assert evaluate_refresh_gate(db, now=NOW).reason == TOO_SOON
        assert evaluate_refresh_gate(db, now=NOW, force=True).allowed is True


class TestOpenMarketUnchanged:
    def test_open_market_has_no_catch_up_cutoff(self, db):
        open_now = datetime(2026, 9, 30, 15, 0, tzinfo=timezone.utc)  # 11:00 ET

        decision = evaluate_refresh_gate(db, now=open_now)

        assert decision.allowed is True
        assert decision.catch_up_cutoff is None
