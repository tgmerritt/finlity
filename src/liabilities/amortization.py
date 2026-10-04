"""Pure amortization math.

Mirrors src/web/src/utils/amortization.ts; both are checked against
tests/fixtures/amortization_cases.json. No intermediate rounding: callers
round to cents at the API boundary.
"""

import calendar
import math
from datetime import date, datetime, timedelta
from typing import Any, Optional, Union

PERIODS_PER_YEAR = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "annual": 1}
MAX_PERIODS = 600
_EPS = 1e-9
_MONTH_STEP = {"monthly": 1, "quarterly": 3, "annual": 12}

DateLike = Union[date, str]


def _as_date(value: DateLike) -> date:
    # datetime is a subclass of date, so it must be checked first (server columns are DATETIME).
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    return date.fromisoformat(str(value)[:10])


def periods_per_year(frequency: str) -> int:
    try:
        return PERIODS_PER_YEAR[frequency]
    except KeyError:
        raise ValueError(f"Unknown payment frequency: {frequency}") from None


def _rate(apr: Optional[float], frequency: str) -> float:
    return (apr or 0.0) / periods_per_year(frequency)


def annuity_payment(balance: float, apr: float, n_periods: int, frequency: str) -> float:
    """Level payment that retires `balance` in `n_periods` payments."""
    if n_periods <= 0:
        return balance
    r = _rate(apr, frequency)
    if r == 0:
        return balance / n_periods
    return balance * r / (1 - (1 + r) ** -n_periods)


def balance_after(balance: float, apr: float, payment: float, k: int, frequency: str) -> float:
    """Balance after `k` payments, floored at 0."""
    if k <= 0:
        return max(balance, 0.0)
    r = _rate(apr, frequency)
    if r == 0:
        value = balance - k * payment
    else:
        growth = (1 + r) ** k
        value = balance * growth - payment * (growth - 1) / r
    return max(value, 0.0)


def periods_to_payoff(balance: float, apr: float, payment: float, frequency: str) -> Optional[int]:
    """Payments needed to clear `balance`; None when it never pays off (or exceeds the 600 cap)."""
    if balance <= 0:
        return 0
    if payment <= 0:
        return None
    r = _rate(apr, frequency)
    if r == 0:
        n = math.ceil(balance / payment - _EPS)
    else:
        if payment <= r * balance:
            return None
        n = math.ceil(-math.log(1 - r * balance / payment) / math.log(1 + r) - _EPS)
    return n if n <= MAX_PERIODS else None


def month_ends(first: date, last: date, limit: int | None = None) -> list[date]:
    """Month-end dates from `first`'s month through the last month-end on or before `last`."""
    out: list[date] = []
    year, month = first.year, first.month
    while limit is None or len(out) < limit:
        end = date(year, month, calendar.monthrange(year, month)[1])
        if end > last:
            break
        out.append(end)
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return out


def shift(anchor: date, frequency: str, k: int) -> date:
    if frequency in ("weekly", "biweekly"):
        return anchor + timedelta(days=(7 if frequency == "weekly" else 14) * k)
    if frequency not in _MONTH_STEP:
        raise ValueError(f"Unknown payment frequency: {frequency}")
    index = anchor.year * 12 + (anchor.month - 1) + _MONTH_STEP[frequency] * k
    year, month0 = divmod(index, 12)
    month = month0 + 1
    return date(year, month, min(anchor.day, calendar.monthrange(year, month)[1]))


def due_dates_between(
    next_payment_date: DateLike, frequency: str, start_exclusive: DateLike, end_inclusive: DateLike
) -> list[date]:
    """Due dates in (start_exclusive, end_inclusive]: the anchor plus or minus whole periods.

    Month-based dates clamp to month end from the anchor's day (Jan 31 -> Feb 28 -> Mar 31).
    """
    anchor, lo, hi = _as_date(next_payment_date), _as_date(start_exclusive), _as_date(end_inclusive)
    if hi <= lo:
        return []
    step_days = {"weekly": 7, "biweekly": 14}.get(frequency)
    if step_days:
        k = math.ceil(((lo - anchor).days + 1) / step_days)
    else:
        months = _MONTH_STEP.get(frequency)
        if months is None:
            raise ValueError(f"Unknown payment frequency: {frequency}")
        k = ((lo.year - anchor.year) * 12 + lo.month - anchor.month) // months - 1
    out: list[date] = []
    while True:
        d = shift(anchor, frequency, k)
        if d > hi:
            return out
        if d > lo:
            out.append(d)
        k += 1


def schedule(balance: float, apr: float, payment: float, frequency: str, first_due: DateLike) -> list[dict[str, Any]]:
    """Payment rows until the balance clears or 600 periods; the last payment is the remainder."""
    first = _as_date(first_due)
    r = _rate(apr, frequency)
    rows: list[dict[str, Any]] = []
    bal = balance
    while bal > _EPS and len(rows) < MAX_PERIODS:
        interest = bal * r
        if payment >= bal + interest - _EPS:
            pay, principal, new_bal = bal + interest, bal, 0.0
        else:
            pay, principal, new_bal = payment, payment - interest, bal - (payment - interest)
        rows.append(
            {
                "date": shift(first, frequency, len(rows)),
                "payment": pay,
                "interest": interest,
                "principal": principal,
                "balance": new_bal,
            }
        )
        bal = new_bal
    return rows


def summarize(balance: float, apr: float, payment: float, frequency: str, first_due: DateLike) -> dict[str, Any]:
    """Payoff date, remaining periods and interest; all None when it never pays off."""
    if periods_to_payoff(balance, apr, payment, frequency) is None:
        return {"payoff_date": None, "periods_remaining": None, "total_interest_remaining": None, "never_pays_off": True}
    rows = schedule(balance, apr, payment, frequency, first_due)
    return {
        "payoff_date": rows[-1]["date"] if rows else None,
        "periods_remaining": len(rows),
        "total_interest_remaining": sum(row["interest"] for row in rows),
        "never_pays_off": False,
    }


def balance_at(liability: dict[str, Any], snapshots: list[dict[str, Any]], on_date: DateLike) -> float:
    """Balance on a date from reported snapshots (design section 3).

    0 on or after closed_date or before origination_date. Anchor on the latest snapshot
    on or before the date (else the earliest, flat back-fill). Amortizing loans roll the
    anchor forward by the due dates in (anchor_date, date]; revolving balances stay flat.
    """
    on = _as_date(on_date)
    closed = liability.get("closed_date")
    if closed and _as_date(closed) <= on:
        return 0.0
    origination = liability.get("origination_date")
    if origination and _as_date(origination) > on:
        return 0.0
    if not snapshots:
        return 0.0
    dated = sorted(((_as_date(s["snapshot_date"]), float(s["balance"])) for s in snapshots), key=lambda s: s[0])
    prior = [s for s in dated if s[0] <= on]
    if not prior:
        return dated[0][1]
    anchor_date, anchor_balance = prior[-1]
    payment = liability.get("payment_amount")
    next_due = liability.get("next_payment_date")
    if not liability.get("is_amortizing") or not payment or not next_due:
        return anchor_balance
    frequency = liability.get("payment_frequency") or "monthly"
    k = len(due_dates_between(next_due, frequency, anchor_date, on))
    return balance_after(anchor_balance, liability.get("interest_rate") or 0.0, payment, k, frequency)
