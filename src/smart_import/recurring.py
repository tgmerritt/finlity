"""Recurring bill detection (design section 7.2).

Stateless and pure: it never opens a database, logs, or touches a file.
Inputs are the batch's normalized rows, prior rows for the same merchants
(history) and the active budget expenses; the output is a list of candidate
dicts for the wizard's "Recurring bills" step.
"""

from __future__ import annotations

import bisect
import math
import statistics
from collections import Counter, defaultdict
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

AMOUNT_TOLERANCE = 0.10
MIN_OCCURRENCES = 3
PAIR_MIN_GAP_DAYS = 25
PAIR_MAX_GAP_DAYS = 35
# Every gap must sit within max(GAP_SLACK_DAYS, GAP_SLACK_RATIO * median) of the median.
GAP_SLACK_DAYS = 3
GAP_SLACK_RATIO = 0.25
# Expense frequency to payments per month, for the already_budgeted fallback.
_PER_MONTH = {
    "weekly": 52 / 12,
    "biweekly": 26 / 12,
    "monthly": 1.0,
    "quarterly": 1 / 3,
    "annual": 1 / 12,
}

# Rows of these kinds are never bills (inflows, card payments and transfers
# would double count or are not spending). A row with no kind is judged by sign.
_NOT_BILL_KINDS = frozenset({"income", "refund", "payment", "transfer"})

# (frequency, min median gap, max median gap), inclusive, in days
_FREQUENCY_RANGES: tuple[tuple[str, float, float], ...] = (
    ("weekly", 6, 9),
    ("biweekly", 12, 18),
    ("monthly", 25, 45),
    ("quarterly", 80, 100),
    ("annual", 350, 380),
)


def frequency_for_gaps(gaps: list[int]) -> str | None:
    """Frequency for evenly spaced gaps, or None when the spacing is irregular.

    Classified by the median gap; every gap must be within
    max(3, 25% of the median) days of it. Skipped periods are not allowed.
    """
    median = statistics.median(gaps)
    slack = max(GAP_SLACK_DAYS, GAP_SLACK_RATIO * median)
    if any(abs(g - median) > slack for g in gaps):
        return None
    for name, low, high in _FREQUENCY_RANGES:
        if low <= median <= high:
            return name
    return None


def _as_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _outflow(value: Any) -> float | None:
    """Absolute amount of a negative number, else None."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(value) or value >= 0:
        return None
    return abs(float(value))


def _occurrence(row: Mapping[str, Any], *, with_kind: bool) -> dict[str, Any] | None:
    key = row.get("merchant_key")
    if not isinstance(key, str) or not key:
        return None
    if with_kind and row.get("kind") in _NOT_BILL_KINDS:
        return None
    amount = _outflow(row.get("amount"))
    posted = _as_date(row.get("posted_date"))
    if amount is None or posted is None:
        return None
    return {
        "key": key,
        "date": posted,
        "amount": amount,
        "description": row.get("description"),
        "category_id": row.get("category_id"),
    }


def _within(value: float, center: float) -> bool:
    return abs(value - center) <= AMOUNT_TOLERANCE * center


def _norm(text: Any) -> str:
    return text.strip().casefold() if isinstance(text, str) else ""


def _most_common(values: Iterable[Any]) -> Any:
    """Most common truthy value; ties go to the one seen first."""
    counts = Counter(v for v in values if v)
    if not counts:
        return None
    return counts.most_common(1)[0][0]


@dataclass(frozen=True)
class _ExpenseIndex:
    """Active expenses indexed once per request (design 7.2 budget match).

    ``by_name`` maps a normalized name to the lowest ``str(id)`` and its id.
    ``by_category`` maps a category id to ``(monthly, str(id), id)`` tuples
    sorted by monthly equivalent, one per distinct monthly value (the lowest
    id wins a tie), so a match is a binary search instead of a scan.
    """

    by_name: dict[str, tuple[str, Any]]
    by_category: dict[Any, list[tuple[float, str, Any]]]


def _hashable(value: Any) -> bool:
    try:
        hash(value)
    except TypeError:
        return False
    return True


def _index_expenses(expenses: Iterable[Mapping[str, Any]]) -> _ExpenseIndex:
    by_name: dict[str, tuple[str, Any]] = {}
    per_category: dict[Any, dict[float, tuple[str, Any]]] = defaultdict(dict)
    for exp in expenses:
        if not isinstance(exp, Mapping):
            continue
        exp_id = exp.get("id")
        if not exp.get("is_active", True) or exp_id is None:
            continue
        ident = (str(exp_id), exp_id)
        name = _norm(exp.get("name"))
        if name and (name not in by_name or ident[0] < by_name[name][0]):
            by_name[name] = ident
        category = exp.get("category_id")
        amount = exp.get("amount")
        per_month = _PER_MONTH.get(str(exp.get("frequency") or "monthly"))
        if category is None or per_month is None or not _hashable(category):
            continue
        if isinstance(amount, bool) or not isinstance(amount, (int, float)):
            continue
        monthly = float(amount) * per_month
        if not math.isfinite(monthly):
            continue
        slot = per_category[category]
        if monthly not in slot or ident[0] < slot[monthly][0]:
            slot[monthly] = ident
    by_category = {
        cat: sorted((m, sid, eid) for m, (sid, eid) in slot.items())
        for cat, slot in per_category.items()
    }
    return _ExpenseIndex(by_name=by_name, by_category=by_category)


def _match_expense(
    name_keys: set[str],
    category_id: str | None,
    amount: float,
    frequency: str,
    index: _ExpenseIndex,
) -> Any:
    """Return the matched expense's id or None (a falsy id never matches).

    A name match wins (lowest id). Otherwise the expense in the same category
    whose monthly equivalent is closest, within the amount tolerance, wins
    (lowest id on a tie). The tolerance test is monotonic on each side of the
    candidate, so only the nearest expense below and above can match.
    """
    named = [index.by_name[k] for k in name_keys - {""} if k in index.by_name]
    if named:
        return min(named, key=lambda ident: ident[0])[1]
    if category_id is None:
        return None
    ranked = index.by_category.get(category_id)
    if not ranked:
        return None
    candidate_monthly = amount * _PER_MONTH[frequency]
    pos = bisect.bisect_left(ranked, (candidate_monthly,))
    best: tuple[float, str, Any] | None = None
    for i in (pos - 1, pos):
        if not 0 <= i < len(ranked):
            continue
        exp_monthly, sid, eid = ranked[i]
        gap = abs(exp_monthly - candidate_monthly)
        if gap <= AMOUNT_TOLERANCE * max(exp_monthly, candidate_monthly):
            rank = (gap, sid, eid)
            if best is None or rank[:2] < best[:2]:
                best = rank
    return best[2] if best else None


def detect(
    rows: Iterable[Mapping[str, Any]],
    history: Iterable[Mapping[str, Any]],
    expenses: Iterable[Mapping[str, Any]],
    categories: Iterable[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Return recurring bill candidates, largest amount first."""
    batch = [o for r in rows if (o := _occurrence(r, with_kind=True))]
    seen: Counter[tuple[str, date, float]] = Counter(
        (o["key"], o["date"], round(o["amount"], 2)) for o in batch
    )
    prior: list[dict[str, Any]] = []
    for h in history:
        o = _occurrence(h, with_kind=True)
        if o is None:
            continue
        ident = (o["key"], o["date"], round(o["amount"], 2))
        if seen[ident] > 0:
            # The same transaction is already in the batch (overlapping statements).
            seen[ident] -= 1
            continue
        prior.append(o)

    groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for o in [*prior, *batch]:
        groups[o["key"]].append(o)

    index = _index_expenses(expenses)
    category_ids = {
        cid for c in categories if _hashable(cid := c.get("id"))
    }
    out: list[dict[str, Any]] = []
    for key, occ in groups.items():
        median = statistics.median(o["amount"] for o in occ)
        inliers = sorted((o for o in occ if _within(o["amount"], median)), key=lambda o: o["date"])
        if len(inliers) < 2:
            continue
        gaps = [(b["date"] - a["date"]).days for a, b in zip(inliers, inliers[1:])]
        if len(inliers) == 2:
            # A monthly bill seen across two statements.
            if not PAIR_MIN_GAP_DAYS <= gaps[0] <= PAIR_MAX_GAP_DAYS:
                continue
        frequency = frequency_for_gaps(gaps)
        if frequency is None:
            continue
        if frequency == "annual" and len(inliers) < MIN_OCCURRENCES:
            continue
        amount = round(statistics.median(o["amount"] for o in inliers), 2)
        name = _most_common(
            d.strip() for o in inliers if isinstance(d := o["description"], str)
        ) or key
        category_id = _most_common(o["category_id"] for o in inliers)
        if category_id not in category_ids:
            category_id = None
        matched = _match_expense(
            {_norm(name), _norm(key)}, category_id, amount, frequency, index
        )
        out.append(
            {
                "merchant_key": key,
                "name": name,
                "amount": amount,
                "frequency": frequency,
                "occurrences": len(inliers),
                "last_date": inliers[-1]["date"].isoformat(),
                "category_id": category_id,
                "already_budgeted": matched is not None,
                "matched_expense_id": matched,
            }
        )
    out.sort(key=lambda c: (-c["amount"], c["merchant_key"]))
    return out
