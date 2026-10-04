"""Generic line-oriented statement layout (design 4.4 step 3).

A transaction line starts with a date and ends with one or two money tokens
(amount, optional running balance). Following lines without a date or money are
appended to the description. Anything else yields no rows and the caller falls
back to ``needs_ai_layout``.
"""

from __future__ import annotations

import re
from datetime import date

from ...types import NormalizedStatement
from ._common import (
    DATE_TOKEN,
    RawRow,
    build_statement,
    clean_lines,
    desc,
    find_period,
    last4_and_key,
    parse_date_token,
    parse_money,
    resolve_date,
    split_trailing_money,
    Money,
)

NAME = "generic_lines"
PARSER = "pdf:generic_lines"

_LINE_RE = re.compile(rf"^({DATE_TOKEN})(?:\s+({DATE_TOKEN}))?\s+(.+)$")
_CARD_RE = re.compile(r"(?i)new balance|minimum payment|payment due date|credit limit")
_CLOSING_RE = re.compile(
    r"(?i)\b(?:new|statement|ending|closing)\s+balance\b[^\d$(\-]{0,20}"
    r"(\(?-?\$?\s?\d[\d,]*\.\d{2}\)?-?(?:\s?(?:CR|DR)\b)?)"
)
_OPENING_RE = re.compile(
    r"(?i)\b(?:beginning|previous|opening)\s+balance\b[^\d$(\-]{0,20}(\(?-?\$?\s?\d[\d,]*\.\d{2}\)?-?)"
)
_MIN_RE = re.compile(
    r"(?i)minimum\s+payment(?:\s+due)?\b[^\d$(\-]{0,20}(\(?-?\$?\s?\d[\d,]*\.\d{2}\)?-?)"
)
_DUE_RE = re.compile(r"(?i)due\s+date\b[^\dA-Za-z]{0,10}(.{0,30})")
_SUMMARY_DESC_RE = re.compile(
    r"(?i)^(?:(?:new|previous|beginning|ending|opening|closing|statement)\s+balance|total\b|"
    r"minimum payment|payment due|balance (?:forward|brought))"
)
_STOP_CONT_RE = re.compile(
    r"(?i)^(?:page\s+\d|total\b|new balance|ending balance|fees? charged)"
)
_CREDIT_WORDS_RE = re.compile(
    r"(?i)deposit|payroll|direct dep|refund|credit|interest paid|transfer from"
)
_MAX_CONTINUATIONS = 2


def matches(text: str) -> bool:
    return True  # last resort; the caller checks that rows came out


def _closing(text: str, pattern: re.Pattern[str]) -> Money | None:
    m = pattern.search(text)
    return parse_money(m.group(1)) if m else None


def parse(text: str, today: date | None = None) -> NormalizedStatement:
    lines = clean_lines(text)
    start, end = find_period(lines)
    is_card = bool(_CARD_RE.search(text))
    account_kind = "credit_card" if is_card else "checking"

    # (year or None, month, day, amount, running balance, description)
    raw: list[tuple[int | None, int, int, Money, float | None, str]] = []
    i, n = 0, len(lines)
    while i < n:
        m = _LINE_RE.match(lines[i])
        if not m:
            i += 1
            continue
        date_tok = m.group(2) or m.group(1)
        rest, tokens = split_trailing_money(m.group(3))
        if not tokens or not rest or _SUMMARY_DESC_RE.match(rest):
            i += 1
            continue
        parts = [rest]
        j = i + 1
        while j < n and len(parts) <= _MAX_CONTINUATIONS:
            nxt = lines[j]
            if not nxt or _LINE_RE.match(nxt) or _STOP_CONT_RE.match(nxt):
                break
            if split_trailing_money(nxt)[1]:
                break
            parts.append(nxt)
            j += 1
        try:
            year, month, day = parse_date_token(date_tok)
        except ValueError:
            i = j
            continue
        amount = tokens[0]
        balance = tokens[1].value if len(tokens) > 1 else None
        raw.append((year, month, day, amount, balance, " ".join(parts)))
        i = j

    opening = _closing(text, _OPENING_RE)
    prev_balance = opening.value if opening and not is_card else None
    warnings: list[str] = []
    rows: list[RawRow] = []
    year_assumed = False
    sign_assumed = False
    for year, month, day, money, balance, description in raw:
        posted, was_assumed = resolve_date(year, month, day, start, end, today)
        year_assumed = year_assumed or was_assumed
        if posted is None:
            continue
        if is_card:
            credit = money.printed in ("neg", "cr")
            signed = money.value if credit else -money.value
        else:
            signed = _checking_sign(money, balance, prev_balance, description)
            if money.printed is None and (balance is None or prev_balance is None):
                sign_assumed = True
        if balance is not None:
            prev_balance = balance
        rows.append(RawRow(posted, round(signed, 2), desc(description)))

    if year_assumed:
        warnings.append("year_assumed")
    if sign_assumed:
        warnings.append("sign_assumed")

    closing = None
    cb = _closing(text, _CLOSING_RE)
    if cb is not None:
        as_of = end or (max((r.posted for r in rows), default=None))
        if as_of is not None:
            # Card: printed positive is owed, a minus or CR is a credit
            # balance (owed < 0). Checking: a minus or DR is overdrawn.
            credit_marks = ("neg", "cr") if is_card else ("neg", "dr")
            amt = -cb.value if cb.printed in credit_marks else cb.value
            closing = (amt, as_of.isoformat())

    extras: dict[str, float | str] = {}
    if is_card:
        mp = _closing(text, _MIN_RE)
        if mp is not None:
            extras["minimum_payment"] = mp.value
        dm = _DUE_RE.search(text)
        if dm:
            for tok in re.finditer(rf"{DATE_TOKEN}", dm.group(1)):
                try:
                    y, mo, d = parse_date_token(tok.group(0))
                except ValueError:
                    continue
                due, _ = resolve_date(y, mo, d, None, end, today)
                if due is not None:
                    # A year-less due date before the closing date is in the next year.
                    if y is None and end is not None and due < end:
                        due = date(due.year + 1, due.month, due.day)
                    extras["payment_due"] = due.isoformat()
                break

    last4, key = last4_and_key(text)
    return build_statement(
        parser=PARSER,
        account_kind=account_kind,
        rows=rows,
        start=start,
        end=end,
        last4=last4,
        key=key,
        closing=closing,
        extras=extras,
        warnings=warnings,
    )


def _checking_sign(
    money: Money, balance: float | None, prev_balance: float | None, description: str
) -> float:
    if money.printed in ("neg", "dr"):
        return -money.value
    if money.printed == "cr":
        return money.value
    if balance is not None and prev_balance is not None:
        delta = round(balance - prev_balance, 2)
        if abs(abs(delta) - money.value) < 0.005:
            return money.value if delta > 0 else -money.value
    return money.value if _CREDIT_WORDS_RE.search(description) else -money.value
