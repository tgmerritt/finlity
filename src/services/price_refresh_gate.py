"""Decision gate for price-refresh passes.

Policy:
- Markets closed (evening, pre-open, weekends, holidays): never refresh.
- Market open: at most one refresh pass per hour, tracked in AppSettings.
- Manual force refreshes may bypass the hourly cap but never the
  market-closed rule (prices cannot have moved since the last close).

The gate is DB-backed so the hourly cap survives dyno restarts and is
shared across sessions.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from src.database.operations import Database
from src.services.market_hours import is_market_open, next_market_open

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

    if not is_market_open(aware_utc):
        return GateDecision(False, MARKET_CLOSED, next_market_open(aware_utc))

    last = _last_pass(db)
    if last is not None and not force and (
        now_utc - last
    ).total_seconds() < REFRESH_INTERVAL_SECONDS:
        return GateDecision(
            False,
            TOO_SOON,
            last + timedelta(seconds=REFRESH_INTERVAL_SECONDS),
        )

    return GateDecision(
        True, ALLOWED, now_utc + timedelta(seconds=REFRESH_INTERVAL_SECONDS)
    )


def record_refresh_pass(db: Database, now: datetime | None = None) -> None:
    """Stamp that a refresh pass ran at ``now`` (default: real now)."""
    db.set_setting(LAST_REFRESH_KEY, _now_utc(now).isoformat())
