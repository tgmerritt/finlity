"""SimpleFIN Bridge provider (design 2.1, 5.1, 8.3).

The user holds the credential: a base64 Setup Token decodes to a claim URL,
one empty POST to it returns the Access URL (``https://user:pass@host/simplefin``),
and data comes from ``GET <access>/accounts``. Every request goes through the
allowlisted client; userinfo travels only as ``auth=``.

Decisions recorded here:

- ``end-date`` is exclusive: midnight UTC after the window's end day, so the
  end day is included. ``start-date`` is midnight UTC of the start day. Sync
  windows overlap by about five days, so either reading of the bridge's
  boundary loses nothing.
- Unix timestamps (``posted``, ``balance-date``) are read as UTC dates.
- Amounts and balances arrive as strings and go through
  ``types.bounded_amount`` (finite, within 1e10). A row whose amount, id or
  ``posted`` is unusable is left out and the account gets the
  ``rows_skipped`` warning; an unusable balance is dropped with its date.
  Rows flagged ``pending`` (or with ``posted`` 0) are skipped silently: only
  posted transactions are imported. A response whose structure is wrong (not
  objects and lists where the protocol has them, an account without an id,
  too many accounts or rows) is ``provider_bad_response``.
- Per-account problems never fail the call. A v2 ``errlist`` entry naming an
  account (``account_id``) or a connection (``conn_id``) marks those accounts
  ``connector_account_error`` with no rows. v1 ``errors`` are free text and
  cannot be attributed, so they only add the code to ``FetchResult.errors``.
  A requested account missing from the response is marked the same way. No
  message text from the provider is kept.
"""

from __future__ import annotations

import base64
import binascii
import re
from collections.abc import Iterable, Mapping
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import Any
from urllib.parse import quote, urlsplit, urlunsplit

from ..liabilities.clock import today
from .base import ProviderClient
from .errors import ConnectorError
from .http import check_simplefin_url
from .limits import (
    DAILY_BUDGET,
    MAX_ACCOUNTS,
    MAX_TXNS_PER_ACCOUNT,
    MAX_WINDOW_DAYS,
)
from .normalize import account_key_for, guess_kind
from .types import (
    AccountRequest,
    AccountsResult,
    Credentials,
    FetchedAccount,
    FetchResult,
    ProviderAccount,
    ProviderTxn,
    SimpleFinCredentials,
    bounded_amount,
)

PROVIDER_ID = "simplefin"
ACCOUNT_ERROR = "connector_account_error"
RATE_LIMITED = "provider_rate_limited"
ROWS_SKIPPED = "rows_skipped"

MAX_SETUP_TOKEN_CHARS = 2048
MAX_ACCESS_URL_CHARS = 2048
MAX_INSTITUTION_CHARS = 120
MAX_ID_CHARS = 256
MAX_TEXT_CHARS = 1024
# Reject timestamps outside years 1970 to 9999 before converting them.
MAX_TIMESTAMP = 253402300799
# Problem and connection lists are small in practice; anything longer is not
# a SimpleFIN response.
MAX_ERRLIST_ENTRIES = 200
MAX_CONNECTIONS_LISTED = 100

_WHITESPACE = str.maketrans("", "", " \t\r\n\f\v")
# Rate-limit wording in a warning's code or text (see _rate_limited).
_RATE_WORDS = re.compile(r"rate[\s_.-]?limit|too many requests", re.IGNORECASE)


# --- credentials -----------------------------------------------------------------


def decode_setup_token(token: str) -> str:
    """Return the claim URL a Setup Token encodes, or raise ``bad_setup_token``.

    Whitespace (from pasting a wrapped token) is removed first. The decoded
    URL must pass the claim allowlist (https, bridge host, ``/simplefin``
    path, no userinfo).
    """
    if not isinstance(token, str):
        raise ConnectorError("bad_setup_token")
    compact = token.translate(_WHITESPACE)
    if not compact or len(compact) > MAX_SETUP_TOKEN_CHARS:
        raise ConnectorError("bad_setup_token")
    url: str | None
    try:
        url = base64.b64decode(compact, validate=True).decode("utf-8")
    except (binascii.Error, ValueError):
        url = None
    # Raised outside the except block so no exception context holds the
    # decoded bytes.
    if url is None:
        raise ConnectorError("bad_setup_token")
    return check_simplefin_url(url, kind="claim").base_url


def parse_access_url(text: str) -> SimpleFinCredentials:
    """Split an Access URL into credentials, or raise ``host_not_allowed``."""
    if not isinstance(text, str):
        raise ConnectorError("host_not_allowed")
    url = text.strip()
    if not url or len(url) > MAX_ACCESS_URL_CHARS:
        raise ConnectorError("host_not_allowed")
    split = check_simplefin_url(url, kind="access")
    if split.auth is None:
        raise ConnectorError("host_not_allowed")
    username, password = split.auth
    return SimpleFinCredentials(
        base_url=split.base_url, username=username, password=password
    )


def format_access_url(creds: SimpleFinCredentials) -> str:
    """The Access URL for credentials, userinfo percent-encoded, so that
    ``parse_access_url(format_access_url(c)) == c``. Only the v2 claim
    response carries it (to the browser that sent the setup token)."""
    parts = urlsplit(creds.base_url)
    userinfo = quote(creds.username, safe="") + ":" + quote(creds.password, safe="")
    return urlunsplit(
        (parts.scheme, f"{userinfo}@{parts.netloc}", parts.path, "", "")
    )


# --- response parsing ----------------------------------------------------------


def _bad() -> ConnectorError:
    return ConnectorError("provider_bad_response")


def _id(value: Any) -> str:
    if not isinstance(value, str) or not value or len(value) > MAX_ID_CHARS:
        raise _bad()
    return value


def _opt_text(value: Any) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str):
        raise _bad()
    return value[:MAX_TEXT_CHARS]


def _lenient_text(value: Any) -> str | None:
    """Free text inside a row: a wrong type is treated as absent."""
    return value[:MAX_TEXT_CHARS] if isinstance(value, str) else None


def _row_id(value: Any) -> str | None:
    if not isinstance(value, str) or not value or len(value) > MAX_ID_CHARS:
        return None
    return value


def _row_date(value: Any) -> date | None:
    """A Unix timestamp as a UTC date, or None when unusable."""
    if isinstance(value, bool) or not isinstance(value, int):
        return None
    if value < 0 or value > MAX_TIMESTAMP:
        return None
    return datetime.fromtimestamp(value, tz=timezone.utc).date()


def _balance(acct: Mapping[str, Any]) -> tuple[Decimal | None, date | None]:
    """The balance and its date; an unusable balance drops both."""
    raw = acct.get("balance")
    balance = None if raw is None else bounded_amount(raw)
    if balance is None:
        return None, None
    return balance, _row_date(acct.get("balance-date"))


def _currency(value: Any) -> str:
    # Validity (3-letter ISO) is the mapping's concern (currency_unsupported).
    if not isinstance(value, str):
        raise _bad()
    return value[:MAX_TEXT_CHARS]


def _lenient_id(value: Any) -> str | None:
    """An optional id (conn_id, account_id); a wrong type is treated as absent."""
    if isinstance(value, str) and value and len(value) <= MAX_ID_CHARS:
        return value
    return None


def _capped_list(value: Any, cap: int) -> list[Any]:
    items = _list(value)
    if len(items) > cap:
        raise _bad()
    return items


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise _bad()
    return value


def _list(value: Any) -> list[Any]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise _bad()
    return value


def _accounts(doc: dict[str, Any]) -> list[dict[str, Any]]:
    if "accounts" not in doc:
        raise _bad()
    raw = _list(doc["accounts"])
    if len(raw) > MAX_ACCOUNTS:
        raise _bad()
    return [_object(a) for a in raw]


def _institutions(doc: dict[str, Any]) -> dict[str, str]:
    """v2 ``connections``: conn_id -> name."""
    names: dict[str, str] = {}
    for item in _capped_list(doc.get("connections"), MAX_CONNECTIONS_LISTED):
        if not isinstance(item, dict):
            continue  # an unusable connection only loses its name
        conn_id = _lenient_id(item.get("conn_id"))
        name = _lenient_text(item.get("name"))
        if conn_id and name:
            names.setdefault(conn_id, name)
    return names


def _institution(acct: Mapping[str, Any], names: Mapping[str, str]) -> str | None:
    conn_id = _lenient_id(acct.get("conn_id"))
    name = names.get(conn_id) if conn_id else None
    if name is None:
        org = acct.get("org")  # v1 shape; anything unusable means no name
        if isinstance(org, dict):
            name = _lenient_text(org.get("name"))
    return name[:MAX_INSTITUTION_CHARS] if name else None


def _problems(doc: dict[str, Any]) -> tuple[set[str], set[str], bool]:
    """Read ``errlist`` (v2) and ``errors`` (v1).

    Returns the account ids and connection ids named by errlist entries, and
    whether any problem was reported at all. Message text is never kept.

    ``gen.auth`` (the bridge no longer accepts the Access URL) fails the call
    with ``reconnect_needed``. An entry whose ``conn_id`` or ``account_id`` is
    unusable counts as a general problem rather than failing the call.

    Rate-limit warnings are read separately by ``_rate_limited``.
    """
    account_ids: set[str] = set()
    conn_ids: set[str] = set()
    errlist = _capped_list(doc.get("errlist"), MAX_ERRLIST_ENTRIES)
    for item in errlist:
        entry = _object(item)
        code = entry.get("code")
        if not isinstance(code, str):
            raise _bad()
        if code == "gen.auth":
            raise ConnectorError("reconnect_needed")
        account_id = _lenient_id(entry.get("account_id"))
        conn_id = _lenient_id(entry.get("conn_id"))
        if account_id:
            account_ids.add(account_id)
        elif conn_id:
            conn_ids.add(conn_id)
    errors = _capped_list(doc.get("errors"), MAX_ERRLIST_ENTRIES)
    return account_ids, conn_ids, bool(errlist or errors)


def _rate_limited(doc: dict[str, Any]) -> bool:
    """Whether a warning says the bridge is rate limiting this token.

    The protocol documents no rate-limit errlist code; the bridge's developer
    page says rate warnings arrive as free text (v1 ``errors``). So the
    errlist ``code`` and ``msg`` and each v1 string are matched against
    rate-limit wording, reading at most ``MAX_TEXT_CHARS`` of each. The text
    is never kept. A match adds ``provider_rate_limited`` to the result's
    codes while the data that did arrive is still returned, so the client can
    stop syncing until the next day (design 8.3) without losing rows.
    """
    texts: list[Any] = []
    for item in _capped_list(doc.get("errlist"), MAX_ERRLIST_ENTRIES):
        if isinstance(item, dict):
            texts.extend((item.get("code"), item.get("msg")))
    texts.extend(_capped_list(doc.get("errors"), MAX_ERRLIST_ENTRIES))
    return any(
        isinstance(text, str) and _RATE_WORDS.search(text[:MAX_TEXT_CHARS]) is not None
        for text in texts
    )


def _result_errors(doc: dict[str, Any], any_problem: bool) -> list[str]:
    codes = [ACCOUNT_ERROR] if any_problem else []
    if _rate_limited(doc):
        codes.append(RATE_LIMITED)
    return codes


def _txns(raw: Any) -> tuple[list[ProviderTxn], bool]:
    """Posted rows, and whether any row was left out as unusable."""
    rows = _list(raw)
    if len(rows) > MAX_TXNS_PER_ACCOUNT:
        raise _bad()
    out: list[ProviderTxn] = []
    skipped = False
    for item in rows:
        row = _object(item)
        # Only an explicit JSON true marks a row pending (protocol: optional
        # boolean); "true", 1 and other values are not trusted as a flag.
        # ``posted`` 0 is the protocol's other marker for a pending row.
        posted_raw = row.get("posted")
        if row.get("pending") is True or (type(posted_raw) is int and posted_raw == 0):
            continue
        txn_id = _row_id(row.get("id"))
        posted = _row_date(row.get("posted"))
        amount = bounded_amount(row.get("amount"))
        if txn_id is None or posted is None or amount is None:
            skipped = True
            continue
        out.append(
            ProviderTxn(
                id=txn_id,
                posted=posted,
                amount=amount,
                description=_lenient_text(row.get("description")) or "",
                payee=_lenient_text(row.get("payee")),
            )
        )
    return out, skipped


def _end_exclusive(end: date) -> int:
    return _unix(end + timedelta(days=1))


def _unix(day: date) -> int:
    return int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp())


# --- provider --------------------------------------------------------------------


def _simplefin_creds(creds: Credentials) -> SimpleFinCredentials:
    if not isinstance(creds, SimpleFinCredentials):
        raise ConnectorError("bad_request")
    return creds


class SimpleFinProvider:
    id = PROVIDER_ID
    display_name = "SimpleFIN"
    max_window_days = MAX_WINDOW_DAYS
    daily_request_budget: int | None = DAILY_BUDGET[PROVIDER_ID]

    def claim(self, client: ProviderClient, setup: str) -> Credentials:
        """Exchange a Setup Token for credentials (one empty POST).

        A 403 is ``claim_refused`` (from the client). A body that is not an
        allowlisted Access URL is ``provider_bad_response``.
        """
        claim_url = decode_setup_token(setup)
        body = client.post_text(claim_url)
        try:
            return parse_access_url(body)
        except ConnectorError:
            raise ConnectorError("provider_bad_response") from None

    def list_accounts(
        self, client: ProviderClient, creds: Credentials
    ) -> AccountsResult:
        """One balances-only request; no transactions are read. An account
        an errlist entry names (directly or through its connection) is
        listed with ``error`` set."""
        sfc = _simplefin_creds(creds)
        doc = _object(
            client.get_json(
                sfc.base_url + "/accounts",
                auth=(sfc.username, sfc.password),
                params=[("balances-only", "1"), ("version", "2")],
            )
        )
        names = _institutions(doc)
        bad_accounts, bad_conns, any_problem = _problems(doc)
        accounts: list[ProviderAccount] = []
        # A repeated account id keeps its first entry, as fetch does.
        for account_id, acct in _index(_accounts(doc)).items():
            name = _opt_text(acct.get("name")) or ""
            balance, balance_date = _balance(acct)
            conn_id = _lenient_id(acct.get("conn_id"))
            flagged = account_id in bad_accounts or (
                conn_id is not None and conn_id in bad_conns
            )
            accounts.append(
                ProviderAccount(
                    provider_account_id=account_id,
                    name=name,
                    institution=_institution(acct, names),
                    currency=_currency(acct.get("currency")),
                    balance=balance,
                    balance_date=balance_date,
                    kind_guess=guess_kind(PROVIDER_ID, name, None, balance),
                    account_key=account_key_for(PROVIDER_ID, account_id),
                    error=ACCOUNT_ERROR if flagged else None,
                )
            )
        return AccountsResult(
            accounts=accounts, errors=_result_errors(doc, any_problem)
        )

    def fetch(
        self,
        client: ProviderClient,
        creds: Credentials,
        accounts: list[AccountRequest],
        start: date,
        end: date,
    ) -> FetchResult:
        """One request for the window ``start`` to ``end`` (both included).

        The window is checked before any request: at most 90 days, start not
        after end, end not after tomorrow. A day of slack lets a client east
        of the server's timezone ask for its own today; the bridge simply has
        nothing newer. Pending rows are never requested.
        """
        sfc = _simplefin_creds(creds)
        if not accounts or len(accounts) > MAX_ACCOUNTS:
            raise ConnectorError("bad_request")
        latest = today() + timedelta(days=1)
        if start > end or end > latest or (end - start).days + 1 > MAX_WINDOW_DAYS:
            raise ConnectorError("window_too_long")
        wanted = [a.provider_account_id for a in accounts]
        params: list[tuple[str, str]] = [
            ("start-date", str(_unix(start))),
            ("end-date", str(_end_exclusive(end))),
            ("version", "2"),
        ]
        params.extend(("account", account_id) for account_id in wanted)
        doc = _object(
            client.get_json(
                sfc.base_url + "/accounts",
                auth=(sfc.username, sfc.password),
                params=params,
            )
        )
        bad_accounts, bad_conns, any_problem = _problems(doc)
        names = _institutions(doc)
        by_id = _index(_accounts(doc))
        fetched: list[FetchedAccount] = []
        for account_id in _unique(wanted):
            acct = by_id.get(account_id)
            conn_id = _lenient_id(acct.get("conn_id")) if acct else None
            if (
                acct is None
                or account_id in bad_accounts
                or (conn_id is not None and conn_id in bad_conns)
            ):
                any_problem = True
                fetched.append(
                    FetchedAccount(
                        provider_account_id=account_id,
                        # Not validated: an errored account carries no data.
                        currency=_lenient_text(acct.get("currency")) or ""
                        if acct
                        else "",
                        error=ACCOUNT_ERROR,
                    )
                )
                continue
            rows, skipped = _txns(acct.get("transactions"))
            balance, balance_date = _balance(acct)
            fetched.append(
                FetchedAccount(
                    provider_account_id=account_id,
                    currency=_currency(acct.get("currency")),
                    transactions=rows,
                    balance=balance,
                    balance_date=balance_date,
                    warnings=[ROWS_SKIPPED] if skipped else [],
                    institution=_institution(acct, names),
                )
            )
        return FetchResult(
            accounts=fetched,
            errors=_result_errors(doc, any_problem),
            pages=1,
        )


def _index(accounts: Iterable[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for acct in accounts:
        out.setdefault(_id(acct.get("id")), acct)
    return out


def _unique(ids: Iterable[str]) -> list[str]:
    return list(dict.fromkeys(ids))
