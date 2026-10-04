"""Description masking, merchant keys, kinds and dedupe keys (design 4.5 and 5).

Pure functions. The raw bank string never leaves the parser: parsers call
mask_description() and store only its result.
"""

from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping, Sequence
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from .errors import SmartImportError
from .limits import MAX_DESCRIPTION_CHARS
from .seed_rules import apply_rules
from .types import ORIGINS, NormalizedStatement

_EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+")
_URL_RE = re.compile(r"\b[a-zA-Z][a-zA-Z0-9+.-]*://\S+")
_MASKED_TOKEN_RE = re.compile(r"\S*\*{3,}\S*")
_PHONE_RE = re.compile(r"(?<!\d)\(?\d{3}\)?[-. ]\d{3}[-. ]\d{4}(?!\d)")
_LONG_DIGITS_RE = re.compile(r"\d{5,}")
# Spaced or compact IBAN: two letters, two check digits, then 4-character groups.
_IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b")
# A numeric token: digit groups joined by dashes or dots (SSN, split card or account).
_NUMERIC_TOKEN_RE = re.compile(r"\d+(?:[-.]\d+)*")
_ISO_DATE_TOKEN_RE = re.compile(r"\d{4}-\d{2}-\d{2}")
_AMOUNT_TOKEN_RE = re.compile(r"\d+\.\d{2}")
_SEPARATED_DIGITS_MIN = 9


def _mask_separated_digit_runs(text: str) -> str:
    """Mask runs of numeric tokens that total 9 or more digits.

    Catches card and account numbers split by spaces, dashes or dots
    ("4111 1111 1111 1111", "123-45-6789"). ISO dates and plain amounts are
    never part of a run, so "2026-10-04" and "12.50" survive. Dates written
    with slashes and amounts with thousands commas never match a numeric token.
    """
    out: list[str] = []
    run: list[str] = []

    def flush() -> None:
        if run:
            digits = sum(c.isdigit() for tok in run for c in tok)
            out.append("#" if digits >= _SEPARATED_DIGITS_MIN else " ".join(run))
            run.clear()

    for tok in text.split():
        numeric = (
            _NUMERIC_TOKEN_RE.fullmatch(tok)
            and not _ISO_DATE_TOKEN_RE.fullmatch(tok)
            and not _AMOUNT_TOKEN_RE.fullmatch(tok)
        )
        if numeric:
            run.append(tok)
        else:
            flush()
            out.append(tok)
    flush()
    return " ".join(out)


_SPACES_RE = re.compile(r"\s+")


def mask_description(raw: str | None) -> str:
    """Return the description that is stored and shown.

    Removes e-mail addresses, URLs with a scheme and ``***`` masked tokens,
    replaces phone numbers, IBANs, digit groups separated by spaces, dashes or
    dots that total 9 or more digits, and runs of 5 or more digits with ``#``,
    collapses whitespace and caps the result at 120 characters.

    Last-4 forms ("XXXX1234", "*1234", "CARD ENDING 1234") are deliberately
    allowed through: they are display hints, not usable account numbers.
    """
    text = raw or ""
    text = _EMAIL_RE.sub(" ", text)
    text = _URL_RE.sub(" ", text)
    text = _MASKED_TOKEN_RE.sub(" ", text)
    text = _PHONE_RE.sub("#", text)
    text = _IBAN_RE.sub("#", text)
    text = _mask_separated_digit_runs(text)
    text = _LONG_DIGITS_RE.sub("#", text)
    text = _SPACES_RE.sub(" ", text).strip()
    return text[:MAX_DESCRIPTION_CHARS].rstrip()


# Leading processor and channel prefixes, stripped repeatedly (design 4.5).
_PREFIX_PATTERNS = tuple(
    re.compile(p)
    for p in (
        r"^(?:SQ|TST|SP|PAYPAL|GOOGLE)\s*\*\s*",
        r"^APLPAY\b\s*",
        r"^DEBIT CARD PURCHASE\b\s*",
        r"^DEBIT CARD\b\s*",
        r"^CHECK ?CARD\b\s*",
        r"^POS (?:DEBIT|PURCHASE)\b\s*",
        r"^POS\b\s*",
        r"^ACH (?:DEBIT|CREDIT)\b\s*",
        r"^ACH\b\s*",
        r"^PURCHASE AUTHORIZED ON \d{1,2}/\d{1,2}\s*",
        r"^RECURRING PAYMENT\b\s*",
        r"^RECURRING\b\s*",
    )
)
_KEY_TOKEN_LIMIT = 3


def merchant_key(raw: str | None) -> str:
    """Return the key that remembered rules and seed rules match on.

    Uppercases the masked description, strips leading processor prefixes, drops
    every token containing a digit, ``#``, ``*`` or ``/`` (or no letters at
    all) and keeps the first three tokens. Falls back to the masked
    description uppercased when nothing is left, or ``UNKNOWN`` when that is
    empty too.
    """
    masked = mask_description(raw)
    text = masked.upper()
    changed = True
    while changed:
        changed = False
        for pattern in _PREFIX_PATTERNS:
            stripped = pattern.sub("", text, count=1)
            if stripped != text:
                text = stripped.strip()
                changed = True
    tokens = [
        t
        for t in text.split()
        if not any(c.isdigit() or c in "#*/" for c in t) and any(c.isalpha() for c in t)
    ]
    key = " ".join(tokens[:_KEY_TOKEN_LIMIT])
    return key or masked.upper() or "UNKNOWN"


# ---------------------------------------------------------------------------
# Kind

# TRNTYPEs that say what the row is: they win over every keyword.
_OFX_SPECIFIC_KIND = {
    "SRVCHG": "fee",
    "FEE": "fee",
    "INT": "interest",
    "DIV": "income",
    "DEP": "income",
    "DIRECTDEP": "income",
    "XFER": "transfer",
}
# TRNTYPEs that only say which way money moved. A strong keyword on a negative
# amount (an interest or fee charge) beats them; otherwise they map as here.
_OFX_GENERIC_KIND = {
    "DEBIT": "expense",
    "POS": "expense",
    "CHECK": "expense",
    "ATM": "expense",
    "CASH": "expense",
    "PAYMENT": "expense",
    "DIRECTDEBIT": "expense",
    "REPEATPMT": "expense",
}

_PAYMENT_CARD_RE = re.compile(r"PAYMENT THANK YOU|\bAUTOPAY\b|\bONLINE PAYMENT\b")
# Checking-side payment to a card must not count as spending (design 5).
_PAYMENT_TO_CARD_RE = re.compile(
    r"\b(?:CREDIT CARD|CRD|CARD)\s+(?:AUTO\s?PAY|PAYMENT|PMT)\b"
    r"|\b(?:CAPITAL ONE|AMEX|AMERICAN EXPRESS|CHASE CARD|DISCOVER|CITI CARD|CITI|BARCLAYS"
    r"|SYNCHRONY|APPLE CARD|WELLS FARGO CARD|BANK OF AMERICA CARD|BOFA CARD)\b"
    r".{0,30}\b(?:AUTO\s?PAY|E-?PAYMENT|EPAY|PAYMENT|PMT)\b"
)
_INTEREST_RE = re.compile(r"\b(?:INTEREST|FINANCE) CHARGE\b")
_STRONG_FEE_RE = re.compile(r"\b(?:LATE|ANNUAL) FEE\b")
_FEE_RE = re.compile(r"\bFEE\b|\bFEES\b")
_INCOME_RE = re.compile(r"\bPAYROLL\b|\bDIRECT DEP(?:OSIT)?\b|\bSALARY\b")
_TRANSFER_RE = re.compile(r"\bTRANSFER\b|\bXFER\b|\bZELLE\b|\bVENMO\b|\bCASH APP\b")


def _strong_charge(text: str, amount: float) -> str | None:
    """Interest or fee for a charge line; a positive line is a credit back."""
    if amount >= 0:
        return None
    if _INTEREST_RE.search(text):
        return "interest"
    if _STRONG_FEE_RE.search(text):
        return "fee"
    return None


def infer_kind(
    description: str,
    amount: float,
    account_kind: str,
    ofx_trntype: str | None = None,
) -> str:
    """Return one of the seven kinds (design 4.5).

    Order: payments to a card; a specific OFX TRNTYPE (INT, FEE, SRVCHG, XFER,
    DEP, DIRECTDEP, DIV); a strong interest or fee keyword on a negative
    amount ("INTEREST CHARGE", "FINANCE CHARGE", "LATE FEE", "ANNUAL FEE"); a
    generic TRNTYPE (DEBIT, CREDIT, POS, PAYMENT and the other direction-only
    types); then keywords and sign. OTHER and unknown TRNTYPEs, and rows with
    none (CSV, PDF), use the keyword rules, so the same row gets the same kind
    from every format. Interest and fee keywords never apply to a positive
    amount: a positive "INTEREST CHARGE" on a card is a refund.
    """
    on_debt = account_kind in ("credit_card", "loan")
    text = (description or "").upper()

    # Card payments are never spending, whatever the sign or OFX TRNTYPE says.
    if account_kind == "credit_card" and "PAYMENT THANK YOU" in text:
        return "payment"
    if _PAYMENT_TO_CARD_RE.search(text):
        return "payment"

    trn = (ofx_trntype or "").strip().upper()
    specific = _OFX_SPECIFIC_KIND.get(trn)
    if specific is not None:
        # INT with a positive amount on a deposit account is interest earned.
        return specific

    strong = _strong_charge(text, amount)
    if strong is not None:
        return strong

    if trn == "CREDIT":
        if on_debt:
            return "payment" if _PAYMENT_CARD_RE.search(text) else "refund"
        return "income"
    generic = _OFX_GENERIC_KIND.get(trn)
    if generic is not None:
        return generic

    if on_debt and _PAYMENT_CARD_RE.search(text):
        return "payment"
    if amount < 0 and _FEE_RE.search(text):
        return "fee"
    if amount > 0 and _INCOME_RE.search(text):
        return "income"
    if _TRANSFER_RE.search(text):
        return "transfer"

    if amount < 0:
        return "expense"
    if account_kind == "credit_card":
        return "refund"
    if account_kind == "loan":
        return "payment"
    return "income"


# ---------------------------------------------------------------------------
# Dedupe


def _cents(amount: float | Decimal | str) -> int:
    return int(
        (Decimal(str(amount)) * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP)
    )


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def dedupe_base(
    posted_date: date | str,
    amount: float,
    merchant_key: str,
    description: str,
    occurrence: int,
    fitid: str | None = None,
) -> str:
    """Return the stable per-row hash. A FITID wins over every other field."""
    if fitid and fitid.strip():
        return _sha256("fitid|" + fitid.strip())
    parts = (
        str(posted_date),
        str(_cents(amount)),
        merchant_key,
        description,
        str(occurrence),
    )
    return _sha256("|".join(parts))


def assign_occurrences(rows: Sequence[Mapping[str, Any]]) -> list[int]:
    """Number identical (date, cents, key, description) rows in file order from 0."""
    seen: dict[tuple[str, int, str, str], int] = {}
    out: list[int] = []
    for row in rows:
        ident = (
            str(row["posted_date"]),
            _cents(row["amount"]),
            str(row["merchant_key"]),
            str(row["description"]),
        )
        n = seen.get(ident, 0)
        out.append(n)
        seen[ident] = n + 1
    return out


def account_key_from_number(institution: str | None, account_id: str) -> str:
    """Return ``acct:<sha256>``; the account number itself is never stored."""
    inst = (institution or "").strip().lower()
    digits = "".join(c for c in (account_id or "") if c.isdigit())
    return "acct:" + _sha256(f"finlity-acct-v1|{inst}|{digits}")


# ---------------------------------------------------------------------------
# Statement finalization (shared by every parser)

MAX_FILE_NAME_CHARS = 255


def safe_file_name(file_name: str | None) -> str:
    """Basename only (either slash style), capped at 255 characters."""
    return re.split(r"[\\/]", file_name or "")[-1][:MAX_FILE_NAME_CHARS]


def _context_origin(context: Mapping[str, Any] | None) -> str:
    origin = context.get("origin") if isinstance(context, Mapping) else None
    return origin if origin in ORIGINS else "file"


def _categorization_inputs(
    context: Mapping[str, Any] | None,
) -> tuple[Any, list[Mapping[str, Any]]]:
    ctx = context if isinstance(context, Mapping) else {}
    rules = ctx.get("rules")
    if rules is not None and not isinstance(rules, (list, dict)):
        raise SmartImportError("bad_context")
    categories = ctx.get("categories") or []
    if not isinstance(categories, list) or not all(
        isinstance(c, Mapping) and "id" in c and "name" in c for c in categories
    ):
        raise SmartImportError("bad_context")
    return rules, categories


def finalize_statement(
    stmt: NormalizedStatement,
    context: Mapping[str, Any] | None,
    file_name: str | None,
) -> NormalizedStatement:
    """The last step of every parser, so the contract cannot drift per format.

    Applies user and seed rules (category_id, category_source and a rule's
    kind), stores only the file name's basename capped at 255 characters, and
    sets ``origin`` from ``context["origin"]`` (one of ORIGINS, else "file").
    Mutates and returns ``stmt``.
    """
    rules, categories = _categorization_inputs(context)
    apply_rules(stmt["transactions"], rules, categories)  # type: ignore[arg-type]
    stmt["file_name"] = safe_file_name(file_name)
    stmt["origin"] = _context_origin(context)
    return stmt
