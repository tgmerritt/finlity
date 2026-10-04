"""Single source of "today" for liabilities code, so tests can pin it."""

from datetime import date


def today() -> date:
    """The process-local calendar date (honours TZ), matching the browser path."""
    return date.today()
