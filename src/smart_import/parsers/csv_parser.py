"""CSV statement parser (design 4.2).

Stateless: bytes in, NormalizedStatement (or a needs_mapping answer) out.
Cells are only ever read as strings and parsed with strict patterns, never
evaluated, so spreadsheet formulas stay inert. Nothing here logs content.
"""

from __future__ import annotations

import csv
import hashlib
import io
import itertools
import re
from collections.abc import Iterator, Mapping
from datetime import date, datetime
from typing import Any, TypedDict

from ..errors import SmartImportError
from ..limits import (
    MAX_CSV_COLUMNS,
    MAX_CSV_FIELD_CHARS,
    MAX_CSV_ROWS,
    MAX_DESCRIPTION_CHARS,
    MAX_TRANSACTIONS_PER_STATEMENT,
)
from ..normalize import (
    assign_occurrences,
    dedupe_base,
    finalize_statement,
    infer_kind,
    mask_description,
    merchant_key,
)
from ..seed_rules import seed_category_name
from ..types import ACCOUNT_KINDS, NormalizedStatement

HEADER_SCAN_ROWS = 30
SNIFF_BYTES = 8192
SAMPLE_ROWS = 3
# Columns returned in a needs_mapping answer; real exports have far fewer.
MAPPING_MAX_COLUMNS = 64
DELIMITERS = (",", ";", "\t", "|")

_HEADER_NAMES: dict[str, frozenset[str]] = {
    "date": frozenset(
        {
            "date",
            "transaction date",
            "posted date",
            "post date",
            "posting date",
            "trans date",
        }
    ),
    "description": frozenset(
        {
            "description",
            "merchant",
            "payee",
            "name",
            "memo",
            "details",
            "transaction description",
        }
    ),
    "amount": frozenset({"amount", "transaction amount"}),
    "debit": frozenset({"debit", "withdrawal", "withdrawals", "money out", "charges"}),
    "credit": frozenset({"credit", "deposit", "deposits", "money in", "payments"}),
    "type": frozenset({"type", "transaction type", "dr/cr"}),
    "balance": frozenset({"balance", "running balance"}),
    "bank_category": frozenset({"category"}),
}
_FIELDS = tuple(_HEADER_NAMES)
_MAPPABLE = tuple(f for f in _FIELDS if f != "bank_category")

# Date formats grouped by order. Within a group, earlier is tried first.
_FORMATS: dict[str, tuple[str, ...]] = {
    "ymd": ("%Y-%m-%d", "%Y/%m/%d"),
    "mdy": ("%m/%d/%Y", "%m/%d/%y", "%b %d, %Y"),
    "dmy": ("%d/%m/%Y", "%d.%m.%Y", "%d %b %Y", "%d/%m/%y"),
}
_DEFAULT_ORDER = ("ymd", "mdy", "dmy")
_TIME_TAIL = re.compile(
    r"[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\s*(?:Z|[AP]M)?$", re.IGNORECASE
)

_CURRENCY = re.compile(r"[$€£¥]|USD|EUR|GBP|CAD|AUD", re.IGNORECASE)
_PLAIN_NUMBER = re.compile(r"^\d+(?:\.\d+)?$")
_COMMA_DECIMAL = re.compile(r"^\d+(?:\.\d{3})*,\d{2}$")
_FORMULA_LEAD = "=+-@\t\r"

_DEBIT_TYPES = frozenset({"debit", "dr", "d", "withdrawal", "withdrawals"})
_CREDIT_TYPES = frozenset({"credit", "cr", "c", "deposit", "deposits"})


class NeedsMapping(TypedDict):
    """Returned when the layout cannot be recognized; the wizard shows a column picker."""

    status: str
    headers: list[str]
    sample_rows: list[list[str]]


# ---------------------------------------------------------------------------
# Small helpers


def _norm_header(cell: str) -> str:
    return re.sub(r"\s+", " ", cell.replace("﻿", "").strip().lower())


def _clean_cell(cell: str) -> str:
    """Trim and drop leading formula-trigger characters so a cell can never
    start a formula if the text is exported or pasted into a spreadsheet."""
    return cell.strip().lstrip(_FORMULA_LEAD).strip()


def _decode(content: bytes) -> str:
    try:
        return content.decode("utf-8-sig")
    except UnicodeDecodeError:
        return content.decode("cp1252", errors="replace")


def _check_context(context: Mapping[str, Any] | None) -> dict[str, Any]:
    ctx = dict(context or {})
    flip = ctx.get("flip_sign")
    if flip is not None and not isinstance(flip, bool):
        raise SmartImportError("bad_context")
    order = ctx.get("date_order")
    if order is not None and order not in _FORMATS:
        raise SmartImportError("bad_context")
    kind = ctx.get("account_kind")
    if kind is not None and kind not in ACCOUNT_KINDS:
        raise SmartImportError("bad_context")
    for key in ("rules", "categories"):
        if ctx.get(key) is not None and not isinstance(ctx[key], (list, dict)):
            raise SmartImportError("bad_context")
    mapping = ctx.get("mapping")
    if mapping is not None:
        if not isinstance(mapping, dict) or not all(
            k in _MAPPABLE and isinstance(v, str) and v.strip()
            for k, v in mapping.items()
        ):
            raise SmartImportError("bad_context")
    return ctx


def _make_reader(text: str, delimiter: str) -> Iterator[list[str]]:
    return csv.reader(io.StringIO(text, newline=""), delimiter=delimiter)


def _candidate_delimiters(text: str) -> list[str]:
    order: list[str] = []
    try:
        sniffed = (
            csv.Sniffer()
            .sniff(text[:SNIFF_BYTES], delimiters="".join(DELIMITERS))
            .delimiter
        )
        order.append(sniffed)
    except csv.Error:
        pass
    order.extend(d for d in DELIMITERS if d not in order)
    return order


def _check_row(row: list[str]) -> None:
    """Apply the per-row column cap and per-field size cap."""
    if len(row) > MAX_CSV_COLUMNS:
        raise SmartImportError("unreadable")
    for cell in row:
        if len(cell) > MAX_CSV_FIELD_CHARS:
            raise SmartImportError("field_too_large")


def _first_rows(text: str, delimiter: str) -> list[list[str]]:
    rows: list[list[str]] = []
    try:
        for row in itertools.islice(_make_reader(text, delimiter), HEADER_SCAN_ROWS):
            _check_row(row)
            rows.append(row)
    except csv.Error as exc:
        raise _csv_error(exc) from None
    return rows


def _csv_error(exc: csv.Error) -> SmartImportError:
    if "field larger" in str(exc):
        return SmartImportError("field_too_large")
    return SmartImportError("unreadable")


def _recognized(row: list[str]) -> dict[str, int]:
    """Map field name to column index for recognized headers (first wins)."""
    found: dict[str, int] = {}
    for idx, cell in enumerate(row):
        name = _norm_header(cell)
        for field, names in _HEADER_NAMES.items():
            if name in names and field not in found:
                found[field] = idx
                break
    return found


def _shape_ok(cols: Mapping[str, int]) -> bool:
    has_amount = "amount" in cols or "debit" in cols or "credit" in cols
    return "date" in cols and "description" in cols and has_amount


def _find_header(rows: list[list[str]]) -> tuple[int, dict[str, int]] | None:
    """First row with at least two recognized header names (design 4.2)."""
    for idx, row in enumerate(rows):
        cols = _recognized(row)
        if len(cols) >= 2:
            return idx, cols
    return None


def _mapping_label(cell: str) -> str:
    """Header text as needs_mapping shows it, normalized for comparison.

    The wizard sends back the masked header it was shown, so a mapping is
    matched on this form; a raw header name gives the same label too.
    """
    return _norm_header(mask_description(_clip(cell)))


def _find_mapped_header(
    rows: list[list[str]], mapping: Mapping[str, str]
) -> tuple[int, dict[str, int]] | None:
    wanted = {field: _mapping_label(name) for field, name in mapping.items()}
    for idx, row in enumerate(rows):
        norm = [_mapping_label(c) for c in row]
        if all(name in norm for name in wanted.values()):
            return idx, {field: norm.index(name) for field, name in wanted.items()}
    return None


def _needs_mapping(rows: list[list[str]], header_idx: int | None) -> NeedsMapping:
    nonblank = [(i, r) for i, r in enumerate(rows) if any(c.strip() for c in r)]
    if not nonblank:
        raise SmartImportError("unreadable")
    start = header_idx if header_idx is not None else nonblank[0][0]
    headers = _shown_cells(rows[start])
    samples = [_shown_cells(r) for i, r in nonblank if i > start][:SAMPLE_ROWS]
    return {"status": "needs_mapping", "headers": headers, "sample_rows": samples}


def _shown_cells(row: list[str]) -> list[str]:
    """Cells as a needs_mapping answer may show them: clipped, masked, capped.

    Masking removes card, account and SSN-shaped numbers, e-mail addresses and
    URLs; dates and ordinary amounts survive so the columns stay recognizable.
    """
    return [mask_description(_clip(c)) for c in row[:MAPPING_MAX_COLUMNS]]


def _clip(cell: str) -> str:
    """Sample cells keep a leading minus before a number (it is a sign, not a
    formula) but lose any other formula-trigger lead."""
    text = cell.strip()
    while text and (
        text[0] in "=+@\t\r" or (text[0] == "-" and not re.match(r"-[\d.$(]", text))
    ):
        text = text[1:].lstrip()
    return text[:MAX_DESCRIPTION_CHARS]


# ---------------------------------------------------------------------------
# Value parsing


def _money_text(raw: str) -> str:
    return _CURRENCY.sub("", raw).replace(" ", "").replace(" ", "").strip()


def _strip_sign(text: str) -> tuple[str, bool]:
    """Return (digits-and-separators, negative) from parentheses, +/- and trailing minus."""
    negative = False
    if text.startswith("(") and text.endswith(")"):
        negative, text = True, text[1:-1]
    if text.endswith("-"):
        negative, text = True, text[:-1]
    if text.startswith("-"):
        negative, text = True, text[1:]
    elif text.startswith("+"):
        text = text[1:]
    return text, negative


def _uses_decimal_comma(cells: list[str]) -> bool:
    bodies = [_strip_sign(_money_text(c))[0] for c in cells if _money_text(c)]
    return bool(bodies) and all(_COMMA_DECIMAL.match(b) for b in bodies)


def _parse_money(raw: str, decimal_comma: bool) -> float | None:
    text = _money_text(raw)
    if not text:
        return None
    body, negative = _strip_sign(text)
    if decimal_comma:
        body = body.replace(".", "").replace(",", ".")
    else:
        body = body.replace(",", "")
    if not _PLAIN_NUMBER.match(body):
        return None
    value = float(body)
    return -value if negative else value


def _date_text(raw: str) -> str:
    return _TIME_TAIL.sub("", raw.strip())


def _try_format(texts: list[str], fmt: str) -> list[date | None]:
    out: list[date | None] = []
    for t in texts:
        try:
            out.append(datetime.strptime(t, fmt).date())
        except ValueError:
            out.append(None)
    return out


def _choose_dates(
    raw_dates: list[str], date_order: str | None
) -> tuple[list[date | None], bool]:
    """Pick the first format that parses every non-empty date.

    Returns (parsed dates, ambiguous). When no format covers every date the
    best-covering one is used if it parses at least half; other rows are
    skipped by the caller. Ambiguous means month-first was chosen although
    day-first also parses every date.
    """
    texts = [_date_text(d) for d in raw_dates]
    present = [t for t in texts if t]
    if not present:
        return [None] * len(texts), False
    groups = (date_order,) if date_order else _DEFAULT_ORDER
    formats = [(g, f) for g in groups for f in _FORMATS[g]]

    best: tuple[int, str, str, list[date | None]] | None = None
    for group, fmt in formats:
        parsed = _try_format(texts, fmt)
        hits = sum(1 for t, p in zip(texts, parsed, strict=True) if t and p is not None)
        if hits == len(present):
            return parsed, _is_ambiguous(group, texts, date_order)
        if best is None or hits > best[0]:
            best = (hits, group, fmt, parsed)
    assert best is not None
    if best[0] * 2 >= len(present) and best[0] > 0:
        return best[3], False
    return [None] * len(texts), False


def _is_ambiguous(group: str, texts: list[str], date_order: str | None) -> bool:
    if date_order is not None or group != "mdy":
        return False
    for fmt in _FORMATS["dmy"]:
        parsed = _try_format(texts, fmt)
        if all(p is not None for t, p in zip(texts, parsed, strict=True) if t):
            return True
    return False


# ---------------------------------------------------------------------------
# Row extraction


def _cell(row: list[str], cols: Mapping[str, int], field: str) -> str:
    idx = cols.get(field)
    if idx is None or idx >= len(row):
        return ""
    return row[idx]


def _data_rows(text: str, delimiter: str, header_idx: int) -> list[list[str]]:
    rows: list[list[str]] = []
    try:
        for n, row in enumerate(_make_reader(text, delimiter)):
            _check_row(row)
            if n <= header_idx or not any(c.strip() for c in row):
                continue
            rows.append(row)
            if len(rows) > MAX_CSV_ROWS:
                raise SmartImportError("too_many_rows")
    except csv.Error as exc:
        raise _csv_error(exc) from None
    return rows


def _signed_amounts(
    rows: list[list[str]], cols: Mapping[str, int], decimal_comma: bool
) -> tuple[list[float | None], bool]:
    """Return per-row signed amounts and whether the file has one amount column."""
    single = "amount" in cols
    amounts: list[float | None] = []
    for row in rows:
        if single:
            value = _parse_money(_cell(row, cols, "amount"), decimal_comma)
            kind = _norm_header(_cell(row, cols, "type")) if "type" in cols else ""
            if value is not None and kind in _DEBIT_TYPES:
                value = -abs(value)
            elif value is not None and kind in _CREDIT_TYPES:
                value = abs(value)
            amounts.append(value)
            continue
        debit = _parse_money(_cell(row, cols, "debit"), decimal_comma)
        credit = _parse_money(_cell(row, cols, "credit"), decimal_comma)
        if debit is None and credit is None:
            amounts.append(None)
        else:
            amounts.append(abs(credit or 0.0) - abs(debit or 0.0))
    typed = single and "type" in cols
    return amounts, single and not typed


def _rule_keys(rules: Any) -> dict[str, Any]:
    if isinstance(rules, dict):
        return {str(k): v for k, v in rules.items()}
    out: dict[str, Any] = {}
    for row in rules or []:
        if isinstance(row, Mapping) and row.get("merchant_key"):
            out[str(row["merchant_key"])] = row
    return out


def _auto_flip(entries: list[dict[str, Any]], rules: Any, account_kind: str) -> bool:
    """True when the file uses positive for spending (design 4.2)."""
    user = _rule_keys(rules)
    matched = [
        e
        for e in entries
        if (
            (
                e["merchant_key"] in user
                and user[e["merchant_key"]].get("kind") in (None, "expense")
            )
            or e["merchant_key"] not in user
            and seed_category_name(e["merchant_key"]) is not None
        )
    ]
    if matched:
        positive = sum(1 for e in matched if e["amount"] > 0)
        return positive * 2 > len(matched)
    if account_kind == "credit_card" and entries:
        positive = sum(1 for e in entries if e["amount"] > 0)
        return positive * 2 > len(entries)
    return False


# ---------------------------------------------------------------------------
# Public entry point


def parse_csv(
    content: bytes, file_name: str, context: Mapping[str, Any] | None
) -> NormalizedStatement | NeedsMapping:
    """Parse a bank or card CSV export.

    ``context`` keys (all optional): ``rules`` and ``categories`` for
    categorization, ``mapping`` ({field: header name}) after a needs_mapping
    answer, ``account_kind``, ``flip_sign`` (bool, overrides detection) and
    ``date_order`` (``ymd``, ``mdy`` or ``dmy``).
    """
    ctx = _check_context(context)
    text = _decode(content)
    account_kind = ctx.get("account_kind") or "unknown"
    mapping = ctx.get("mapping")

    header_idx = 0
    cols: dict[str, int] = {}
    delimiter = ","
    first: list[list[str]] = []
    found = False
    delimiters = _candidate_delimiters(text)
    scanned: dict[str, list[list[str]]] = {}
    for delimiter in delimiters:
        first = scanned[delimiter] = _first_rows(text, delimiter)
        hit = _find_mapped_header(first, mapping) if mapping else _find_header(first)
        if hit is not None and _shape_ok(hit[1]):
            header_idx, cols = hit
            found = True
            break
    if not found:
        # Report against the delimiter that exposed the most recognized headers.
        best_rows: list[list[str]] = []
        best_idx: int | None = None
        best_score = -1
        for d in delimiters:
            rows = scanned[d]
            hit = _find_header(rows)
            score = len(hit[1]) if hit else 0
            if score > best_score or not best_rows:
                best_rows, best_idx, best_score = rows, hit[0] if hit else None, score
        return _needs_mapping(best_rows, best_idx)

    rows = _data_rows(text, delimiter, header_idx)
    if not rows:
        raise SmartImportError("unreadable")

    money_cells = [
        _cell(r, cols, f)
        for r in rows
        for f in ("amount", "debit", "credit", "balance")
    ]
    decimal_comma = _uses_decimal_comma(money_cells)
    amounts, auto_ok = _signed_amounts(rows, cols, decimal_comma)
    parsed_dates, ambiguous = _choose_dates(
        [_cell(r, cols, "date") for r in rows], ctx.get("date_order")
    )

    entries: list[dict[str, Any]] = []
    skipped = 0
    for row, amount, posted in zip(rows, amounts, parsed_dates, strict=True):
        if amount is None or posted is None:
            skipped += 1
            continue
        description = mask_description(_clean_cell(_cell(row, cols, "description")))
        key = merchant_key(_clean_cell(_cell(row, cols, "description")))
        balance = _parse_money(_cell(row, cols, "balance"), decimal_comma)
        entries.append(
            {
                "posted_date": posted,
                "amount": round(amount, 2),
                "description": description,
                "merchant_key": key,
                "balance": balance,
            }
        )
    if not entries:
        return _needs_mapping(first, header_idx)
    if len(entries) > MAX_TRANSACTIONS_PER_STATEMENT:
        raise SmartImportError("too_many_rows")

    warnings: list[str] = []
    if ambiguous:
        warnings.append("date_order_assumed")
    if skipped:
        warnings.append("rows_skipped")

    flip = ctx.get("flip_sign")
    if flip is None and auto_ok:
        flip = _auto_flip(entries, ctx.get("rules"), account_kind)
    if flip:
        for e in entries:
            e["amount"] = round(-e["amount"], 2)
        warnings.append("sign_flipped")

    statement = _build_statement(content, account_kind, entries, warnings, bool(flip))
    return finalize_statement(statement, ctx, file_name)


def _balance_owed_sign(entries: list[dict[str, Any]], flipped: bool) -> int:
    """+1 when a card or loan balance column is the amount owed, -1 when it is
    from the holder's side (owed shown negative).

    Read from the running balance: a balance that moves with the (final,
    spending negative) amounts is the holder's side, one that moves against
    them is the issuer's. Both file orders are tried for each adjacent pair.
    With no evidence, a sign-flipped file (positive spending, the issuer's
    convention) is taken as owed positive and any other file as the holder's.
    """
    votes = 0
    for a, b in zip(entries, entries[1:]):
        if a["balance"] is None or b["balance"] is None:
            continue
        delta = b["balance"] - a["balance"]
        for moved, amount in ((delta, b["amount"]), (-delta, a["amount"])):
            if not amount:
                continue
            if abs(moved - amount) < 0.005:
                votes -= 1
            elif abs(moved + amount) < 0.005:
                votes += 1
    if votes:
        return 1 if votes > 0 else -1
    return 1 if flipped else -1


def _build_statement(
    content: bytes,
    account_kind: str,
    entries: list[dict[str, Any]],
    warnings: list[str],
    flipped: bool,
) -> NormalizedStatement:
    """Assemble the statement; the caller finalizes it (rules, name, origin)."""
    occurrences = assign_occurrences(entries)
    txs: list[dict[str, Any]] = []
    for n, (e, occ) in enumerate(zip(entries, occurrences, strict=True)):
        posted = e["posted_date"].isoformat()
        txs.append(
            {
                "row": n,
                "posted_date": posted,
                "amount": e["amount"],
                "description": e["description"],
                "merchant_key": e["merchant_key"],
                "kind": infer_kind(e["description"], e["amount"], account_kind),
                "category_id": None,
                "category_source": "none",
                "external_id": None,
                "dedupe_base": dedupe_base(
                    posted, e["amount"], e["merchant_key"], e["description"], occ
                ),
            }
        )
    dates = [e["posted_date"] for e in entries]
    closing = None
    with_balance = [(i, e) for i, e in enumerate(entries) if e["balance"] is not None]
    if with_balance:
        _, latest = max(with_balance, key=lambda ie: (ie[1]["posted_date"], ie[0]))
        bal = latest["balance"]
        if account_kind in ("credit_card", "loan"):
            bal = bal * _balance_owed_sign(entries, flipped)
        closing = {"amount": round(bal, 2), "as_of": latest["posted_date"].isoformat()}

    return {
        "file_hash": hashlib.sha256(content).hexdigest(),
        "file_name": "",
        "origin": "file",
        "format": "csv",
        "parser": "csv",
        "account": {
            "kind": account_kind,
            "key": None,
            "last4": None,
            "institution": None,
        },
        "period": {"start": min(dates).isoformat(), "end": max(dates).isoformat()},
        "closing_balance": closing,  # type: ignore[typeddict-item]
        "extras": None,
        "warnings": warnings,
        "transactions": txs,  # type: ignore[typeddict-item]
    }
