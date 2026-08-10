"""Market-hours helpers backed by the exchange_calendars NYSE calendar.

Free and open source, no API key. The calendar is timezone-aware
(America/New_York) and knows about holidays and half days.
"""

from datetime import datetime, timezone
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
