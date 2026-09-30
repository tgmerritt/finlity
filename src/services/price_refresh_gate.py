"""Decision gate for price-refresh passes.

Policy:
- Markets closed (evening, pre-open, weekends, holidays): no refresh, with
  one exception: a catch-up pass is allowed while any updatable ticker's
  cached price predates the most recent close (the user only opens the app
  while the market is closed, so the closing price was never fetched).
  Once the cache is newer than the last close, the gate is closed again.
- Market open: at most one refresh pass per hour, tracked in AppSettings.
- Manual force refreshes may bypass the hourly cap but never the
  market-closed rule beyond that catch-up.

The gate is DB-backed so the hourly cap survives dyno restarts and is
shared across sessions.
"""

import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.database.operations import Database
from src.services.market_hours import is_market_open, last_market_close, next_market_open

logger = logging.getLogger(__name__)

REFRESH_INTERVAL_SECONDS = 3600
LAST_REFRESH_KEY = "last_price_refresh_at"

MARKET_CLOSED = "market_closed"
TOO_SOON = "too_soon"
ALLOWED = "allowed"


@dataclass
class GateDecision:
    allowed: bool
    reason: str
    next_refresh_at: datetime | None  # naive UTC
    # Set (naive UTC, the last close) when this is a closed-market catch-up
    # pass: only tickers cached before it should be fetched.
    catch_up_cutoff: datetime | None = None


def _now_utc(now: datetime | None) -> datetime:
    """Naive-UTC version of ``now`` (or the real now)."""
    if now is None:
        return datetime.now(timezone.utc).replace(tzinfo=None)
    if now.tzinfo is not None:
        return now.astimezone(timezone.utc).replace(tzinfo=None)
    return now


def _last_pass(db: Database) -> datetime | None:
    setting = db.get_setting(LAST_REFRESH_KEY)
    if not setting or not setting.value:
        return None
    try:
        return datetime.fromisoformat(setting.value)
    except ValueError:
        return None


def evaluate_refresh_gate(
    db: Database, now: datetime | None = None, force: bool = False
) -> GateDecision:
    """Whether a refresh pass may run at ``now`` (default: real now).

    ``force`` (explicit user action) bypasses the hourly cap but not the
    market-closed rule.
    """
    now_utc = _now_utc(now)
    aware_utc = now_utc.replace(tzinfo=timezone.utc)

    last = _last_pass(db)
    cutoff: datetime | None = None

    if not is_market_open(aware_utc):
        cutoff = last_market_close(aware_utc)
        if cutoff is None:
            logger.warning("last_market_close unavailable; no catch-up pass")
        if cutoff is None or not db.get_tickers_priced_before(cutoff):
            return GateDecision(False, MARKET_CLOSED, next_market_open(aware_utc))
    if last is not None and not force and (
        now_utc - last
    ).total_seconds() < REFRESH_INTERVAL_SECONDS:
        return GateDecision(
            False,
            TOO_SOON,
            last + timedelta(seconds=REFRESH_INTERVAL_SECONDS),
        )

    if cutoff is not None:
        return GateDecision(
            True, ALLOWED, next_market_open(aware_utc), catch_up_cutoff=cutoff
        )

    return GateDecision(
        True, ALLOWED, now_utc + timedelta(seconds=REFRESH_INTERVAL_SECONDS)
    )


def catch_up_tickers(db: Database, decision: GateDecision) -> list[str]:
    """Tickers a closed-market catch-up pass should fetch: prices cached
    before the last close plus tickers with no cached price at all."""
    if decision.catch_up_cutoff is None:
        return []
    return sorted(
        set(db.get_tickers_priced_before(decision.catch_up_cutoff))
        | set(db.get_never_fetched_tickers())
    )


def record_refresh_pass(db: Database, now: datetime | None = None) -> None:
    """Stamp that a refresh pass ran at ``now`` (default: real now)."""
    db.set_setting(LAST_REFRESH_KEY, _now_utc(now).isoformat())
