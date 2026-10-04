"""Akahu personal app provider (design 2.2, 5.1, 8.1 to 8.3).

The user creates a personal app at my.akahu.nz and pastes its two tokens: the
User Access Token (sent as ``Authorization: Bearer``) and the App ID Token
(sent as ``X-Akahu-Id``). Nothing is claimed. Only ``GET /v1/accounts`` and
``GET /v1/transactions`` are requested; the allowlisted client refuses any
other method or path, so a token that could also move money never does here.
Pending transactions and manual refreshes are never requested, so Akahu's one
hour manual refresh rest period never applies.

Decisions recorded here:

- Akahu's ``start`` is exclusive and ``end`` inclusive, both ISO 8601, and
  dates come back in UTC. A window of whole UTC days ``start`` to ``end`` is
  sent as ``start = <day before start>T23:59:59.999Z`` and
  ``end = <end>T23:59:59.999Z``, the same on every page. A transaction's day
  is the UTC date of its ``date``; rows outside the window are dropped.
- ``/v1/transactions`` covers every account, so ``fetch`` first reads
  ``/v1/accounts`` (status, balance, currency; a revoked token fails there
  before any page) and then groups rows by ``_account``. Rows for accounts
  that were not requested are dropped. An account whose ``status`` is not
  exactly ``ACTIVE`` (``INACTIVE``, missing or unknown), or a requested
  account Akahu no longer lists, is ``connector_account_error`` with no
  rows; the others still sync.
- Pagination follows ``cursor.next`` until it is null, for at most
  ``MAX_AKAHU_PAGES`` pages. When a next cursor is still set after the last
  allowed page the result is partial: the window end moves back to the day
  before the newest row seen (that day may be incomplete), newer rows are
  dropped, balances are dropped (they describe today, not the shorter
  window) and ``connector_partial`` is reported. This assumes pages run
  oldest first, which Akahu does not document; if the rows seen are not in
  ascending date order, or no whole day was completed, the call fails with
  ``provider_bad_response`` rather than claim a range it did not read.
- The whole call runs under one overall deadline (``SafeClient``'s
  ``deadline``, ``PROVIDER_CALL_SECONDS`` from the v2 route). Between pages,
  when fewer than ``AKAHU_PAGE_RESERVE_SECONDS`` are left, paging stops
  exactly as at the page cap: the same partial window, dropped balances and
  ``connector_partial``, so the client syncs the rest next time instead of
  losing the pages already read. A page that still runs out of time fails
  the call with ``provider_timeout``.
- Amounts and balances go through ``types.bounded_amount``. A row of a
  requested account whose ``_id``, ``date`` or ``amount`` is unusable is left
  out and the account gets ``rows_skipped`` (pending rows have no id, so a
  stray one lands here too). A row without a usable ``_account`` is ignored. A wrong
  structure (not objects and lists where the API has them, ``success`` not
  true, an account without an id, too many accounts, rows or items) is
  ``provider_bad_response``.
- Account ``type`` maps through ``normalize.guess_kind``. The formatted
  account number is never read.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

from ..liabilities.clock import today
from .base import ProviderClient
from .errors import ConnectorError
from .limits import (
    AKAHU_PAGE_RESERVE_SECONDS,
    DAILY_BUDGET,
    MAX_ACCOUNTS,
    MAX_AKAHU_PAGES,
    MAX_TXNS_PER_ACCOUNT,
    MAX_WINDOW_DAYS,
)
from .normalize import account_key_for, guess_kind
from .types import (
    AccountRequest,
    AccountsResult,
    AkahuCredentials,
    Credentials,
    FetchedAccount,
    FetchResult,
    ProviderAccount,
    ProviderTxn,
    bounded_amount,
)

PROVIDER_ID = "akahu"
API_BASE = "https://api.akahu.io/v1"
ACCOUNT_ERROR = "connector_account_error"
PARTIAL = "connector_partial"
ROWS_SKIPPED = "rows_skipped"

MAX_TOKEN_CHARS = 256
MAX_INSTITUTION_CHARS = 120
MAX_ID_CHARS = 256
MAX_TEXT_CHARS = 1024
MAX_CURSOR_CHARS = 2048
MAX_DATE_CHARS = 64
# Akahu documents at most 100 transactions per page; anything far past that is
# not an Akahu page.
MAX_ITEMS_PER_PAGE = 1000

# Akahu documents no token format, so no prefix is assumed. ASCII letters,
# digits, underscore and hyphen only, so nothing that could break a header
# line (spaces, CR, LF, non-ASCII) reaches the client.
_TOKEN = re.compile(r"[A-Za-z0-9_-]+")


# --- credentials -----------------------------------------------------------------


def _token_ok(value: object) -> bool:
    return (
        isinstance(value, str)
        and len(value) <= MAX_TOKEN_CHARS
        and _TOKEN.fullmatch(value) is not None
    )


def _pair_ok(user: object, app: object) -> bool:
    """Both tokens well formed and different (a token pasted twice is a
    mistake Akahu would only answer with a 401)."""
    return _token_ok(user) and _token_ok(app) and user != app


def parse_credentials(user_token: object, app_token: object) -> AkahuCredentials:
    """Check the two pasted tokens and wrap them, or raise ``bad_request``.

    Surrounding whitespace (from pasting) is removed. Each token must be at
    most ``MAX_TOKEN_CHARS`` long and use only letters, digits, underscore and
    hyphen, and the two must differ. No prefix is required: Akahu's public
    docs do not specify one.
    """
    if not (isinstance(user_token, str) and isinstance(app_token, str)):
        raise ConnectorError("bad_request")
    user = user_token.strip()
    app = app_token.strip()
    if not _pair_ok(user, app):
        raise ConnectorError("bad_request")
    return AkahuCredentials(user_token=user, app_token=app)


def _akahu_creds(creds: Credentials) -> AkahuCredentials:
    """The credentials, re-checked before any request."""
    if not isinstance(creds, AkahuCredentials):
        raise ConnectorError("bad_request")
    if not _pair_ok(creds.user_token, creds.app_token):
        raise ConnectorError("bad_request")
    return creds


def _headers(creds: AkahuCredentials) -> dict[str, str]:
    return {
        "Authorization": "Bearer " + creds.user_token,
        "X-Akahu-Id": creds.app_token,
    }


# --- response parsing ------------------------------------------------------------


def _bad() -> ConnectorError:
    return ConnectorError("provider_bad_response")


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _bad()
    return value


def _items(doc: Any, cap: int) -> list[Any]:
    """``items`` of a ``{success: true, items: [...]}`` response."""
    body = _object(doc)
    if body.get("success") is not True:
        raise _bad()
    items = body.get("items")
    if not isinstance(items, list) or len(items) > cap:
        raise _bad()
    return items


def _id(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_ID_CHARS:
        raise _bad()
    return value


def _lenient_id(value: Any) -> str | None:
    if isinstance(value, str) and value and len(value) <= MAX_ID_CHARS:
        return value
    return None


def _lenient_text(value: Any) -> str | None:
    return value[:MAX_TEXT_CHARS] if isinstance(value, str) else None


def _utc_date(value: Any) -> date | None:
    """The UTC date of an ISO 8601 timestamp (no offset means UTC)."""
    if not isinstance(value, str) or not value or len(value) > MAX_DATE_CHARS:
        return None
    try:
        moment = datetime.fromisoformat(value)
    except ValueError:
        return None
    if moment.tzinfo is None:
        return moment.date()
    try:
        return moment.astimezone(timezone.utc).date()
    except (OverflowError, ValueError):
        return None


def _institution(acct: Mapping[str, Any]) -> str | None:
    conn = acct.get("connection")
    if not isinstance(conn, dict):
        return None
    name = _lenient_text(conn.get("name"))
    return name[:MAX_INSTITUTION_CHARS] if name else None


def _balance(acct: Mapping[str, Any]) -> tuple[Decimal | None, date | None, str]:
    """``balance.current``, the date it was refreshed, and the currency.

    An unusable balance drops its date. A missing or non-string currency is
    returned as ``""`` so the mapping reports ``currency_unsupported``.
    """
    raw = acct.get("balance")
    if not isinstance(raw, dict):
        return None, None, ""
    currency = raw.get("currency")
    currency_text = currency[:MAX_TEXT_CHARS] if isinstance(currency, str) else ""
    current = raw.get("current")
    balance = None if current is None else bounded_amount(current)
    if balance is None:
        return None, None, currency_text
    refreshed = acct.get("refreshed")
    when = _utc_date(refreshed.get("balance")) if isinstance(refreshed, dict) else None
    return balance, when, currency_text


def _accounts(doc: Any) -> dict[str, dict[str, Any]]:
    """``/v1/accounts`` items by id; a repeated id keeps its first entry."""
    out: dict[str, dict[str, Any]] = {}
    for item in _items(doc, MAX_ACCOUNTS):
        acct = _object(item)
        out.setdefault(_id(acct.get("_id")), acct)
    return out


def _active(acct: Mapping[str, Any]) -> bool:
    """Only an explicit ``ACTIVE`` syncs; a missing or unknown status fails
    closed as an account error."""
    return acct.get("status") == "ACTIVE"


def _next_cursor(doc: dict[str, Any]) -> str | None:
    cursor = doc.get("cursor")
    if cursor is None:
        return None
    if not isinstance(cursor, dict):
        raise _bad()
    nxt = cursor.get("next")
    if nxt is None:
        return None
    if not isinstance(nxt, str) or not nxt or len(nxt) > MAX_CURSOR_CHARS:
        raise _bad()
    return nxt


def _iso_end_of_day(day: date) -> str:
    return day.isoformat() + "T23:59:59.999Z"


# --- provider --------------------------------------------------------------------


class AkahuProvider:
    id = PROVIDER_ID
    display_name = "Akahu"
    max_window_days = MAX_WINDOW_DAYS
    daily_request_budget: int | None = DAILY_BUDGET[PROVIDER_ID]

    def claim(self, client: ProviderClient, setup: str) -> Credentials:
        """Akahu has no claim step: the user pastes both tokens."""
        raise ConnectorError("bad_request")

    def list_accounts(
        self, client: ProviderClient, creds: Credentials
    ) -> AccountsResult:
        """One ``GET /v1/accounts``. Accounts that are not ``ACTIVE`` are
        listed with ``error`` set, and the result carries the code too."""
        akc = _akahu_creds(creds)
        by_id = _accounts(
            client.get_json(API_BASE + "/accounts", headers=_headers(akc))
        )
        accounts: list[ProviderAccount] = []
        any_inactive = False
        for account_id, acct in by_id.items():
            active = _active(acct)
            any_inactive = any_inactive or not active
            name = _lenient_text(acct.get("name")) or ""
            balance, balance_date, currency = _balance(acct)
            raw_type = acct.get("type")
            accounts.append(
                ProviderAccount(
                    provider_account_id=account_id,
                    name=name,
                    institution=_institution(acct),
                    currency=currency,
                    balance=balance,
                    balance_date=balance_date,
                    kind_guess=guess_kind(
                        PROVIDER_ID,
                        name,
                        raw_type if isinstance(raw_type, str) else None,
                        balance,
                    ),
                    account_key=account_key_for(PROVIDER_ID, account_id),
                    error=None if active else ACCOUNT_ERROR,
                )
            )
        return AccountsResult(
            accounts=accounts, errors=[ACCOUNT_ERROR] if any_inactive else []
        )

    def fetch(
        self,
        client: ProviderClient,
        creds: Credentials,
        accounts: list[AccountRequest],
        start: date,
        end: date,
    ) -> FetchResult:
        """Rows from ``start`` to ``end`` (UTC days, both included).

        The window is checked before any request: at most 90 days, start not
        after end, end not after tomorrow (a client east of the server may ask
        for its own today).
        """
        akc = _akahu_creds(creds)
        if not accounts or len(accounts) > MAX_ACCOUNTS:
            raise ConnectorError("bad_request")
        latest = today() + timedelta(days=1)
        if start > end or end > latest or (end - start).days + 1 > MAX_WINDOW_DAYS:
            raise ConnectorError("window_too_long")
        headers = _headers(akc)
        wanted = _unique(a.provider_account_id for a in accounts)

        listed = _accounts(client.get_json(API_BASE + "/accounts", headers=headers))
        usable = {
            account_id
            for account_id in wanted
            if account_id in listed and _active(listed[account_id])
        }

        rows: dict[str, list[ProviderTxn]] = {account_id: [] for account_id in usable}
        skipped: set[str] = set()
        pages = 0
        capped = False
        dates_seen: list[date] = []
        if usable:
            pages, capped = self._read_pages(
                client, headers, start, end, usable, rows, skipped, dates_seen
            )

        window_end: date | None = None
        if capped:
            window_end = _complete_end(dates_seen, start)
            for account_id in usable:
                rows[account_id] = [
                    t for t in rows[account_id] if t.posted <= window_end
                ]

        fetched: list[FetchedAccount] = []
        any_problem = False
        for account_id in wanted:
            if account_id not in usable:
                any_problem = True
                acct = listed.get(account_id)
                fetched.append(
                    FetchedAccount(
                        provider_account_id=account_id,
                        currency=_balance(acct)[2] if acct is not None else "",
                        error=ACCOUNT_ERROR,
                    )
                )
                continue
            balance, balance_date, currency = _balance(listed[account_id])
            if capped:
                balance, balance_date = None, None
            fetched.append(
                FetchedAccount(
                    provider_account_id=account_id,
                    currency=currency,
                    transactions=rows[account_id],
                    balance=balance,
                    balance_date=balance_date,
                    # The mapping adds connector_partial from FetchResult.end.
                    warnings=[ROWS_SKIPPED] if account_id in skipped else [],
                    institution=_institution(listed[account_id]),
                )
            )
        errors: list[str] = []
        if any_problem:
            errors.append(ACCOUNT_ERROR)
        if capped:
            errors.append(PARTIAL)
        return FetchResult(
            accounts=fetched, errors=errors, pages=max(pages, 1), end=window_end
        )

    @staticmethod
    def _read_pages(
        client: ProviderClient,
        headers: Mapping[str, str],
        start: date,
        end: date,
        usable: set[str],
        rows: dict[str, list[ProviderTxn]],
        skipped: set[str],
        dates_seen: list[date],
    ) -> tuple[int, bool]:
        """Follow ``cursor.next``; return pages read and whether paging
        stopped early (the page cap, or too little time left for another page).

        ``dates_seen`` collects every usable row date in response order, for
        every account, so the cap logic can check the order.
        """
        base_params = [
            ("start", _iso_end_of_day(start - timedelta(days=1))),
            ("end", _iso_end_of_day(end)),
        ]
        seen_ids: set[str] = set()
        seen_cursors: set[str] = set()
        cursor: str | None = None
        pages = 0
        while True:
            params = list(base_params)
            if cursor is not None:
                params.append(("cursor", cursor))
            doc = client.get_json(
                API_BASE + "/transactions", headers=headers, params=params
            )
            items = _items(doc, MAX_ITEMS_PER_PAGE)
            pages += 1
            for item in items:
                row = _object(item)
                account_id = _lenient_id(row.get("_account"))
                txn_id = _lenient_id(row.get("_id"))
                posted = _utc_date(row.get("date"))
                amount = bounded_amount(row.get("amount"))
                if posted is not None:
                    dates_seen.append(posted)
                if account_id is None or account_id not in usable:
                    continue
                if txn_id is None or posted is None or amount is None:
                    skipped.add(account_id)
                    continue
                if posted < start or posted > end or txn_id in seen_ids:
                    continue
                seen_ids.add(txn_id)
                bucket = rows[account_id]
                if len(bucket) >= MAX_TXNS_PER_ACCOUNT:
                    raise _bad()
                bucket.append(
                    ProviderTxn(
                        id=txn_id,
                        posted=posted,
                        amount=amount,
                        description=_lenient_text(row.get("description")) or "",
                        payee=None,
                    )
                )
            nxt = _next_cursor(doc)
            if nxt is None:
                return pages, False
            if pages >= MAX_AKAHU_PAGES:
                return pages, True
            left = client.seconds_left()
            if left is not None and left < AKAHU_PAGE_RESERVE_SECONDS:
                return pages, True
            if nxt in seen_cursors:
                raise _bad()
            seen_cursors.add(nxt)
            cursor = nxt


def _complete_end(dates_seen: list[date], start: date) -> date:
    """The last whole day read when pagination stopped at the cap.

    Pages are assumed to run oldest first, so every day before the newest one
    seen is complete. Anything else fails closed.
    """
    if not dates_seen:
        raise _bad()
    if any(later < earlier for earlier, later in zip(dates_seen, dates_seen[1:])):
        raise _bad()
    last_complete = dates_seen[-1] - timedelta(days=1)
    if last_complete < start:
        raise _bad()
    return last_complete


def _unique(ids: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(ids))
