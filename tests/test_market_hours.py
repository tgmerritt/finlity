"""Tests for market-hours detection (NYSE calendar, no network)."""

from datetime import datetime
from zoneinfo import ZoneInfo

from src.services.market_hours import is_market_open, next_market_open

ET = ZoneInfo("America/New_York")


def _et(y: int, m: int, d: int, hh: int, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=ET)


def test_weekday_midday_is_open():
    # Tue 2026-08-11 11:00 ET
    assert is_market_open(_et(2026, 8, 11, 11, 0))


def test_weekday_evening_is_closed():
    assert not is_market_open(_et(2026, 8, 11, 17, 0))


def test_weekday_preopen_is_closed():
    assert not is_market_open(_et(2026, 8, 11, 8, 0))


def test_saturday_is_closed():
    assert not is_market_open(_et(2026, 8, 15, 11, 0))


def test_july4_observed_holiday_is_closed():
    # July 4, 2026 is a Saturday; NYSE observes it Friday, July 3.
    assert not is_market_open(_et(2026, 7, 3, 11, 0))


def test_naive_datetime_interpreted_as_et():
    # Naive datetimes mean America/New_York wall time.
    assert is_market_open(datetime(2026, 8, 11, 11, 0))


def test_next_open_after_friday_close_is_monday():
    # Fri 2026-08-14 17:00 ET -> Mon 2026-08-17 09:30 ET = 13:30 UTC
    nxt = next_market_open(_et(2026, 8, 14, 17, 0))
    assert nxt is not None
    assert nxt == datetime(2026, 8, 17, 13, 30)


def test_next_open_skips_holiday_weekend():
    # Fri 2026-07-03 is a holiday; the next open after Thu 2026-07-02 close
    # is Monday 2026-07-06 09:30 ET = 13:30 UTC.
    nxt = next_market_open(_et(2026, 7, 2, 17, 0))
    assert nxt is not None
    assert nxt == datetime(2026, 7, 6, 13, 30)
