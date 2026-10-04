"""Keep the demo portfolio's value history current.

The bundled demo database ships with a few old snapshots, so the dashboard's
history chart showed "not enough history" on every recent range. At startup
in demo mode we regenerate a deterministic year of daily snapshots that ends
yesterday (UTC) at the portfolio's current totals.
"""
from __future__ import annotations

import math
import random
from datetime import date, datetime, timedelta
from pathlib import Path

from src.database.models import PortfolioSnapshot

_SEED = 20260930
_TARGET_ANNUAL_RETURN = 0.08
_DAILY_VOLATILITY = 0.009


def _is_demo_database(db) -> bool:
    """True only when `db` is (resolvably) the demo manager's demo database.

    `app.state.demo_mode` (derived from the PORTFOLIO_DEMO_MODE env var) and
    `get_demo_manager().is_enabled` (the on-disk demo_state.json flag) can
    disagree. If a caller ever invokes this against a real profile database
    in that situation, it must refuse rather than delete real history, so
    this check is enforced here regardless of what the caller believes.
    """
    from src.services.demo_mode import get_demo_manager

    db_path = getattr(db, "db_path", None)
    if not db_path:
        return False
    try:
        demo_path = Path(get_demo_manager().demo_db_path).resolve()
        return Path(db_path).resolve() == demo_path
    except OSError:
        return False


def _current_totals(db) -> tuple[float, float, float]:
    accounts = {a.id: a for a in db.get_all_accounts()}
    total = retirement = taxable = 0.0
    for pos in db.get_all_positions():
        value = float(pos.market_value or 0.0)
        total += value
        account = accounts.get(pos.account_id)
        if account is not None and account.is_retirement:
            retirement += value
        else:
            taxable += value
    return total, retirement, taxable


def ensure_recent_demo_history(db, today: date | None = None, days: int = 365) -> int:
    """Rewrite demo snapshots so they cover `days` days ending yesterday (UTC).

    Returns the number of snapshots written, or 0 if history already ends
    yesterday or later, or if `db` is not the demo database.
    """
    if not _is_demo_database(db):
        return 0

    from src.liabilities import clock as liabilities_clock

    liabilities_today = today or liabilities_clock.today()
    today = today or datetime.utcnow().date()
    yesterday = today - timedelta(days=1)

    # Demo liability history has its own staleness check and demo guard, so it
    # stays current even when portfolio history already ends yesterday.
    from src.services.demo_liabilities import rewrite_demo_liability_history

    # Without an explicit `today`, liabilities follow the process-local calendar (clock), not UTC.
    rewrite_demo_liability_history(db, liabilities_today - timedelta(days=1))

    with db.get_session() as session:
        latest = session.query(PortfolioSnapshot).order_by(PortfolioSnapshot.snapshot_date.desc()).first()
        if latest is not None and latest.snapshot_date.date() >= yesterday:
            return 0

    total, retirement, taxable = _current_totals(db)
    if total <= 0:
        return 0
    retirement_share = retirement / total

    # Seeded random walk in log space, built backwards from today (log 0).
    # Its net drift is removed (a "bridge" pinned to 0 at both ends) and a
    # fixed annual return is applied as a linear ramp, so the trend is
    # deterministic while the day-to-day noise is kept. The series starts at
    # total / (1 + return) and ends exactly at the current total.
    rng = random.Random(_SEED)
    walk = [0.0]
    for _ in range(days - 1):
        walk.append(walk[-1] - rng.gauss(0, _DAILY_VOLATILITY))
    walk.reverse()  # chronological: walk[-1] == 0
    span = max(days - 1, 1)
    log_return = math.log(1 + _TARGET_ANNUAL_RETURN)
    log_total = math.log(total)
    values = []
    for i, w in enumerate(walk):
        bridge = w - walk[0] * (1 - i / span)
        ramp = -log_return * (span - i) / span
        values.append(math.exp(log_total + bridge + ramp))
    values[-1] = total

    with db.get_session() as session:
        session.query(PortfolioSnapshot).delete()
        for offset, value in enumerate(values):
            day = yesterday - timedelta(days=days - 1 - offset)
            retirement_value = value * retirement_share
            session.add(
                PortfolioSnapshot(
                    snapshot_date=datetime(day.year, day.month, day.day),
                    total_value=value,
                    retirement_value=retirement_value,
                    taxable_value=value - retirement_value,
                    positions_json=None,
                )
            )
        session.commit()
    return days
