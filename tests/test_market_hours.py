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


# ---- last_market_close ----

from datetime import datetime as _dt  # noqa: E402

from src.services.market_hours import last_market_close  # noqa: E402


def _utc(y, m, d, hh, mm=0):
    """Naive UTC datetime, the convention last_market_close returns."""
    return _dt(y, m, d, hh, mm)


def test_last_close_weekday_after_close():
    # Tue 2026-09-29 18:00 ET (22:00 UTC): today's 16:00 ET close = 20:00 UTC.
    assert last_market_close(_et(2026, 9, 29, 18, 0)) == _utc(2026, 9, 29, 20)


def test_last_close_saturday_is_friday_close():
    assert last_market_close(_et(2026, 9, 19, 11, 0)) == _utc(2026, 9, 18, 20)


def test_last_close_monday_before_open_is_friday_close():
    assert last_market_close(_et(2026, 9, 21, 8, 0)) == _utc(2026, 9, 18, 20)


def test_last_close_holiday_skips_to_previous_session():
    # Fri 2026-07-03 is the observed Independence Day holiday.
    assert last_market_close(_et(2026, 7, 3, 11, 0)) == _utc(2026, 7, 2, 20)


def test_last_close_half_day():
    # Fri 2026-11-27 closes at 13:00 ET (18:00 UTC).
    assert last_market_close(_et(2026, 11, 27, 20, 0)) == _utc(2026, 11, 27, 18)


def test_last_close_during_session_is_previous_day():
    assert last_market_close(_et(2026, 9, 29, 11, 0)) == _utc(2026, 9, 28, 20)


def test_last_close_exactly_at_close_is_inclusive():
    assert last_market_close(_et(2026, 9, 29, 16, 0)) == _utc(2026, 9, 29, 20)


def test_last_close_aware_utc_input():
    from datetime import timezone

    assert last_market_close(_dt(2026, 9, 30, 22, 0, tzinfo=timezone.utc)) == _utc(2026, 9, 30, 20)
