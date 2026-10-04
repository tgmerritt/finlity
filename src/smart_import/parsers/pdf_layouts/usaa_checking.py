"""USAA checking statement layout.

Ported from the legacy ``_parse_usaa_pdf`` in src/api/bank_statements.py (left in
place there). Debits come out exactly as before; credits are kept as income.
"""

from __future__ import annotations

import re
from datetime import date

from ...types import NormalizedStatement
from ._common import (
    RawRow,
    build_statement,
    clean_lines,
    desc,
    find_period,
    last4_and_key,
    resolve_date,
)

NAME = "usaa_checking"
PARSER = "pdf:usaa_checking"

_TXN = re.compile(r"^(\d{2})/(\d{2})\s+(.+)$")
_MONEY = re.compile(r"\$([\d,]+\.\d{2})")
_DEBIT_LINE = re.compile(r"\$([\d,]+\.\d{2})\s+0\s*$")
_CREDIT_ONLY = re.compile(r"^[^$]*\s0\s*$")
_BOTH_ZERO = re.compile(r"^.*\s0\s0\s*$")
_SKIP_NAMES = {"beginning balance", "ending balance", "iod interest paid"}
_HEADER = re.compile(
    r"^(Page \d|USAA CLASSIC|for Account|Online:|Statement Period|"
    r"\d{8,12}\s*$|Date Description|Transactions)"
)


# USAA's own statement header, not just the word: a payment to "USAA
# INSURANCE" on another bank's statement must not route here.
_USAA_HEADER = re.compile(
    r"(?im)^\s*USAA\s+(?:CLASSIC\s+CHECKING|FEDERAL\s+SAVINGS\s+BANK)\b"
)
_LEGACY_PERIOD = re.compile(r"Statement Period[:\s]+(\d{2})/(\d{2})/(\d{4})")


def matches(text: str) -> bool:
    return bool(_USAA_HEADER.search(text)) and bool(
        _DEBIT_LINE.search(text) or re.search(r"(?m)\s0\s*$", text)
    )


def _legacy_date(month: int, day: int, text: str) -> date | None:
    """The legacy _parse_usaa_pdf year rule: the first Statement Period date's
    year, plus one for a month before that date's month (Dec to Jan)."""
    m = _LEGACY_PERIOD.search(text)
    if m is None:
        return None
    start_month, year = int(m.group(1)), int(m.group(3))
    try:
        return date(year + 1 if month < start_month else year, month, day)
    except ValueError:
        return None


def _amount(token: str) -> float:
    return float(token.replace(",", ""))


def parse(text: str, today: date | None = None) -> NormalizedStatement:
    lines = clean_lines(text)
    start, end = find_period(lines)
    n = len(lines)
    raw: list[tuple[int, int, float, str]] = []
    i = 0
    while i < n:
        m = _TXN.match(lines[i])
        if not m:
            i += 1
            continue
        month, day = int(m.group(1)), int(m.group(2))
        first = m.group(3).strip()
        parts: list[str] = []
        debit: float | None = None
        credit: float | None = None
        j = i + 1

        dm = _DEBIT_LINE.search(first)
        if dm:
            debit = _amount(dm.group(1))
            parts.append(_DEBIT_LINE.sub("", first).strip())
        elif _BOTH_ZERO.match(first):
            parts.append(re.sub(r"\s+0\s+0\s*$", "", first).strip())
        else:
            parts.append(first)
            while j < n:
                peek = lines[j]
                if _TXN.match(peek):
                    break
                if _HEADER.match(peek):
                    j += 1
                    continue
                dm2 = _DEBIT_LINE.search(peek)
                if dm2:
                    debit = _amount(dm2.group(1))
                    j += 1
                    break
                if _CREDIT_ONLY.match(peek) and "$" not in peek:
                    # Credit row: the next line is "$credit $balance".
                    if j + 1 < n:
                        cm = _MONEY.search(lines[j + 1])
                        if cm and not _TXN.match(lines[j + 1]):
                            credit = _amount(cm.group(1))
                    j += 1
                    break
                if _MONEY.search(peek):
                    j += 1
                    break
                if peek:
                    parts.append(peek)
                j += 1

        text_desc = " ".join(p for p in parts if p).strip()
        text_desc = re.sub(r"\b\d{6}\b", "", text_desc).strip()
        text_desc = re.sub(r"\*{3,}\S+", "", text_desc).strip()
        text_desc = re.sub(r"\s{2,}", " ", text_desc).strip()

        if text_desc and text_desc.lower() not in _SKIP_NAMES:
            if debit is not None and debit > 0:
                raw.append((month, day, -round(debit, 2), text_desc))
            elif credit is not None and credit > 0:
                raw.append((month, day, round(credit, 2), text_desc))
        i = j

    rows: list[RawRow] = []
    assumed = False
    has_period = _LEGACY_PERIOD.search(text) is not None
    for month, day, amount, description in raw:
        if has_period:
            d, was_assumed = _legacy_date(month, day, text), False
        else:
            d, was_assumed = resolve_date(None, month, day, start, end, today)
        assumed = assumed or was_assumed
        if d is not None:
            rows.append(RawRow(d, amount, desc(description)))
    last4, key = last4_and_key(text)
    return build_statement(
        parser=PARSER,
        account_kind="checking",
        rows=rows,
        start=start,
        end=end,
        last4=last4,
        key=key,
        warnings=["year_assumed"] if assumed else [],
    )
