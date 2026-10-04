"""Shared helpers for PDF layout parsers (design 4.4).

Everything here is pure. Raw statement text never leaves a layout parser:
descriptions go through mask_description() before they are stored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import date
from typing import Any

from ...limits import MAX_TRANSACTIONS_PER_STATEMENT
from ...errors import SmartImportError
from ...normalize import (
    assign_occurrences,
    dedupe_base,
    infer_kind,
    mask_description,
    merchant_key,
)
from ...types import NormalizedStatement, NormalizedTransaction

MAX_LINE_CHARS = 500

_MONTHS = {
    m: i + 1
    for i, m in enumerate(
        (
            "jan",
            "feb",
            "mar",
            "apr",
            "may",
            "jun",
            "jul",
            "aug",
            "sep",
            "oct",
            "nov",
            "dec",
        )
    )
}
_MON = r"(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?"

# Date at the start of a transaction line: MM/DD, MM/DD/YY, MM/DD/YYYY or Mon DD.
DATE_TOKEN = rf"(?:\d{{1,2}}/\d{{1,2}}(?:/\d{{4}}|/\d{{2}})?(?!\d)|{_MON}\s+\d{{1,2}}(?:,\s*\d{{4}})?(?!\d))"
FULL_DATE_RE = re.compile(
    rf"\d{{1,2}}/\d{{1,2}}/(?:\d{{4}}|\d{{2}})(?!\d)|{_MON}\s+\d{{1,2}},?\s+\d{{4}}(?!\d)"
)

MONEY = r"\(?-?\$?\s?\d[\d,]*\.\d{2}\)?-?(?:\s?(?:CR|DR))?"
TRAILING_MONEY_RE = re.compile(rf"\s({MONEY})\s*$")
MONEY_RE = re.compile(MONEY)

PERIOD_KEYS_RE = re.compile(
    r"(?i)statement period|opening/closing date|closing date|billing period|statement date"
)


@dataclass(frozen=True)
class Money:
    value: float  # absolute value
    printed: str | None  # "neg", "cr", "dr" or None (unsigned)


def parse_money(token: str) -> Money | None:
    t = token.strip()
    if not t:
        return None
    upper = t.upper()
    marker: str | None = None
    if upper.endswith("CR"):
        marker, t = "cr", t[:-2]
    elif upper.endswith("DR"):
        marker, t = "dr", t[:-2]
    t = t.strip()
    neg = t.startswith("(") or t.startswith("-") or t.endswith("-") or t.endswith(")")
    digits = re.sub(r"[^\d.]", "", t)
    try:
        value = abs(float(digits))
    except ValueError:
        return None
    if neg:
        marker = "neg"
    return Money(round(value, 2), marker)


def split_trailing_money(text: str, limit: int = 2) -> tuple[str, list[Money]]:
    """Strip up to ``limit`` money tokens from the end; return (rest, tokens in order)."""
    rest = text.rstrip()
    found: list[Money] = []
    for _ in range(limit):
        m = TRAILING_MONEY_RE.search(rest)
        if not m:
            break
        money = parse_money(m.group(1))
        if money is None:
            break
        found.append(money)
        rest = rest[: m.start()].rstrip()
    found.reverse()
    return rest, found


def parse_date_token(token: str) -> tuple[int | None, int, int]:
    """Return (year or None, month, day) or raise ValueError."""
    t = token.strip().rstrip(",")
    if "/" in t:
        parts = t.split("/")
        month, day = int(parts[0]), int(parts[1])
        year: int | None = None
        if len(parts) > 2:
            year = int(parts[2])
            if year < 100:
                year += 2000
        return year, month, day
    m = re.match(rf"({_MON})\s+(\d{{1,2}})(?:,?\s+(\d{{4}}))?", t)
    if not m:
        raise ValueError("date")
    month = _MONTHS[m.group(1)[:3].lower()]
    return (int(m.group(3)) if m.group(3) else None), month, int(m.group(2))


def parse_full_date(token: str) -> date | None:
    try:
        year, month, day = parse_date_token(token)
        if year is None:
            return None
        return date(year, month, day)
    except ValueError:
        return None


def find_period(lines: list[str]) -> tuple[date | None, date | None]:
    """Statement period (start, end) from a header line; end only for a closing date."""
    for idx, line in enumerate(lines):
        if not PERIOD_KEYS_RE.search(line):
            continue
        window = line if idx + 1 >= len(lines) else line + " " + lines[idx + 1]
        dates = [
            d
            for d in (parse_full_date(m.group(0)) for m in FULL_DATE_RE.finditer(line))
            if d
        ]
        if not dates:
            dates = [
                d
                for d in (
                    parse_full_date(m.group(0)) for m in FULL_DATE_RE.finditer(window)
                )
                if d
            ]
        if len(dates) >= 2:
            return min(dates[:2]), max(dates[:2])
        if len(dates) == 1:
            return None, dates[0]
    return None, None


def resolve_date(
    year: int | None,
    month: int,
    day: int,
    start: date | None,
    end: date | None,
    today: date | None = None,
) -> tuple[date | None, bool]:
    """Resolve a possibly year-less date. Returns (date, year_was_assumed)."""
    try:
        if year is not None:
            return date(year, month, day), False
        if end is not None:
            years = [end.year] if start is None else [end.year, start.year]
            if start is not None:
                for y in years:
                    try:
                        d = date(y, month, day)
                    except ValueError:
                        continue
                    if start <= d <= end:
                        return d, False
            y = end.year - 1 if month > end.month else end.year
            return date(y, month, day), False
        return date((today or date.today()).year, month, day), True
    except ValueError:
        return None, False


@dataclass
class RawRow:
    posted: date
    amount: float  # signed: spending negative
    description: str  # already masked


def last4_and_key(text: str) -> tuple[str | None, str | None]:
    """Account last4 and hashed key from an ``Account Number`` style line, if any."""
    from ...normalize import account_key_from_number

    m = re.search(
        r"(?i)(?:account(?:\s+number)?|acct\.?)\s*(?:ending(?:\s+in)?|#|no\.?|:)\s*[*xX\-\s]*(\d{4,16})(?!\d)",
        text,
    )
    if not m:
        return None, None
    digits = m.group(1)
    key = account_key_from_number(None, digits) if len(digits) >= 8 else None
    return digits[-4:], key


def build_statement(
    *,
    parser: str,
    account_kind: str,
    rows: list[RawRow],
    start: date | None,
    end: date | None,
    last4: str | None = None,
    key: str | None = None,
    closing: tuple[float, str] | None = None,
    extras: dict[str, float | str] | None = None,
    warnings: list[str] | None = None,
) -> NormalizedStatement:
    if len(rows) > MAX_TRANSACTIONS_PER_STATEMENT:
        raise SmartImportError("too_many_rows")
    prepared: list[dict[str, Any]] = [
        {
            "posted_date": r.posted.isoformat(),
            "amount": r.amount,
            "description": r.description,
            "merchant_key": merchant_key(r.description),
        }
        for r in rows
    ]
    occurrences = assign_occurrences(prepared)
    transactions: list[NormalizedTransaction] = []
    for i, (p, occ) in enumerate(zip(prepared, occurrences, strict=True)):
        transactions.append(
            {
                "row": i,
                "posted_date": p["posted_date"],
                "amount": p["amount"],
                "description": p["description"],
                "merchant_key": p["merchant_key"],
                "kind": infer_kind(p["description"], p["amount"], account_kind),
                "category_id": None,
                "category_source": "none",
                "external_id": None,
                "dedupe_base": dedupe_base(
                    p["posted_date"],
                    p["amount"],
                    p["merchant_key"],
                    p["description"],
                    occ,
                ),
            }
        )
    statement: NormalizedStatement = {
        "file_hash": "",
        "file_name": "",
        "origin": "file",
        "format": "pdf",
        "parser": parser,
        "account": {
            "kind": account_kind,
            "key": key,
            "last4": last4,
            "institution": None,
        },
        "period": {
            "start": start.isoformat() if start else None,
            "end": end.isoformat() if end else None,
        },
        "closing_balance": (
            {"amount": closing[0], "as_of": closing[1]} if closing is not None else None
        ),
        "extras": extras if extras else None,  # type: ignore[typeddict-item]
        "warnings": list(warnings or []),
        "transactions": transactions,
    }
    return statement


def clean_lines(text: str) -> list[str]:
    return [ln.strip()[:MAX_LINE_CHARS] for ln in text.splitlines()]


def desc(raw: str) -> str:
    return mask_description(raw)
