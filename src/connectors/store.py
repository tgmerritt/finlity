"""Server-mode connection storage (design 7.1, 7.2; plan B1).

Not part of the stateless core: this module is the server data layer and is
never imported by ``src/connectors/__init__.py`` or the v2 routes.

Two kinds of ``app_settings`` rows, and no new table:

* ``connections``: one sanitized JSON document with every connection's
  metadata (provider, label, status, request times, account mapping). It never
  holds a credential. Every read runs ``sanitize``, so a hand-edited or
  corrupt row degrades to the valid entries instead of failing.
* ``connection_secret:<uuid>``: one row per connection, ``encrypted=1``, value
  ``fernet:<token>`` from ``SecretsManager`` (key from ``SECRET_KEY`` or
  ``~/.investment_dashboard_key``). The plaintext is a compact JSON of the
  credentials. Anything that cannot be decrypted and parsed (missing row,
  missing or rotated key, a browser ``wc1:`` value, bad JSON) raises
  ``SecretUnreadable``, which the service maps to ``reconnect_needed``.

Hosted visitors keep their connections in the browser, never on the server,
so on a shared deployment (``env.shared_deployment``) ``save_secret`` and
``load_secret`` refuse with ``connections_unavailable``, and
``write_connections`` refuses any write except one that only removes entries
(so stray metadata can be cleaned up). ``delete_secret`` is always allowed.
``read_connections`` reads (and sanitizes) on any deployment; refusing a
whole request on a shared deployment is the routes' job (plan B2).

The secret plaintext names its connection id; ``load_secret`` refuses a
secret whose id does not match the row it was read from, so ciphertext copied
into another connection's row is unreadable.

Every write function takes an optional SQLAlchemy ``session``. Without one it
opens a session and commits; with one it only stages the change, so a caller
can commit a connection and its secret (or delete both) in one transaction.

Logging: event names and connection ids only. Never a credential, label,
account name or institution.
"""

from __future__ import annotations

import json
import logging
import re
from collections.abc import Callable, Iterable, Iterator
from contextlib import contextmanager
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

from ..database import AppSettings, ImportTransaction, Liability, SmartImportMeta
from ..services.secrets import EncryptionKeyUnavailable, SecretsManager, SecretUnreadable
from ..smart_import.types import ACCOUNT_KINDS
from .env import shared_deployment
from .errors import ConnectorError
from .http import check_simplefin_url
from .limits import MAX_ACCOUNTS, MAX_CONNECTIONS
from .registry import PROVIDER_IDS
from .types import AkahuCredentials, Credentials, DemoCredentials, SimpleFinCredentials

__all__ = [
    "CONNECTIONS_KEY",
    "SECRET_KEY_PREFIX",
    "SecretUnreadable",
    "check_key",
    "delete_secret",
    "empty",
    "imported_account_keys",
    "liability_exists",
    "load_secret",
    "newest_import_ends",
    "newest_posted_dates",
    "read_connections",
    "sanitize",
    "save_secret",
    "secret_key",
    "suggest_liability",
    "transaction",
    "write_connections",
]

logger = logging.getLogger(__name__)

CONNECTIONS_KEY = "connections"
SECRET_KEY_PREFIX = "connection_secret:"
VERSION = 1

MAX_LABEL_CHARS = 120
MAX_PROVIDER_TEXT_CHARS = 200
MAX_PROVIDER_ACCOUNT_ID_CHARS = 200
MAX_REQUESTS = 64
REQUEST_WINDOW = timedelta(hours=24)
MAX_CREDENTIAL_CHARS = 4096

STATUSES = frozenset(
    {"ok", "accounts_pending", "reconnect_needed", "payment_required", "rate_limited", "error"}
)
ROLES = frozenset({"debt", "cash_flow", "ignore"})
FIRST_SYNC_DAYS = (30, 60, 90)
DEFAULT_FIRST_SYNC_DAYS = 90

_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_CONNECTOR_ACCOUNT_KEY = re.compile(r"acct:[0-9a-f]{64}")
# Any account key the smart import settings accept (settings_store._ACCOUNT_KEY):
# a "same as" mapping may name a file-import key.
_ANY_ACCOUNT_KEY = re.compile(r"(acct|label):[^\x00-\x1f\x7f]{1,190}")
_CURRENCY = re.compile(r"[A-Z]{3}")
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")
# ISO 8601 with seconds and an explicit offset, so both paths parse it alike.
_ISO = re.compile(
    r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})"
)


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


# --- sanitize ------------------------------------------------------------------


def empty() -> dict[str, Any]:
    return {"version": VERSION, "items": {}}


def _member(value: Any, allowed: Any) -> bool:
    """``value`` is one of the allowed strings. Checking the type first keeps
    an unhashable value (a dict or list from a crafted row) from raising."""
    return isinstance(value, str) and value in allowed


def _is_uuid(value: Any) -> bool:
    return isinstance(value, str) and _UUID.fullmatch(value) is not None


MAX_LIABILITY_ID_CHARS = 64


def _is_liability_id(value: Any) -> bool:
    """A debt id as the mapping request accepts it: 1 to 64 characters, no
    control characters. Not only UUIDs: smart import Apply links any existing
    debt, and the demo's debts have ids such as ``demo-card``."""
    return (
        isinstance(value, str)
        and 0 < len(value) <= MAX_LIABILITY_ID_CHARS
        and _CONTROL.search(value) is None
    )


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not _ISO.fullmatch(value):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def _text(value: Any, max_chars: int, *, allow_empty: bool) -> Optional[str]:
    """``value`` when it is a string within limits with no control characters."""
    if not isinstance(value, str) or len(value) > max_chars or _CONTROL.search(value):
        return None
    if not value and not allow_empty:
        return None
    return value


def _clean_requests(raw: Any, now: datetime) -> list[str]:
    if not isinstance(raw, list):
        return []
    cutoff = now - REQUEST_WINDOW
    kept: list[tuple[datetime, str]] = []
    for item in raw:
        when = _parse_iso(item)
        if when is not None and cutoff < when <= now:
            kept.append((when, item))
    kept.sort(key=lambda pair: pair[0])
    return [text for _, text in kept[-MAX_REQUESTS:]]


def _clean_account(raw: Any) -> Optional[dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    name = _text(raw.get("name"), MAX_PROVIDER_TEXT_CHARS, allow_empty=True)
    institution = raw.get("institution")
    if institution is not None:
        institution = _text(institution, MAX_PROVIDER_TEXT_CHARS, allow_empty=True)
        if institution is None:
            return None
    currency = raw.get("currency")
    kind = raw.get("kind")
    role = raw.get("role")
    label = _text(raw.get("label"), MAX_LABEL_CHARS, allow_empty=False)
    account_key = raw.get("account_key")
    liability_id = raw.get("liability_id")
    same_as_key = raw.get("same_as_key")
    if (
        name is None
        or not (isinstance(currency, str) and _CURRENCY.fullmatch(currency))
        or not _member(kind, ACCOUNT_KINDS)
        or not _member(role, ROLES)
        or label is None
        or not (isinstance(account_key, str) and _CONNECTOR_ACCOUNT_KEY.fullmatch(account_key))
        or not (liability_id is None or _is_liability_id(liability_id))
        or not (
            same_as_key is None
            or (isinstance(same_as_key, str) and _ANY_ACCOUNT_KEY.fullmatch(same_as_key))
        )
    ):
        return None
    return {
        "name": name,
        "institution": institution,
        "currency": currency,
        "kind": kind,
        "role": role,
        "label": label,
        "account_key": account_key,
        "liability_id": liability_id,
        "flip_balance": raw.get("flip_balance") is True,
        "same_as_key": same_as_key,
    }


def _clean_accounts(raw: Any) -> dict[str, dict[str, Any]]:
    if not isinstance(raw, dict):
        return {}
    clean: dict[str, dict[str, Any]] = {}
    for account_id, entry in raw.items():
        if len(clean) >= MAX_ACCOUNTS:
            break
        if _text(account_id, MAX_PROVIDER_ACCOUNT_ID_CHARS, allow_empty=False) is None:
            continue
        account = _clean_account(entry)
        if account is not None:
            clean[account_id] = account
    return clean


def _clean_connection(raw: Any, now: datetime) -> Optional[dict[str, Any]]:
    if not isinstance(raw, dict):
        return None
    provider = raw.get("provider")
    label = _text(raw.get("label"), MAX_LABEL_CHARS, allow_empty=False)
    created_at = raw.get("created_at")
    status = raw.get("status")
    if (
        not _member(provider, PROVIDER_IDS)
        or label is None
        or _parse_iso(created_at) is None
        or not _member(status, STATUSES)
    ):
        return None
    status_at = raw.get("status_at")
    if _parse_iso(status_at) is None:
        status_at = created_at
    last_synced_at = raw.get("last_synced_at")
    if _parse_iso(last_synced_at) is None:
        last_synced_at = None
    first_sync_days = raw.get("first_sync_days")
    if (
        not isinstance(first_sync_days, int)
        or isinstance(first_sync_days, bool)
        or first_sync_days not in FIRST_SYNC_DAYS
    ):
        first_sync_days = DEFAULT_FIRST_SYNC_DAYS
    return {
        "provider": provider,
        "label": label,
        "created_at": created_at,
        "status": status,
        "status_at": status_at,
        "last_synced_at": last_synced_at,
        "first_sync_days": first_sync_days,
        "requests": _clean_requests(raw.get("requests"), now),
        "accounts": _clean_accounts(raw.get("accounts")),
    }


def sanitize(raw: Any, *, now: Optional[datetime] = None) -> dict[str, Any]:
    """The valid part of a stored ``connections`` document (design 7.1).

    Unknown keys are dropped; an invalid connection or account is dropped,
    not repaired. At most ``MAX_CONNECTIONS`` connections and ``MAX_ACCOUNTS``
    accounts each, in stored order. ``requests`` keeps timestamps from the last
    24 hours before ``now`` (at most 64, oldest first); ``now`` is injectable
    for tests and defaults to the current UTC time.
    """
    when = now or _utcnow()
    result = empty()
    items = raw.get("items") if isinstance(raw, dict) else None
    if not isinstance(items, dict):
        return result
    for connection_id, entry in items.items():
        if len(result["items"]) >= MAX_CONNECTIONS:
            break
        if not _is_uuid(connection_id):
            continue
        connection = _clean_connection(entry, when)
        if connection is not None:
            result["items"][connection_id] = connection
    return result


# --- rows ------------------------------------------------------------------------


def _refuse_shared() -> None:
    if shared_deployment():
        raise ConnectorError("connections_unavailable")


def secret_key(connection_id: str) -> str:
    """The ``app_settings`` key of a connection's secret row.

    Only a canonical lowercase UUID is accepted, so a caller-supplied id can
    never name another settings row.
    """
    if not _is_uuid(connection_id):
        raise ConnectorError("connection_not_found")
    return SECRET_KEY_PREFIX + connection_id


@contextmanager
def _session_scope(db: Any, session: Any) -> Iterator[Any]:
    """The caller's session (no commit), or a new one committed on success."""
    if session is not None:
        yield session
        return
    with db.get_session() as own:
        try:
            yield own
            own.commit()
        except BaseException:
            own.rollback()
            raise


def _upsert(session: Any, key: str, value: str, encrypted: bool) -> None:
    row = session.query(AppSettings).filter_by(key=key).first()
    if row is None:
        session.add(AppSettings(key=key, value=value, encrypted=encrypted))
    else:
        row.value = value
        row.encrypted = encrypted
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
    session.flush()


def read_connections(
    db: Any, *, session: Any = None, now: Optional[datetime] = None
) -> dict[str, Any]:
    """The sanitized ``connections`` document; an empty one when there is no row.

    Reading never writes, so opening a database adds no row.
    """
    if session is not None:
        row = session.query(AppSettings).filter_by(key=CONNECTIONS_KEY).first()
    else:
        row = db.get_setting(CONNECTIONS_KEY)
    raw = getattr(row, "value", None) if row is not None else None
    if not raw:
        return sanitize(None, now=now)
    try:
        stored = json.loads(raw)
    except (TypeError, ValueError, RecursionError):
        # RecursionError: a deeply nested crafted row.
        stored = None
    return sanitize(stored, now=now)


def write_connections(
    db: Any,
    data: Any,
    *,
    session: Any = None,
    now: Optional[datetime] = None,
) -> dict[str, Any]:
    """Sanitize ``data`` and replace the ``connections`` row with it. Returns
    what was stored.

    On a shared deployment only a removal is allowed: every remaining entry
    must already be stored, unchanged. Anything else is
    ``connections_unavailable``.
    """
    clean = sanitize(data, now=now)
    text = json.dumps(clean, sort_keys=True, separators=(",", ":"))
    with _session_scope(db, session) as s:
        if shared_deployment():
            current = read_connections(db, session=s, now=now)["items"]
            if any(current.get(cid) != entry for cid, entry in clean["items"].items()):
                raise ConnectorError("connections_unavailable")
        _upsert(s, CONNECTIONS_KEY, text, False)
    return clean


# --- secrets ---------------------------------------------------------------------


def _serialize(connection_id: str, credentials: Credentials) -> str:
    payload: dict[str, str]
    if isinstance(credentials, SimpleFinCredentials):
        payload = {
            "provider": "simplefin",
            "base_url": credentials.base_url,
            "username": credentials.username,
            "password": credentials.password,
        }
    elif isinstance(credentials, AkahuCredentials):
        payload = {
            "provider": "akahu",
            "user_token": credentials.user_token,
            "app_token": credentials.app_token,
        }
    elif isinstance(credentials, DemoCredentials):
        payload = {"provider": "demo"}
    else:
        raise ConnectorError("bad_request")
    # The id binds the ciphertext to its row (see load_secret).
    payload["id"] = connection_id
    return json.dumps(payload, sort_keys=True, separators=(",", ":"))


def _field(payload: dict[str, Any], name: str) -> Optional[str]:
    value = payload.get(name)
    if isinstance(value, str) and 0 < len(value) <= MAX_CREDENTIAL_CHARS:
        return value
    return None


def _simplefin_base_ok(base_url: str) -> bool:
    """The stored base URL still passes the Access URL allowlist (the
    userinfo is held apart, so a placeholder one is added for the check)."""
    if "@" in base_url or not base_url.startswith("https://"):
        return False
    probe = "https://u:p@" + base_url[len("https://"):]
    try:
        return check_simplefin_url(probe, kind="access").base_url == base_url
    except ConnectorError:
        return False


def _deserialize(connection_id: str, text: str) -> Optional[Credentials]:
    payload: Any
    try:
        payload = json.loads(text)
    except (ValueError, RecursionError):
        payload = None
    if not isinstance(payload, dict) or payload.get("id") != connection_id:
        return None
    provider = payload.get("provider")
    if provider == "simplefin":
        base_url = _field(payload, "base_url")
        username = _field(payload, "username")
        password = _field(payload, "password")
        if base_url is None or username is None or password is None:
            return None
        if not _simplefin_base_ok(base_url):
            return None
        return SimpleFinCredentials(base_url=base_url, username=username, password=password)
    if provider == "akahu":
        user_token = _field(payload, "user_token")
        app_token = _field(payload, "app_token")
        if user_token is None or app_token is None:
            return None
        return AkahuCredentials(user_token=user_token, app_token=app_token)
    if provider == "demo":
        return DemoCredentials()
    return None


def save_secret(
    db: Any,
    connection_id: str,
    credentials: Credentials,
    *,
    session: Any = None,
    secrets: Optional[SecretsManager] = None,
) -> None:
    """Encrypt ``credentials`` and store them in ``connection_secret:<id>``
    (``encrypted=1``, ``fernet:`` value). Refused on a shared deployment."""
    _refuse_shared()
    if not _is_uuid(connection_id):
        raise ConnectorError("bad_request")
    key = secret_key(connection_id)
    manager = secrets or SecretsManager(db)
    plaintext = _serialize(connection_id, credentials)
    ciphertext: Optional[str] = None
    try:
        ciphertext = manager.encrypt_for_storage(plaintext)
    except (EncryptionKeyUnavailable, ValueError):
        # An unreadable or malformed key: never regenerated, nothing stored.
        ciphertext = None
    if ciphertext is None:
        logger.error("connection_secret_key_unavailable", extra={"connection_id": connection_id})
        raise ConnectorError("save_failed")
    with _session_scope(db, session) as s:
        _upsert(s, key, ciphertext, True)
    logger.info("connection_secret_saved", extra={"connection_id": connection_id})


def load_secret(
    db: Any,
    connection_id: str,
    *,
    secrets: Optional[SecretsManager] = None,
    session: Any = None,
) -> Credentials:
    """The decrypted credentials of a connection.

    Raises ``SecretUnreadable`` when the row is missing, the key is missing or
    has changed, the value is not a server ``fernet:`` value (a browser
    ``wc1:`` value, a plaintext row), the plaintext is not a known
    credential, names another connection id, or (SimpleFIN) its host no
    longer passes the allowlist. The service turns that into ``reconnect_needed``.
    Refused on a shared deployment.
    """
    _refuse_shared()
    key = secret_key(connection_id)
    if session is not None:
        row = session.query(AppSettings).filter_by(key=key).first()
    else:
        row = db.get_setting(key)
    if row is None:
        logger.warning("connection_secret_missing", extra={"connection_id": connection_id})
        raise SecretUnreadable()
    manager = secrets or SecretsManager(db)
    credentials: Optional[Credentials] = None
    unreadable = False
    try:
        credentials = _deserialize(
            connection_id, manager.decrypt_stored(row.value, row.encrypted)
        )
    except SecretUnreadable:
        unreadable = True
    # Raised outside the except block so no exception context holds plaintext.
    if unreadable or credentials is None:
        logger.warning("connection_secret_unreadable", extra={"connection_id": connection_id})
        raise SecretUnreadable()
    return credentials


def delete_secret(db: Any, connection_id: str, *, session: Any = None) -> bool:
    """Remove a connection's secret row. True when a row was removed.

    Allowed on any deployment so stray rows can always be cleaned up.
    """
    key = secret_key(connection_id)
    with _session_scope(db, session) as s:
        row = s.query(AppSettings).filter_by(key=key).first()
        if row is None:
            return False
        s.delete(row)
        s.flush()
    logger.info("connection_secret_deleted", extra={"connection_id": connection_id})
    return True


def now_iso(clock: Callable[[], datetime] = _utcnow) -> str:
    """A request or status timestamp in the stored format (UTC, seconds, ``Z``)."""
    return clock().astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# --- reads for the connection service (plan B2) ------------------------------------
#
# The service (``service.py``) reaches the database only through these helpers,
# so this module stays the single place in ``src/connectors`` that touches it.
# They read; none of them writes.


@contextmanager
def transaction(db: Any) -> Iterator[Any]:
    """A session committed on success and rolled back on any error, for a
    caller that changes the ``connections`` row and a secret together."""
    with _session_scope(db, None) as session:
        yield session


def check_key(db: Any, *, secrets: Optional[SecretsManager] = None) -> None:
    """Prove the encryption key is usable before a one-time setup token is
    claimed, so a claimed credential is never lost to ``save_failed``.
    Refused on a shared deployment."""
    _refuse_shared()
    manager = secrets or SecretsManager(db)
    usable = True
    try:
        manager.encrypt_for_storage("key-check")
    except (EncryptionKeyUnavailable, ValueError):
        usable = False
    if not usable:
        logger.error("connection_secret_key_unavailable")
        raise ConnectorError("save_failed")


def newest_import_ends(
    db: Any, connection_id: str, account_keys: Iterable[str]
) -> dict[str, date]:
    """The newest ``period_end`` per account key among this connection's
    imports (``smart_import_meta.connection_id``). Undo deletes the meta row,
    so an undone sync no longer counts (design 9.1, rule 1)."""
    keys = sorted(set(account_keys))
    out: dict[str, date] = {}
    if not keys:
        return out
    with db.get_session() as session:
        rows = (
            session.query(SmartImportMeta.account_key, SmartImportMeta.period_end)
            .filter(
                SmartImportMeta.connection_id == connection_id,
                SmartImportMeta.account_key.in_(keys),
                SmartImportMeta.period_end.isnot(None),
            )
            .all()
        )
    for key, end in rows:
        if key not in out or end > out[key]:
            out[key] = end
    return out


def newest_posted_dates(db: Any, account_keys: Iterable[str]) -> dict[str, date]:
    """The newest stored ``posted_date`` per account key (design 9.1, rule 2)."""
    out: dict[str, date] = {}
    with db.get_session() as session:
        for key in sorted(set(account_keys)):
            row = (
                session.query(ImportTransaction.posted_date)
                .filter(ImportTransaction.account_key == key)
                .order_by(ImportTransaction.posted_date.desc())
                .first()
            )
            if row is not None and row[0] is not None:
                out[key] = row[0]
    return out


def imported_account_keys(db: Any) -> set[str]:
    """Every account key a stored import used (file, sample or connector)."""
    with db.get_session() as session:
        rows = (
            session.query(SmartImportMeta.account_key)
            .filter(SmartImportMeta.account_key.isnot(None))
            .distinct()
            .all()
        )
    return {key for (key,) in rows if isinstance(key, str)}


def liability_exists(db: Any, liability_id: str) -> bool:
    """A liability with this id exists. An id the connections row could not
    store (``_is_liability_id``) is treated as missing."""
    if not _is_liability_id(liability_id):
        return False
    with db.get_session() as session:
        return session.get(Liability, liability_id) is not None


def suggest_liability(
    db: Any, institution: Optional[str], kind: str, account_key: Optional[str]
) -> Optional[str]:
    """The debt a new card or loan account most likely belongs to: the one
    previously linked to the same account key, else a lender or name match
    (the smart import preview's rules). None when nothing fits."""
    # Imported here: smart import Apply reads the connections row through this
    # module (``_check_references``), so a module-level import would be circular.
    from ..smart_import.service import (
        active_liabilities,
        lender_match,
        previous_liability,
    )

    with db.get_session() as session:
        liabilities = active_liabilities(session)
        active_ids: set[str] = {str(x.id) for x in liabilities}
        found = previous_liability(session, account_key, active_ids)
        if found is None:
            found = lender_match(institution, kind, liabilities)
    return found if _is_liability_id(found) else None
