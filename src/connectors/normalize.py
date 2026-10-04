"""Mapping connected account data onto ``NormalizedStatement`` (design 5.2, E4).

``account_key_for`` and ``guess_kind`` are needed as soon as a provider lists
accounts (Task A3). ``to_statements`` (Task A4) turns a ``FetchResult`` into
the statements the smart import wizard previews and applies, ending each one
with ``smart_import.normalize.finalize_statement`` so categorization and the
contract cannot drift from file imports.

Rules settled in the A3 and A4 reviews:

* Card and loan balances: see ``PROVIDER_BALANCE_IS_HOLDER_SIDE``.
* ``external_id`` is ``<provider>:<transaction id>``. Stored dedupe keys are
  ``<account key>|<dedupe_base>`` (``ImportTransaction.dedupe_key``), so the
  same provider id in two accounts never collides. Inside one call, a repeated
  id under one account key is skipped (``rows_skipped``) only when the posted
  date and the amount in cents match too; otherwise it is kept under a salted
  id (see ``_IdLedger``).
* Dates: ``posted`` and the balance date stay the provider's UTC dates. A
  balance is dropped (``connector_balance_dropped``) only when it is undated
  or its date starts more than 24 hours after ``now`` (UTC), so a balance
  dated tomorrow by UTC (every evening west of UTC) is kept. The period runs
  from ``max(since, window start)``, clamped to the end, to the window end
  (or an earlier partial end); rows outside it are skipped (``rows_skipped``).
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Mapping, Sequence
from datetime import date, datetime, time, timedelta, timezone
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

from ..smart_import.normalize import (
    dedupe_base,
    finalize_statement,
    infer_kind,
    mask_description,
    merchant_key,
)
from ..smart_import.types import (
    ACCOUNT_KINDS,
    WARNINGS,
    ClosingBalance,
    NormalizedStatement,
    NormalizedTransaction,
)
from .errors import ConnectorError
from .types import AccountRequest, FetchedAccount, FetchResult

_KEY_PREFIX = "finlity-conn-v1|"

_CARD_WORDS = ("CARD", "VISA", "MASTERCARD", "AMEX")
_LOAN_WORDS = ("LOAN", "MORTGAGE")

_AKAHU_TYPES = {
    "CHECKING": "checking",
    "SAVINGS": "savings",
    "CREDITCARD": "credit_card",
    "LOAN": "loan",
}


def account_key_for(provider_id: str, provider_account_id: str) -> str:
    """``acct:`` plus a SHA-256 of provider and account id (E4).

    Independent of the Finlity connection id, so a reconnect keeps the same
    keys, and opaque, so the provider's account id never appears in a key.
    """
    raw = _KEY_PREFIX + provider_id + "|" + provider_account_id
    return "acct:" + hashlib.sha256(raw.encode("utf-8")).hexdigest()


def guess_kind(
    provider_id: str,
    name: str | None,
    provider_type: str | None,
    balance: Decimal | None,
) -> str:
    """A first guess at the account kind; the user's mapping wins later.

    Akahu reports a type, which maps directly. SimpleFIN has none, so the name
    decides: card words, then loan words, then SAVING, else checking. A
    negative checking balance is flagged to the user by the mapping step, not
    here, so ``balance`` is accepted for that caller and not used yet.
    """
    if provider_id == "akahu":
        return _AKAHU_TYPES.get((provider_type or "").upper(), "unknown")
    upper = (name or "").upper()
    if any(word in upper for word in _CARD_WORDS):
        return "credit_card"
    if any(word in upper for word in _LOAN_WORDS):
        return "loan"
    if "SAVING" in upper:
        return "savings"
    return "checking"


# ---------------------------------------------------------------------------
# Statements (Task A4)

# Whether providers report card and loan balances from the holder's side
# (negative when money is owed), like OFX LEDGERBAL. SimpleFIN's demo has no
# card, so this is an assumption, not an observation; Akahu documents credit
# card balances the same way. If a real card shows the opposite, flip this one
# flag: ``closing_amount`` is the only code that reads a balance's sign.
PROVIDER_BALANCE_IS_HOLDER_SIDE = True

_DEBT_KINDS = ("credit_card", "loan")
_DISPLAY_NAMES = {"simplefin": "SimpleFIN", "akahu": "Akahu", "demo": "Demo"}
_ISO_CURRENCY = re.compile(r"[A-Za-z]{3}")
# ApplyTransaction.external_id and ApplyAccount.institution caps.
MAX_EXTERNAL_ID_CHARS = 200
MAX_INSTITUTION_CHARS = 120
# A balance dated further ahead than this is not a real balance date.
_FUTURE_GRACE = timedelta(hours=24)

ROWS_SKIPPED = "rows_skipped"
ACCOUNT_ERROR = "connector_account_error"
PARTIAL = "connector_partial"
BALANCE_ONLY = "connector_balance_only"
CURRENCY_UNSUPPORTED = "currency_unsupported"
SIGN_CHECK = "connector_sign_check"
BALANCE_DROPPED = "connector_balance_dropped"


def closing_amount(kind: str, balance: Decimal, flip_balance: bool) -> Decimal:
    """The statement's closing balance in smart import's convention.

    Checking, savings and unknown: the plain balance. Card and loan: the
    amount owed, positive when owed (``ClosingBalance``), so a holder's-side
    provider balance is negated. ``flip_balance`` (the user's mapping) then
    negates the result for an account that reports the other way.
    """
    amount = balance
    if kind in _DEBT_KINDS and PROVIDER_BALANCE_IS_HOLDER_SIDE:
        amount = -amount
    return -amount if flip_balance else amount


def external_id_for(provider_id: str, txn_id: str) -> str:
    """``<provider>:<id>``, or ``<provider>:#<sha256 of id>`` when that would
    pass ``MAX_EXTERNAL_ID_CHARS``. Never truncated, since it is the dedupe
    input; a verbatim id that starts with ``#`` is hashed too, so the two
    forms cannot meet."""
    full = f"{provider_id}:{txn_id}"
    if len(full) <= MAX_EXTERNAL_ID_CHARS and not txn_id.startswith("#"):
        return full
    digest = hashlib.sha256(txn_id.encode("utf-8")).hexdigest()
    return f"{provider_id}:#{digest}"


def _currency_ok(currency: str) -> bool:
    return bool(_ISO_CURRENCY.fullmatch(currency or ""))


def _drop_reason(fetched: FetchedAccount | None) -> str | None:
    if fetched is None:
        return ACCOUNT_ERROR
    if fetched.error is not None:
        return fetched.error if fetched.error in WARNINGS else ACCOUNT_ERROR
    if not _currency_ok(fetched.currency):
        return CURRENCY_UNSUPPORTED
    return None


def _by_id(result: FetchResult) -> dict[str, FetchedAccount]:
    return {a.provider_account_id: a for a in result.accounts}


def dropped_accounts(
    result: FetchResult, accounts: Sequence[AccountRequest]
) -> list[dict[str, str]]:
    """Requested accounts that get no statement because of a problem, as
    ``{provider_account_id, code}`` for the sync response's
    ``account_errors`` (design 6.1). Codes only, in request order."""
    fetched = _by_id(result)
    out: list[dict[str, str]] = []
    seen: set[str] = set()
    for req in accounts:
        if req.provider_account_id in seen:
            continue
        seen.add(req.provider_account_id)
        reason = _drop_reason(fetched.get(req.provider_account_id))
        if reason is not None:
            out.append({"provider_account_id": req.provider_account_id, "code": reason})
    return out


def _utc(now: datetime) -> datetime:
    if not isinstance(now, datetime):
        raise TypeError("now must be a datetime")
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(timezone.utc)


def _balance_is_future(day: date, now_utc: datetime) -> bool:
    """True when the UTC day starts more than 24 hours after ``now``."""
    starts = datetime.combine(day, time.min, tzinfo=timezone.utc)
    return starts > now_utc + _FUTURE_GRACE


def _file_hash(fields: Mapping[str, Any]) -> str:
    text = json.dumps(fields, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _add(warnings: list[str], code: str) -> None:
    """Append a warning code once; a code outside the vocabulary is dropped."""
    if code in WARNINGS and code not in warnings:
        warnings.append(code)


def _carried_warnings(fetched: FetchedAccount) -> list[str]:
    """The provider's per-account warning codes, in order, without repeats."""
    out: list[str] = []
    for code in fetched.warnings:
        _add(out, code)
    return out


def _cents(amount: Decimal) -> int:
    return int((amount * 100).quantize(Decimal(1), rounding=ROUND_HALF_UP))


def _account_salt(provider_account_id: str) -> str:
    return hashlib.sha256(provider_account_id.encode("utf-8")).hexdigest()[:8]


class _IdLedger:
    """External ids already used under one account key in one call.

    A repeated provider id whose posted date and amount (in cents) also match
    an earlier row is a true duplicate and is skipped. Otherwise the row is a
    distinct transaction that happens to share the id (two accounts mapped
    onto one key, or a provider reusing ids), so it keeps a deterministic
    salted id: ``<id>~<sha256(account id)[:8]>``, then ``~2``, ``~3`` on
    further clashes. The first row always keeps the plain id.
    """

    def __init__(self) -> None:
        self.used: set[str] = set()
        self.seen: dict[str, set[tuple[str, int]]] = {}

    def assign(
        self,
        provider_id: str,
        provider_account_id: str,
        txn_id: str,
        ident: tuple[str, int],
    ) -> str | None:
        plain = external_id_for(provider_id, txn_id)
        group = self.seen.setdefault(plain, set())
        if ident in group:
            return None
        ext = plain
        if plain in self.used:
            salted = f"{txn_id}~{_account_salt(provider_account_id)}"
            ext = external_id_for(provider_id, salted)
            n = 2
            while ext in self.used:
                ext = external_id_for(provider_id, f"{salted}~{n}")
                n += 1
        group.add(ident)
        self.used.add(ext)
        return ext


def _row(
    index: int, posted: date, amount: Decimal, raw: str, account_kind: str, ext: str
) -> NormalizedTransaction:
    value = float(amount)
    desc = mask_description(raw)
    key = merchant_key(raw)
    day = posted.isoformat()
    return {
        "row": index,
        "posted_date": day,
        "amount": value,
        "description": desc,
        "merchant_key": key,
        "kind": infer_kind(raw, value, account_kind),
        "category_id": None,
        "category_source": "none",
        "external_id": ext,
        "dedupe_base": dedupe_base(day, value, key, desc, 0, fitid=ext),
    }


def to_statements(
    provider_id: str,
    result: FetchResult,
    accounts: Sequence[AccountRequest],
    window: tuple[date, date],
    context: Mapping[str, Any] | None,
    *,
    now: datetime,
) -> list[NormalizedStatement]:
    """One statement per requested account that has transactions or a
    balance (design 5.2). Accounts with a provider error or an unsupported
    currency get none; ``dropped_accounts`` reports them.

    ``window`` is the requested ``(start, end)``; when the provider stopped
    early (``result.end`` before ``end``) the period ends there and each
    statement warns ``connector_partial``. ``context`` is the analyze context
    (``rules``, ``categories``); ``origin`` is always ``connector``. ``now``
    (required, timezone-aware) is the caller's clock, used only to drop a
    balance dated in the future; the core never reads the wall clock.
    """
    label = _DISPLAY_NAMES.get(provider_id)
    if label is None:
        raise ConnectorError("bad_request")
    for req in accounts:
        if req.kind not in ACCOUNT_KINDS:
            raise ConnectorError("bad_request")
    now_utc = _utc(now)
    start, end = window
    partial = result.end is not None and result.end < end
    period_end = result.end if partial and result.end is not None else end
    file_name = f"{label} sync {period_end.isoformat()}"
    ctx = {**(context or {}), "origin": "connector"}
    fetched_by_id = _by_id(result)
    # External ids already used per account key in this call.
    used: dict[str, _IdLedger] = {}
    done: set[str] = set()
    out: list[NormalizedStatement] = []
    for req in accounts:
        if req.provider_account_id in done:
            continue
        done.add(req.provider_account_id)
        fetched = fetched_by_id.get(req.provider_account_id)
        if fetched is None or _drop_reason(fetched) is not None:
            continue
        stmt = _statement(
            provider_id,
            fetched,
            req,
            start,
            period_end,
            now_utc,
            used.setdefault(req.account_key, _IdLedger()),
        )
        if stmt is None:
            continue
        if partial:
            _add(stmt["warnings"], PARTIAL)
        out.append(finalize_statement(stmt, ctx, file_name))
    return out


def _statement(
    provider_id: str,
    fetched: FetchedAccount,
    req: AccountRequest,
    start: date,
    period_end: date,
    now_utc: datetime,
    ledger: _IdLedger,
) -> NormalizedStatement | None:
    kind = req.kind
    warnings = _carried_warnings(fetched)
    # The period never starts after it ends (a partial end before ``since``).
    period_start = min(max(req.since, start), period_end)
    transactions: list[NormalizedTransaction] = []
    for txn in fetched.transactions:
        if not txn.id.strip() or not period_start <= txn.posted <= period_end:
            _add(warnings, ROWS_SKIPPED)
            continue
        ext = ledger.assign(
            provider_id,
            fetched.provider_account_id,
            txn.id,
            (txn.posted.isoformat(), _cents(txn.amount)),
        )
        if ext is None:
            _add(warnings, ROWS_SKIPPED)
            continue
        raw = txn.description or txn.payee or ""
        transactions.append(
            _row(len(transactions), txn.posted, txn.amount, raw, kind, ext)
        )

    closing: ClosingBalance | None = None
    closing_dec: Decimal | None = None
    day = fetched.balance_date
    if (
        fetched.balance is not None
        and day is not None
        and not _balance_is_future(day, now_utc)
    ):
        closing_dec = closing_amount(kind, fetched.balance, req.flip_balance)
        closing = {"amount": float(closing_dec), "as_of": day.isoformat()}
    elif fetched.balance is not None:
        _add(warnings, BALANCE_DROPPED)  # undated, or dated in the future

    if not transactions and closing is None:
        return None
    if not transactions:
        _add(warnings, BALANCE_ONLY)
    if _sign_looks_wrong(kind, req.flip_balance, closing_dec, transactions):
        _add(warnings, SIGN_CHECK)

    institution = mask_description(fetched.institution)[:MAX_INSTITUTION_CHARS] or None
    file_hash = _file_hash(
        {
            "provider": provider_id,
            "account_key": req.account_key,
            "start": period_start.isoformat(),
            "end": period_end.isoformat(),
            "rows": sorted(
                [t["external_id"] or "", _cents(Decimal(str(t["amount"])))]
                for t in transactions
            ),
            "balance": None if closing_dec is None else str(closing_dec),
            "balance_date": None if closing is None else closing["as_of"],
        }
    )
    return {
        "file_hash": file_hash,
        "file_name": "",
        "origin": "connector",
        "format": "connector",
        "parser": f"connector:{provider_id}",
        "account": {
            "kind": kind,
            "key": req.account_key,
            "last4": None,
            "institution": institution,
        },
        "period": {"start": period_start.isoformat(), "end": period_end.isoformat()},
        "closing_balance": closing,
        "extras": None,
        "warnings": warnings,
        "transactions": transactions,
    }


def _sign_looks_wrong(
    kind: str,
    flip_balance: bool,
    closing: Decimal | None,
    transactions: Sequence[NormalizedTransaction],
) -> bool:
    """A card that reads as in credit while most of its rows are charges
    probably reports the other sign. Only a hint: never flipped here."""
    if kind != "credit_card" or flip_balance or closing is None or closing >= 0:
        return False
    if not transactions:
        return False
    charges = sum(1 for t in transactions if t["amount"] < 0)
    return charges * 2 > len(transactions)
