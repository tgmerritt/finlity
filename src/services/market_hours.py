"""Market-hours helpers backed by the exchange_calendars NYSE calendar.

Free and open source, no API key. The calendar is timezone-aware
(America/New_York) and knows about holidays and half days.
"""

from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import exchange_calendars as xcals

ET = ZoneInfo("America/New_York")
_calendar = None


def _get_calendar():
    global _calendar
    if _calendar is None:
        _calendar = xcals.get_calendar("XNYS")
    return _calendar


def _ensure_et(dt: datetime | None) -> datetime:
    if dt is None:
        return datetime.now(ET)
    if dt.tzinfo is None:
        return dt.replace(tzinfo=ET)
    return dt.astimezone(ET)


def is_market_open(dt: datetime | None = None) -> bool:
    """True if the NYSE session is in progress at ``dt`` (default: now).

    Naive datetimes are interpreted as America/New_York wall time.
    """
    return _get_calendar().is_open_on_minute(_ensure_et(dt))


def next_market_open(dt: datetime | None = None) -> datetime | None:
    """Next NYSE session open as naive UTC, or None if unknown."""
    try:
        nxt = _get_calendar().next_open(_ensure_et(dt))
    except ValueError:
        return None
    return nxt.astimezone(timezone.utc).replace(tzinfo=None)


def last_market_close(dt: datetime | None = None) -> datetime | None:
    """Most recent NYSE session close at or before ``dt`` as naive UTC.

    Naive ``dt`` is interpreted as America/New_York wall time (like
    ``is_market_open``); the result is naive UTC (like ``next_market_open``).
    Handles weekends, holidays and half days via the calendar. None if the
    calendar cannot answer (``dt`` outside its bounds).
    """
    et = _ensure_et(dt).replace(second=0, microsecond=0)
    try:
        # previous_close is strictly before its argument; nudge one minute so
        # a ``dt`` that is exactly a close returns that close.
        prev = _get_calendar().previous_close(et + timedelta(minutes=1))
    except ValueError:
        return None
    return prev.to_pydatetime().astimezone(timezone.utc).replace(tzinfo=None)
