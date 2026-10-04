"""Server-mode connection service (design 6.2, 8.3, 8.4, 9.1; plan B2).

Not part of the stateless core: this is the server data layer behind
``src/api/connections.py``. It reaches the database only through ``store``
and calls providers through the same core the v2 routes use (``SafeClient``,
the provider classes, ``normalize.to_statements``).

Rules this module keeps:

* Credentials go in and never come out. List and detail carry metadata only;
  the decrypted credential lives for one provider call.
* A one-time SimpleFIN setup token is claimed only after every check that
  could fail without a provider call (connection count, encryption key), and
  the credential is committed (status ``accounts_pending``) before any other
  provider call, so nothing can lose a claimed credential (design 8.3).
* The per-connection quota (``limits.DAILY_BUDGET`` per rolling 24 hours) is
  checked before every account listing and sync; every provider call that was
  made records a timestamp in ``requests``, whatever its outcome.
* Provider answers that describe the connection set its status:
  ``reconnect_needed``, ``payment_required`` and ``provider_rate_limited``
  (status ``rate_limited``). An unreadable secret, or one whose provider does
  not match the metadata row, is ``reconnect_needed``. Other failures leave
  the status as it was. ``last_synced_at`` is set only by a successful sync.
* Sync builds its plan from applied imports (design 9.1), so Undo rewinds
  it, and returns statements for the wizard. Nothing here applies them.
* One deadline per request (``PROVIDER_CALL_SECONDS``), shared by every
  provider call the request makes, keeps it under Heroku's 30 s.

Logging: event names, connection ids, provider ids, counts, ``error_type``
and durations. Never a credential, label, account name, institution,
description or amount.
"""

from __future__ import annotations

import logging
import re
import threading
import time
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional, TypeVar

from ..liabilities import clock
from ..smart_import.errors import SmartImportError
from ..smart_import import service as import_service
from ..smart_import.types import ACCOUNT_KINDS, NormalizedStatement
from . import akahu, registry, store
from .base import ConnectorProvider
from .errors import ConnectorError
from .http import SafeClient
from .limits import (
    DAILY_BUDGET,
    MAX_ACCOUNTS,
    MAX_CONNECTIONS,
    MAX_WINDOWS_PER_SYNC,
    PROVIDER_CALL_SECONDS,
)
from .normalize import account_key_for, dropped_accounts, to_statements
from .simplefin import parse_access_url
from .types import (
    AccountRequest,
    AccountsResult,
    AkahuCredentials,
    Credentials,
    DemoCredentials,
    FetchResult,
    SimpleFinCredentials,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")

# A transport per provider id; None lets SafeClient build its pinned one.
TransportFactory = Callable[[str], Any]

# A provider call is not started with less than this left of the request's
# deadline (see _require_time).
MIN_CALL_SECONDS = 10.0
# Design 9.1: later syncs start this many days before the newest synced end.
OVERLAP_DAYS = 5
DEBT_KINDS = ("credit_card", "loan")
LABEL_CHARS = 120
PROVIDER_TEXT_CHARS = 200
FALLBACK_LABEL = "Account"
# ISO 4217 "no currency": stored when a provider sends something else, so the
# account keeps its mapping; the sync then skips it with currency_unsupported.
NO_CURRENCY = "XXX"

# Provider error -> connection status (design 8.3). Anything else leaves the
# status unchanged.
ERROR_STATUS = {
    "reconnect_needed": "reconnect_needed",
    "payment_required": "payment_required",
    "provider_rate_limited": "rate_limited",
}

_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
_CURRENCY = re.compile(r"[A-Z]{3}")
_CONNECTOR_KEY = re.compile(r"acct:[0-9a-f]{64}")
_CREDENTIAL_TYPES: dict[str, type[Credentials]] = {
    "simplefin": SimpleFinCredentials,
    "akahu": AkahuCredentials,
    "demo": DemoCredentials,
}

# Serializes read-modify-write of the ``connections`` row inside this process
# (a single-user server). Re-entrant: create holds it across the claim.
_LOCK = threading.RLock()


def utcnow() -> datetime:
    """The service clock; tests replace it (with ``clock.today``)."""
    return datetime.now(timezone.utc)


# --- plan -------------------------------------------------------------------------


@dataclass(frozen=True)
class PlannedAccount:
    provider_account_id: str
    since: date
    account_key: str  # the key statements carry: same_as_key, else account_key
    kind: str
    flip_balance: bool


@dataclass(frozen=True)
class SyncPlan:
    accounts: list[PlannedAccount]
    windows: list[tuple[date, date]]
    quota_left: Optional[int]


def effective_key(account: dict[str, Any]) -> str:
    """The key a synced statement carries (design 5.2, 10)."""
    same_as = account.get("same_as_key")
    return same_as if isinstance(same_as, str) and same_as else account["account_key"]


def next_since(
    connection: dict[str, Any],
    account: dict[str, Any],
    *,
    import_ends: dict[str, date],
    posted: dict[str, date],
    today: date,
) -> date:
    """Design 9.1, in order:

    1. the newest ``period_end`` of this connection's imports for the
       account's key, minus 5 days (dedupe absorbs the overlap);
    2. for a "same as" mapping, the day after the newest stored
       ``posted_date`` for that key;
    3. the first-sync choice: ``first_sync_days`` days ending today (both
       ends included, so 90 days is exactly one window).

    Never after today.
    """
    key = effective_key(account)
    if key in import_ends:
        since = import_ends[key] - timedelta(days=OVERLAP_DAYS)
    elif account.get("same_as_key") and key in posted:
        since = posted[key] + timedelta(days=1)
    else:
        since = today - timedelta(days=connection["first_sync_days"] - 1)
    return min(since, today)


def windows_for(start: date, today: date, max_days: int) -> list[tuple[date, date]]:
    """Windows of at most ``max_days`` days (both ends included) from
    ``start`` to ``today``, oldest first, at most ``MAX_WINDOWS_PER_SYNC``.
    Older gaps are left for the next Sync now, which starts after them."""
    out: list[tuple[date, date]] = []
    begin = start
    while begin <= today and len(out) < MAX_WINDOWS_PER_SYNC:
        end = min(begin + timedelta(days=max_days - 1), today)
        out.append((begin, end))
        begin = end + timedelta(days=1)
    return out


def quota_left(connection: dict[str, Any]) -> Optional[int]:
    """Provider calls left in the rolling 24 hours; None when unlimited."""
    budget = DAILY_BUDGET.get(connection["provider"])
    if budget is None:
        return None
    return max(0, budget - len(connection["requests"]))


def _quota_resets_at(connection: dict[str, Any]) -> Optional[str]:
    """When the oldest counted call leaves the window (only when none are left)."""
    if quota_left(connection) != 0 or not connection["requests"]:
        return None
    oldest = datetime.fromisoformat(connection["requests"][0].replace("Z", "+00:00"))
    return store.now_iso(lambda: oldest + store.REQUEST_WINDOW)


def _plan(db: Any, connection_id: str, connection: dict[str, Any]) -> tuple[SyncPlan, dict[str, Optional[date]]]:
    """The plan plus ``next_since`` per provider account id (None for ignored)."""
    today = clock.today()
    enabled = {
        pid: acct for pid, acct in sorted(connection["accounts"].items()) if acct["role"] != "ignore"
    }
    keys = {effective_key(a) for a in enabled.values()}
    same_as = {a["same_as_key"] for a in enabled.values() if a.get("same_as_key")}
    import_ends = store.newest_import_ends(db, connection_id, keys)
    posted = store.newest_posted_dates(db, same_as - set(import_ends))
    since_by_id: dict[str, Optional[date]] = {pid: None for pid in connection["accounts"]}
    planned: list[PlannedAccount] = []
    for pid, acct in enabled.items():
        since = next_since(connection, acct, import_ends=import_ends, posted=posted, today=today)
        since_by_id[pid] = since
        planned.append(
            PlannedAccount(
                provider_account_id=pid,
                since=since,
                account_key=effective_key(acct),
                kind=acct["kind"],
                flip_balance=acct["flip_balance"],
            )
        )
    windows: list[tuple[date, date]] = []
    if planned:
        max_days = registry.get_provider(connection["provider"]).max_window_days
        windows = windows_for(min(p.since for p in planned), today, max_days)
    return SyncPlan(accounts=planned, windows=windows, quota_left=quota_left(connection)), since_by_id


def window_requests(plan: SyncPlan, window: tuple[date, date]) -> list[AccountRequest]:
    """The accounts one window fetches: those whose ``since`` is not after the
    window's end, each starting at the later of its ``since`` and the window
    start."""
    start, end = window
    return [
        AccountRequest(
            provider_account_id=p.provider_account_id,
            since=max(p.since, start),
            account_key=p.account_key,
            kind=p.kind,
            flip_balance=p.flip_balance,
        )
        for p in plan.accounts
        if p.since <= end
    ]


# --- shapes -----------------------------------------------------------------------


def _summary(connection_id: str, conn: dict[str, Any]) -> dict[str, Any]:
    budget = DAILY_BUDGET.get(conn["provider"])
    accounts = conn["accounts"].values()
    return {
        "id": connection_id,
        "provider": conn["provider"],
        "label": conn["label"],
        "status": conn["status"],
        "status_at": conn["status_at"],
        "created_at": conn["created_at"],
        "last_synced_at": conn["last_synced_at"],
        "first_sync_days": conn["first_sync_days"],
        "accounts_count": len(conn["accounts"]),
        "accounts_enabled": sum(1 for a in accounts if a["role"] != "ignore"),
        "quota_budget": budget,
        "quota_left": quota_left(conn),
        "quota_resets_at": _quota_resets_at(conn),
    }


def _detail(db: Any, connection_id: str, conn: dict[str, Any]) -> dict[str, Any]:
    plan, since_by_id = _plan(db, connection_id, conn)
    accounts = []
    # Sorted by provider account id, so the order never depends on storage.
    for pid, acct in sorted(conn["accounts"].items()):
        since = since_by_id.get(pid)
        accounts.append(
            {
                "provider_account_id": pid,
                "name": acct["name"],
                "institution": acct["institution"],
                "currency": acct["currency"],
                "kind": acct["kind"],
                "role": acct["role"],
                "label": acct["label"],
                "account_key": acct["account_key"],
                "liability_id": acct["liability_id"],
                "flip_balance": acct["flip_balance"],
                "same_as_key": acct["same_as_key"],
                "next_since": since.isoformat() if since else None,
            }
        )
    return {
        **_summary(connection_id, conn),
        "windows": [{"start": s.isoformat(), "end": e.isoformat()} for s, e in plan.windows],
        "accounts": accounts,
    }


# --- storage helpers --------------------------------------------------------------


def _connection(doc: dict[str, Any], connection_id: str) -> dict[str, Any]:
    conn: Optional[dict[str, Any]] = (
        doc["items"].get(connection_id) if isinstance(connection_id, str) else None
    )
    if conn is None:
        raise ConnectorError("connection_not_found")
    return conn


@contextmanager
def _mutate(db: Any, now: datetime) -> Iterator[tuple[dict[str, Any], Any]]:
    """Read the ``connections`` document, let the caller change it, write it
    back, all in one session committed on success, under ``_LOCK``. An error
    writes nothing.

    Before the commit, the document the store actually wrote (after
    ``sanitize``) must still hold every connection and account the caller
    left in it; otherwise ``save_failed`` rolls the whole change back, so a
    partial save is never reported as done.
    """
    with _LOCK, store.transaction(db) as session:
        doc = store.read_connections(db, session=session, now=now)
        yield doc, session
        clean = store.write_connections(db, doc, session=session, now=now)
        if _shape(clean) != _shape(doc):
            logger.error("connection_save_dropped_entries")
            raise SmartImportError("save_failed")


def _shape(doc: dict[str, Any]) -> dict[str, set[str]]:
    """Connection ids and their account ids."""
    return {cid: set(conn["accounts"]) for cid, conn in doc["items"].items()}


def _set_status(conn: dict[str, Any], status: str, now: datetime) -> bool:
    """Set the status; True when it changed."""
    if conn["status"] == status:
        return False
    conn["status"] = status
    conn["status_at"] = store.now_iso(lambda: now)
    return True


def _record_failure(db: Any, connection_id: str, error_type: str) -> None:
    """Store the status a provider error implies (design 8.3), if any."""
    status = ERROR_STATUS.get(error_type)
    if status is None:
        return
    now = utcnow()
    changed = False
    with _mutate(db, now) as (doc, _):
        conn = doc["items"].get(connection_id)
        if conn is not None:
            changed = _set_status(conn, status, now)
    if changed:
        logger.info(
            "connection_status_changed connection_id=%s status=%s", connection_id, status
        )


def _success_status(codes: list[str]) -> str:
    """``ok``, or ``rate_limited`` when the provider answered but warned that
    it is rate limiting this credential (design 8.3: a rate-limit errlist
    entry). The data that arrived is still returned."""
    return "rate_limited" if "provider_rate_limited" in codes else "ok"


def _check_quota(conn: dict[str, Any]) -> None:
    if quota_left(conn) == 0:
        raise ConnectorError("quota_reached")


def _load_credentials(
    db: Any, connection_id: str, conn: dict[str, Any], session: Any
) -> Optional[Credentials]:
    """The decrypted credentials, or None when unreadable (missing row, key
    changed, a browser value, or a credential for another provider)."""
    if conn["provider"] == "demo":
        return DemoCredentials()
    creds: Optional[Credentials] = None
    try:
        creds = store.load_secret(db, connection_id, session=session)
    except store.SecretUnreadable:
        creds = None
    if creds is not None and type(creds) is not _CREDENTIAL_TYPES[conn["provider"]]:
        logger.warning("connection_secret_provider_mismatch connection_id=%s", connection_id)
        creds = None
    return creds


def _begin_call(db: Any, connection_id: str, deadline: float) -> tuple[str, Credentials]:
    """Checks before a provider call on a stored connection, then count it.

    Refuses when too little of the request's deadline is left once the lock
    is held (``request_time_short``, nothing counted), then
    ``reconnect_needed`` connections (Reconnect replaces the secret first),
    then the quota, then reads the secret. An unreadable secret sets
    ``reconnect_needed``. Returns the provider id and the credentials.
    """
    now = utcnow()
    unreadable = False
    with _mutate(db, now) as (doc, session):
        _require_time(deadline)
        conn = _connection(doc, connection_id)
        if conn["status"] == "reconnect_needed":
            raise ConnectorError("reconnect_needed")
        _require_enabled(conn["provider"])
        _check_quota(conn)
        creds = _load_credentials(db, connection_id, conn, session)
        if creds is None:
            unreadable = True
            _set_status(conn, "reconnect_needed", now)
        else:
            conn["requests"].append(store.now_iso(lambda: now))
        provider_id = conn["provider"]
    if unreadable or creds is None:
        raise ConnectorError("reconnect_needed")
    return provider_id, creds


def _begin_replacement_call(db: Any, connection_id: str, deadline: float) -> str:
    """Checks before Reconnect tries a pasted credential, then count it.

    Like ``_begin_call``, but neither ``reconnect_needed`` nor the stored
    secret matters: the call uses the credential being offered. Refuses on
    ``request_time_short`` (nothing counted), a disabled provider and the
    quota. Returns the provider id.
    """
    now = utcnow()
    with _mutate(db, now) as (doc, _):
        _require_time(deadline)
        conn = _connection(doc, connection_id)
        _require_enabled(conn["provider"])
        _check_quota(conn)
        conn["requests"].append(store.now_iso(lambda: now))
        provider_id: str = conn["provider"]
    return provider_id


# --- provider calls ---------------------------------------------------------------


def _require_enabled(provider_id: str) -> ConnectorProvider:
    if not registry.is_enabled(provider_id):
        raise ConnectorError("connector_disabled")
    return registry.get_provider(provider_id)


def _require_time(deadline: float) -> None:
    """Refuse before any provider call when less than ``MIN_CALL_SECONDS``
    of the request's deadline is left (a request that waited on ``_LOCK``),
    so no setup token is spent and no quota is used on a call that could
    not finish."""
    if deadline - time.monotonic() < MIN_CALL_SECONDS:
        logger.warning("connection_request_time_short")
        raise ConnectorError("request_time_short")


def _deadline() -> float:
    return time.monotonic() + PROVIDER_CALL_SECONDS


def _ms(started: float) -> int:
    return int((time.monotonic() - started) * 1000)


def _provider_call(
    event: str,
    connection_id: str,
    provider: ConnectorProvider,
    factory: TransportFactory,
    deadline: float,
    call: Callable[[ConnectorProvider, SafeClient], T],
) -> T:
    """One provider call through a fresh SafeClient bounded by ``deadline``.

    Catalog errors pass through. Anything else is logged by type name only
    (an httpx exception carries the request) and becomes
    ``provider_bad_response``, raised outside the ``except`` block so no
    exception context links back to it. Same contract as the v2 routes.
    """
    started = time.monotonic()
    failure: Optional[str] = None
    try:
        with SafeClient(provider.id, transport=factory(provider.id), deadline=deadline) as client:
            return call(provider, client)
    except SmartImportError as exc:
        logger.info(
            "connection_%s_failed connection_id=%s provider=%s error_type=%s duration_ms=%d",
            event,
            connection_id,
            provider.id,
            exc.error_type,
            _ms(started),
        )
        raise
    except Exception as exc:  # noqa: BLE001 - see docstring
        failure = type(exc).__name__
    logger.warning(
        "connection_%s_failed connection_id=%s provider=%s "
        "error_type=provider_bad_response exception=%s duration_ms=%d",
        event,
        connection_id,
        provider.id,
        failure,
        _ms(started),
    )
    raise ConnectorError("provider_bad_response")


def _account_errors(result: FetchResult, requests: list[AccountRequest]) -> list[dict[str, Any]]:
    """Dropped accounts with their code, then each result-level code not
    already listed (``provider_account_id: null``), as the v2 sync returns."""
    out: list[dict[str, Any]] = list(dropped_accounts(result, requests))
    listed = {entry["code"] for entry in out}
    for code in dict.fromkeys(result.errors):
        if code not in listed:
            out.append({"provider_account_id": None, "code": code})
            listed.add(code)
    return out


# --- credentials input ------------------------------------------------------------


def _parse_input(provider_id: str, given: dict[str, Any]) -> tuple[Optional[str], Optional[Credentials]]:
    """``(setup_token, None)`` when a claim is needed, else ``(None, creds)``.

    SimpleFIN takes exactly one of ``setup_token`` or ``access_url``; Akahu
    takes ``user_token`` and ``app_token``; the demo takes nothing.
    """
    fields = {k for k in ("setup_token", "access_url", "user_token", "app_token") if given.get(k) is not None}
    if provider_id == "simplefin" and fields == {"setup_token"}:
        return given["setup_token"], None
    if provider_id == "simplefin" and fields == {"access_url"}:
        return None, parse_access_url(given["access_url"])
    if provider_id == "akahu" and fields == {"user_token", "app_token"}:
        return None, akahu.parse_credentials(given["user_token"], given["app_token"])
    if provider_id == "demo" and not fields:
        return None, DemoCredentials()
    raise ConnectorError("bad_request")


def _claim(
    connection_id: str,
    provider: ConnectorProvider,
    setup_token: str,
    factory: TransportFactory,
    deadline: float,
) -> Credentials:
    timed_out = False
    try:
        creds = _provider_call(
            "claim", connection_id, provider, factory, deadline,
            lambda p, c: p.claim(c, setup_token),
        )
    except SmartImportError as exc:
        if exc.error_type != "provider_timeout":
            raise
        timed_out = True
    if timed_out:
        # The bridge may have claimed the token before the answer was lost.
        raise ConnectorError("claim_timeout")
    if not isinstance(creds, SimpleFinCredentials):
        raise ConnectorError("provider_bad_response")
    return creds


# --- accounts ---------------------------------------------------------------------


def _clip(value: Any, max_chars: int) -> Optional[str]:
    """Provider text without control characters, trimmed and cut; None if empty."""
    if not isinstance(value, str):
        return None
    text = _CONTROL.sub(" ", value).strip()[:max_chars].strip()
    return text or None


def _merge_accounts(
    db: Any, provider_id: str, conn: dict[str, Any], result: AccountsResult
) -> None:
    """Merge a provider listing into the stored mapping.

    Known accounts keep their mapping and get fresh provider text. New
    accounts on the first listing get defaults by kind (``cash_flow`` for
    checking, savings and unknown; ``debt`` for card and loan, with a
    suggested debt); new accounts on a later listing are added as ``ignore``
    until mapped. Accounts the provider no longer lists are kept.
    """
    stored: dict[str, dict[str, Any]] = conn["accounts"]
    first = not stored
    for acct in result.accounts:
        pid = acct.provider_account_id
        if not isinstance(pid, str) or not pid or len(pid) > store.MAX_PROVIDER_ACCOUNT_ID_CHARS or _CONTROL.search(pid):
            continue
        name = _clip(acct.name, PROVIDER_TEXT_CHARS) or ""
        institution = _clip(acct.institution, PROVIDER_TEXT_CHARS)
        currency = acct.currency.upper() if isinstance(acct.currency, str) else ""
        if not _CURRENCY.fullmatch(currency):
            currency = NO_CURRENCY
        if pid in stored:
            stored[pid].update(name=name, institution=institution, currency=currency)
            continue
        if len(stored) >= MAX_ACCOUNTS:
            continue
        kind = acct.kind_guess if acct.kind_guess in ACCOUNT_KINDS else "unknown"
        account_key = acct.account_key
        if not isinstance(account_key, str) or not _CONNECTOR_KEY.fullmatch(account_key):
            account_key = account_key_for(provider_id, pid)
        role = ("debt" if kind in DEBT_KINDS else "cash_flow") if first else "ignore"
        liability_id = None
        if role == "debt":
            liability_id = store.suggest_liability(db, institution, kind, account_key)
        stored[pid] = {
            "name": name,
            "institution": institution,
            "currency": currency,
            "kind": kind,
            "role": role,
            "label": _clip(name, LABEL_CHARS) or FALLBACK_LABEL,
            "account_key": account_key,
            "liability_id": liability_id,
            "flip_balance": False,
            "same_as_key": None,
        }


def _listing_errors(result: AccountsResult) -> list[dict[str, Any]]:
    """Per-account codes the provider flagged (an errlist entry, an Akahu
    account that is not active), then each result-level code with
    ``provider_account_id: null``: the shape the sync's ``account_errors``
    uses. Transient: returned with the listing, never stored."""
    out: list[dict[str, Any]] = [
        {"provider_account_id": a.provider_account_id, "code": a.error}
        for a in result.accounts
        if a.error
    ]
    listed = {entry["code"] for entry in out}
    for code in dict.fromkeys(result.errors):
        if code not in listed:
            out.append({"provider_account_id": None, "code": code})
            listed.add(code)
    return out


def _list_accounts(
    db: Any, connection_id: str, factory: TransportFactory, deadline: float
) -> list[dict[str, Any]]:
    """Count, call the provider's account listing and merge it (status ok).
    Returns the listing's ``account_errors``."""
    provider_id, creds = _begin_call(db, connection_id, deadline)
    provider = registry.get_provider(provider_id)
    started = time.monotonic()
    try:
        result: AccountsResult = _provider_call(
            "accounts", connection_id, provider, factory, deadline,
            lambda p, c: p.list_accounts(c, creds),
        )
    except SmartImportError as exc:
        _record_failure(db, connection_id, exc.error_type)
        raise
    now = utcnow()
    with _mutate(db, now) as (doc, _):
        conn = _connection(doc, connection_id)
        _merge_accounts(db, provider_id, conn, result)
        _set_status(conn, _success_status(result.errors), now)
    logger.info(
        "connection_accounts connection_id=%s provider=%s accounts=%d errors=%d duration_ms=%d",
        connection_id,
        provider_id,
        len(result.accounts),
        len(result.errors),
        _ms(started),
    )
    return _listing_errors(result)


def _try_accounts(
    db: Any, connection_id: str, factory: TransportFactory, deadline: float
) -> dict[str, Any]:
    """``_list_accounts`` after a credential was stored: a failure keeps the
    connection and its credential and is returned as ``accounts_error``."""
    try:
        errors = _list_accounts(db, connection_id, factory, deadline)
    except SmartImportError as exc:
        return {"accounts_error": exc.error_type, "account_errors": []}
    return {"accounts_error": None, "account_errors": errors}


# --- public API -------------------------------------------------------------------


def list_connections(db: Any) -> list[dict[str, Any]]:
    """Every connection as a summary, oldest first (``created_at``, then id).
    Never a secret."""
    doc = store.read_connections(db, now=utcnow())
    items = sorted(doc["items"].items(), key=lambda pair: (pair[1]["created_at"], pair[0]))
    return [_summary(cid, conn) for cid, conn in items]


def get_connection(db: Any, connection_id: str) -> dict[str, Any]:
    """Summary plus accounts with mapping and ``next_since``, and the sync
    windows. Never a secret."""
    doc = store.read_connections(db, now=utcnow())
    return _detail(db, connection_id, _connection(doc, connection_id))


def plan_sync(db: Any, connection_id: str) -> SyncPlan:
    doc = store.read_connections(db, now=utcnow())
    conn = _connection(doc, connection_id)
    return _plan(db, connection_id, conn)[0]


def _save_after_claim(claimed: bool, save: Callable[[], None]) -> None:
    """Run ``save``. When a setup token was just claimed, any failure is
    ``claim_not_saved``: the token is spent and the credential is lost, so
    the person must create a new token. Logged by event name only."""
    if not claimed:
        save()
        return
    failed = False
    try:
        save()
    except Exception:  # noqa: BLE001 - any failure loses the claimed credential
        failed = True
    if failed:
        logger.error("connection_claim_not_saved")
        raise ConnectorError("claim_not_saved")


def create_connection(
    db: Any, request: dict[str, Any], transport_factory: TransportFactory
) -> dict[str, Any]:
    """Mint the id, claim if needed, commit the encrypted credential with
    status ``accounts_pending``, then list accounts (design 6.2, 8.3).

    Everything that can fail without a provider call is checked before a
    setup token is claimed (shape, ``connection_limit``, the encryption key,
    and enough time left once ``_LOCK`` is held). A claim that times out is
    ``claim_timeout`` (the token may be spent). A save that fails after a
    good claim is ``claim_not_saved``: the token is spent, so the person
    must create a new one. Once committed, the credential is never lost to
    a later failure.

    Returns the detail plus ``account_errors`` (the listing's flagged
    accounts, in the sync's shape) and ``accounts_error``: null, or the
    error type of a failed account listing (the connection and credential
    are kept; ``POST /api/connections/{id}/accounts`` finishes it).
    """
    provider_id = request["provider"]
    provider = _require_enabled(provider_id)
    setup_token, creds = _parse_input(provider_id, request)
    deadline = _deadline()
    connection_id = str(uuid.uuid4())
    claimed = setup_token is not None
    with _LOCK:
        if len(store.read_connections(db, now=utcnow())["items"]) >= MAX_CONNECTIONS:
            raise ConnectorError("connection_limit")
        if provider_id != "demo":
            store.check_key(db)
        if setup_token is not None:
            _require_time(deadline)
            creds = _claim(connection_id, provider, setup_token, transport_factory, deadline)
        if creds is None:
            raise ConnectorError("bad_request")
        new_creds: Credentials = creds

        def save() -> None:
            now = utcnow()
            stamp = store.now_iso(lambda: now)
            with _mutate(db, now) as (doc, session):
                doc["items"][connection_id] = {
                    "provider": provider_id,
                    "label": request.get("label") or provider.display_name,
                    "created_at": stamp,
                    "status": "accounts_pending",
                    "status_at": stamp,
                    "last_synced_at": None,
                    "first_sync_days": request.get("first_sync_days")
                    or store.DEFAULT_FIRST_SYNC_DAYS,
                    "requests": [stamp] if claimed else [],
                    "accounts": {},
                }
                if provider_id != "demo":
                    store.save_secret(db, connection_id, new_creds, session=session)

        _save_after_claim(claimed, save)
    logger.info(
        "connection_created connection_id=%s provider=%s claimed=%s",
        connection_id,
        provider_id,
        claimed,
    )
    outcome = _try_accounts(db, connection_id, transport_factory, deadline)
    return {**get_connection(db, connection_id), **outcome}


def _verify_then_replace(
    db: Any,
    connection_id: str,
    provider: ConnectorProvider,
    creds: Credentials,
    factory: TransportFactory,
    deadline: float,
) -> dict[str, Any]:
    """Reconnect with a pasted credential (an Access URL or Akahu tokens):
    list the accounts with it first and replace the stored secret only when
    the provider accepted it, so a mistyped credential never overwrites a
    working one (the browser's ``verifyThenReplace``). Called under
    ``_LOCK``.

    A refusal before the call (``request_time_short``, a disabled provider,
    the quota) is raised and counts nothing. A provider failure (for example
    a 401) is returned as ``accounts_error`` with the stored secret and the
    status left as they were; the call is counted. On success one commit
    saves the secret, merges the accounts and sets the success status.
    """
    provider_id = _begin_replacement_call(db, connection_id, deadline)
    started = time.monotonic()
    try:
        result: AccountsResult = _provider_call(
            "accounts", connection_id, provider, factory, deadline,
            lambda p, c: p.list_accounts(c, creds),
        )
    except SmartImportError as exc:
        return {
            **get_connection(db, connection_id),
            "accounts_error": exc.error_type,
            "account_errors": [],
        }
    now = utcnow()
    with _mutate(db, now) as (doc, session):
        conn = _connection(doc, connection_id)
        store.save_secret(db, connection_id, creds, session=session)
        _merge_accounts(db, provider_id, conn, result)
        _set_status(conn, _success_status(result.errors), now)
    logger.info(
        "connection_credentials_replaced connection_id=%s provider=%s", connection_id, provider_id
    )
    logger.info(
        "connection_accounts connection_id=%s provider=%s accounts=%d errors=%d duration_ms=%d",
        connection_id,
        provider_id,
        len(result.accounts),
        len(result.errors),
        _ms(started),
    )
    return {
        **get_connection(db, connection_id),
        "accounts_error": None,
        "account_errors": _listing_errors(result),
    }


def replace_credentials(
    db: Any, connection_id: str, request: dict[str, Any], transport_factory: TransportFactory
) -> dict[str, Any]:
    """Reconnect: keep the id and mapping, give the connection a new secret.

    A pasted credential (an Access URL or Akahu tokens) is verified first:
    the accounts are listed with it, and the secret is replaced (status
    ``ok``) only when the provider accepted it. A provider failure is
    returned as ``accounts_error`` with the stored secret and status kept
    (``_verify_then_replace``). A setup token cannot wait (it is spent once
    claimed), so it is saved first with ``accounts_pending`` and the
    accounts are refreshed after; the claim rules of ``create_connection``
    apply (``claim_timeout``, ``claim_not_saved``). The demo has no secret
    and is refreshed the same way. Returns the detail plus
    ``accounts_error`` and ``account_errors`` as ``create_connection``
    does."""
    deadline = _deadline()
    with _LOCK:
        conn = _connection(store.read_connections(db, now=utcnow()), connection_id)
        provider_id = conn["provider"]
        provider = _require_enabled(provider_id)
        setup_token, creds = _parse_input(provider_id, request)
        claimed = setup_token is not None
        if provider_id != "demo":
            store.check_key(db)
        if setup_token is None and provider_id != "demo":
            if creds is None:
                raise ConnectorError("bad_request")
            return _verify_then_replace(
                db, connection_id, provider, creds, transport_factory, deadline
            )
        if setup_token is not None:
            _require_time(deadline)
            creds = _claim(connection_id, provider, setup_token, transport_factory, deadline)
        if creds is None:
            raise ConnectorError("bad_request")
        new_creds: Credentials = creds

        def save() -> None:
            now = utcnow()
            with _mutate(db, now) as (doc, session):
                current = _connection(doc, connection_id)
                if claimed:
                    current["requests"].append(store.now_iso(lambda: now))
                _set_status(current, "accounts_pending", now)
                if provider_id != "demo":
                    store.save_secret(db, connection_id, new_creds, session=session)

        _save_after_claim(claimed, save)
    logger.info(
        "connection_credentials_replaced connection_id=%s provider=%s",
        connection_id,
        provider_id,
    )
    outcome = _try_accounts(db, connection_id, transport_factory, deadline)
    return {**get_connection(db, connection_id), **outcome}


def refresh_accounts(
    db: Any, connection_id: str, transport_factory: TransportFactory
) -> dict[str, Any]:
    """Refresh the account list (one provider request). New accounts after
    the first listing are added as ``ignore`` until mapped."""
    errors = _list_accounts(db, connection_id, transport_factory, _deadline())
    return {**get_connection(db, connection_id), "account_errors": errors}


def _known_keys(db: Any, doc: dict[str, Any]) -> set[str]:
    keys = store.imported_account_keys(db)
    for conn in doc["items"].values():
        keys.update(a["account_key"] for a in conn["accounts"].values())
    return keys


_REQUIRED_ACCOUNT_FIELDS = ("kind", "role", "label", "flip_balance")


def update_connection(db: Any, connection_id: str, update: dict[str, Any]) -> dict[str, Any]:
    """Change the label, the first-sync range or the account mapping.

    ``update`` holds only the fields the caller sent. Per account: ``kind``,
    ``role``, ``label`` and ``flip_balance`` cannot be null; ``liability_id``
    must name an existing debt (404 ``liability_not_found``) or be null;
    ``same_as_key`` must be a key a stored import or connected account uses
    (other than the account's own) or be null.
    """
    now = utcnow()
    with _mutate(db, now) as (doc, _):
        conn = _connection(doc, connection_id)
        if "label" in update:
            if not update["label"]:
                raise ConnectorError("bad_request")
            conn["label"] = update["label"]
        if "first_sync_days" in update:
            if update["first_sync_days"] not in store.FIRST_SYNC_DAYS:
                raise ConnectorError("bad_request")
            conn["first_sync_days"] = update["first_sync_days"]
        changes: dict[str, dict[str, Any]] = update.get("accounts") or {}
        known: Optional[set[str]] = None
        for pid, fields in changes.items():
            acct = conn["accounts"].get(pid)
            if acct is None:
                raise ConnectorError("bad_request")
            for name in _REQUIRED_ACCOUNT_FIELDS:
                if name in fields:
                    if fields[name] is None:
                        raise ConnectorError("bad_request")
                    acct[name] = fields[name]
            if "liability_id" in fields:
                lid = fields["liability_id"]
                if lid is not None and not store.liability_exists(db, lid):
                    raise SmartImportError("liability_not_found")
                acct["liability_id"] = lid
            if "same_as_key" in fields:
                key = fields["same_as_key"]
                if key is not None:
                    if known is None:
                        known = _known_keys(db, doc)
                    if key == acct["account_key"] or key not in known:
                        raise ConnectorError("bad_request")
                acct["same_as_key"] = key
    logger.info(
        "connection_updated connection_id=%s accounts_changed=%d", connection_id, len(changes)
    )
    return get_connection(db, connection_id)


def sync_connection(
    db: Any,
    connection_id: str,
    window_index: int,
    context: dict[str, Any],
    transport_factory: TransportFactory,
) -> dict[str, Any]:
    """Fetch one plan window and map it to statements with the profile's
    rules (``context``: ``{rules, categories}``). Returns
    ``{statements, account_errors, window}`` like the v2 sync; nothing is
    applied (the wizard applies with ``connection_id``)."""
    deadline = _deadline()
    plan = plan_sync(db, connection_id)
    if not 0 <= window_index < len(plan.windows):
        raise ConnectorError("bad_request")
    window = plan.windows[window_index]
    requests = window_requests(plan, window)
    provider_id, creds = _begin_call(db, connection_id, deadline)
    provider = registry.get_provider(provider_id)

    def fetch_and_map(
        p: ConnectorProvider, c: SafeClient
    ) -> tuple[FetchResult, list[NormalizedStatement]]:
        fetched = p.fetch(c, creds, requests, window[0], window[1])
        return fetched, to_statements(provider_id, fetched, requests, window, context, now=utcnow())

    started = time.monotonic()
    try:
        result, statements = _provider_call(
            "sync", connection_id, provider, transport_factory, deadline, fetch_and_map
        )
    except SmartImportError as exc:
        _record_failure(db, connection_id, exc.error_type)
        raise
    now = utcnow()
    with _mutate(db, now) as (doc, _):
        conn = doc["items"].get(connection_id)
        if conn is not None:
            _set_status(conn, _success_status(result.errors), now)
            conn["last_synced_at"] = store.now_iso(lambda: now)
    account_errors = _account_errors(result, requests)
    end = window[1]
    if result.end is not None and result.end < end:
        end = result.end
    logger.info(
        "connection_sync connection_id=%s provider=%s window=%d accounts=%d statements=%d "
        "transactions=%d account_errors=%d duration_ms=%d",
        connection_id,
        provider_id,
        window_index,
        len(requests),
        len(statements),
        sum(len(s["transactions"]) for s in statements),
        len(account_errors),
        _ms(started),
    )
    return {
        "statements": statements,
        "account_errors": account_errors,
        "window": {"start": window[0].isoformat(), "end": end.isoformat()},
    }


def _empty_removal() -> dict[str, Any]:
    return {
        "deleted": {"transactions": 0, "recurring_candidates": 0, "expenses": 0, "snapshots": 0},
        "reassigned": {"transactions": 0},
        "kept": [],
    }


def _add_undo(total: dict[str, Any], result: dict[str, Any]) -> None:
    for name, count in result["deleted"].items():
        total["deleted"][name] = total["deleted"].get(name, 0) + int(count)
    total["reassigned"]["transactions"] += int(result["reassigned"]["transactions"])
    total["kept"].extend(result["kept"])


def delete_connection(db: Any, connection_id: str, remove_data: bool) -> dict[str, Any]:
    """Disconnect (design 8.6): remove the metadata entry and the secret row
    in one transaction.

    Without ``remove_data`` the imports stay and keep ``connection_id`` as a
    soft reference; each can still be undone. With it, every import of the
    connection is undone first, newest first, in that same transaction, by
    the smart import undo itself (``undo_in_session``), so its rules hold:
    edited or debt-linked created expenses are kept and listed, snapshots go
    and balances are recomputed, rows a file import claimed are handed over,
    remembered merchants stay.

    Any failure rolls everything back (``save_failed``): the connection, its
    secret and every import stay, so the same request can be repeated.

    Returns ``{connection_id, remove_data, imports_undone, imports_kept,
    deleted, reassigned, kept}``; ``deleted``, ``reassigned`` and ``kept``
    are the undo results summed (zero and empty without ``remove_data``).
    """
    now = utcnow()
    # The smart import undo stores naive UTC, as ``undo_import`` does.
    undo_now = now.astimezone(timezone.utc).replace(tzinfo=None)
    total = _empty_removal()
    undone = 0
    kept_imports = 0
    failure: Optional[str] = None
    try:
        with _mutate(db, now) as (doc, session):
            _connection(doc, connection_id)
            import_ids = import_service.connection_import_ids(session, connection_id)
            if remove_data:
                for import_id in import_ids:
                    _add_undo(total, import_service.undo_in_session(session, import_id, undo_now))
                    undone += 1
            else:
                kept_imports = len(import_ids)
            store.delete_secret(db, connection_id, session=session)
            del doc["items"][connection_id]
    except SmartImportError:
        # Catalog errors (404 connection_not_found, save_failed) carry no
        # content; the transaction has already rolled back.
        raise
    except Exception as exc:  # anything else: rolled back, reported as save_failed
        failure = type(exc).__name__
    if failure is not None:
        # Raised outside the handler: no exception text or context travels on.
        logger.error(
            "connection_disconnect_failed connection_id=%s remove_data=%s undone_before=%d "
            "error_type=%s",
            connection_id,
            remove_data,
            undone,
            failure,
        )
        raise SmartImportError("save_failed")
    logger.info(
        "connection_disconnected connection_id=%s remove_data=%s imports_undone=%d "
        "imports_kept=%d kept=%d",
        connection_id,
        remove_data,
        undone,
        kept_imports,
        len(total["kept"]),
    )
    return {
        "connection_id": connection_id,
        "remove_data": remove_data,
        "imports_undone": undone,
        "imports_kept": kept_imports,
        **total,
    }
