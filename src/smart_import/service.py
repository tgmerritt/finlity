"""Smart import data layer for the server path: read side and settings.

Pure functions over a ``Database``. The browser twin (``local-smart-import.ts``)
mirrors these names and results exactly, so keep behavior changes in step.

Logging rule: log event names, ids, counts and exception types only. Never
file names, descriptions, merchant keys, amounts, balances or account data.
Unexpected errors become a fixed 500 and the original exception is dropped
(``from None``), because SQLAlchemy errors carry bound parameters.
"""

from __future__ import annotations

import functools
import logging
from datetime import date, timedelta
from typing import Any, Callable, Iterable, Optional, TypeVar

from sqlalchemy import or_, select

from src.database import Database
from src.database.models import (
    BankStatementImport,
    BudgetExpenseCategory,
    ImportTransaction,
    Liability,
    MerchantRule,
    SmartImportMeta,
)
from src.liabilities import clock

from .errors import SmartImportError
from .settings_store import SettingsUpdate, read_settings, write_settings

logger = logging.getLogger(__name__)

HISTORY_DAYS = 400
MAX_STORED_KEY_CHARS = 120  # = limits.MAX_DESCRIPTION_CHARS; stored keys never exceed it
IN_CHUNK = 500  # bound parameters per IN (...) query
DEBT_KINDS = ("credit_card", "loan")

F = TypeVar("F", bound=Callable[..., Any])


def _guarded(operation: str, error_type: str = "server_error") -> Callable[[F], F]:
    """Turn any unexpected failure into a fixed error that carries no content."""

    def wrap(fn: F) -> F:
        @functools.wraps(fn)
        def inner(*args: Any, **kwargs: Any) -> Any:
            try:
                return fn(*args, **kwargs)
            except SmartImportError:
                raise
            except Exception as exc:
                logger.error(
                    "smart_import_%s_failed error_type=%s", operation, type(exc).__name__
                )
                raise SmartImportError(error_type) from None

        return inner  # type: ignore[return-value]

    return wrap


def _iso(value: Any) -> Optional[str]:
    if value is None:
        return None
    return value.isoformat()


def _chunks(items: list[str]) -> Iterable[list[str]]:
    for start in range(0, len(items), IN_CHUNK):
        yield items[start : start + IN_CHUNK]


def _categories(session: Any) -> list[BudgetExpenseCategory]:
    return (
        session.query(BudgetExpenseCategory)
        .order_by(BudgetExpenseCategory.sort_order, BudgetExpenseCategory.name, BudgetExpenseCategory.id)
        .all()
    )


def _rules(session: Any) -> list[MerchantRule]:
    return session.query(MerchantRule).order_by(MerchantRule.merchant_key, MerchantRule.id).all()


# ------------------------------------------------------------------ context


def _known_accounts(session: Any, labels: dict[str, str]) -> list[dict[str, Any]]:
    """One entry per account key, from its newest meta row; a saved label wins."""
    rows = (
        session.query(SmartImportMeta)
        .filter(SmartImportMeta.account_key.isnot(None))
        .order_by(SmartImportMeta.created_at.desc(), SmartImportMeta.import_id.desc())
        .all()
    )
    seen: dict[str, dict[str, Any]] = {}
    for row in rows:
        if row.account_key in seen:
            continue
        seen[row.account_key] = {
            "account_key": row.account_key,
            "label": labels.get(row.account_key) or row.account_label,
            "last4": row.account_last4,
            "kind": row.account_kind,
            "institution": row.institution,
            "liability_id": row.liability_id,
        }
    return sorted(seen.values(), key=lambda a: ((a["label"] or "").lower(), a["account_key"]))


@_guarded("context")
def get_context(db: Database) -> dict[str, Any]:
    """Rules, categories, known accounts, remembered CSV layouts and settings."""
    settings = read_settings(db)
    with db.get_session() as session:
        categories = _categories(session)
        known = {c.id for c in categories}
        rules = [
            {"id": r.id, "merchant_key": r.merchant_key, "category_id": r.category_id, "kind": r.kind}
            for r in _rules(session)
            if r.category_id is None or r.category_id in known
        ]
        return {
            "rules": rules,
            "categories": [{"id": c.id, "name": c.name} for c in categories],
            "accounts": _known_accounts(session, settings["accounts"]),
            "csv_layouts": settings["csv_layouts"],
            "settings": settings,
        }


# ------------------------------------------------------------------ preview


def _existing_dedupe_keys(session: Any, keys: list[str]) -> list[str]:
    found: set[str] = set()
    for chunk in _chunks(keys):
        found.update(
            session.execute(
                select(ImportTransaction.dedupe_key).where(ImportTransaction.dedupe_key.in_(chunk))
            ).scalars()
        )
    return sorted(found)


def _prior_files(session: Any, hashes: list[str]) -> list[dict[str, Any]]:
    """The newest earlier import per file hash. A second statement of one file
    is stored as ``<hash>:<index>``, so both spellings count as the same file."""
    prior = []
    for file_hash in hashes:
        row = (
            session.query(BankStatementImport)
            .filter(
                or_(
                    BankStatementImport.content_hash == file_hash,
                    BankStatementImport.content_hash.startswith(file_hash + ":", autoescape=True),
                )
            )
            .order_by(
                BankStatementImport.analyzed_at.desc(),
                BankStatementImport.uploaded_at.desc(),
                BankStatementImport.id.desc(),
            )
            .first()
        )
        if row is not None:
            prior.append(
                {
                    "file_hash": file_hash,
                    "import_id": row.id,
                    "imported_at": _iso(row.analyzed_at or row.uploaded_at),
                }
            )
    return prior


def _active_liabilities(session: Any) -> list[Liability]:
    return (
        session.query(Liability)
        .filter(Liability.is_active.is_(True))
        .order_by(Liability.name, Liability.id)
        .all()
    )


def _type_fits(kind: str, liability_type: str) -> bool:
    """A card statement fits a card; a loan statement fits any other debt."""
    return (liability_type == "credit_card") == (kind == "credit_card")


def _lender_match(institution: Optional[str], kind: str, liabilities: list[Liability]) -> Optional[str]:
    """Case-insensitive: equal to the lender or name first, then contained in or
    containing it (3+ characters). The first fitting liability by name wins."""
    needle = (institution or "").strip().lower()
    if not needle:
        return None
    fitting = [x for x in liabilities if _type_fits(kind, x.liability_type)]

    def names(x: Liability) -> list[str]:
        return [n.strip().lower() for n in (x.lender, x.name) if n and n.strip()]

    for x in fitting:
        if needle in names(x):
            return x.id
    if len(needle) >= 3:
        for x in fitting:
            if any(needle in n or n in needle for n in names(x) if len(n) >= 3):
                return x.id
    return None


def _previous_liability(session: Any, account_key: Optional[str], active_ids: set[str]) -> Optional[str]:
    if not account_key:
        return None
    rows = (
        session.query(SmartImportMeta.liability_id)
        .filter(SmartImportMeta.account_key == account_key, SmartImportMeta.liability_id.isnot(None))
        .order_by(SmartImportMeta.created_at.desc(), SmartImportMeta.import_id.desc())
        .all()
    )
    for (liability_id,) in rows:
        if liability_id in active_ids:
            return liability_id
    return None


def _liability_suggestions(session: Any, statements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    liabilities = _active_liabilities(session)
    active_ids = {x.id for x in liabilities}
    out = []
    for st in statements:
        kind = st["account_kind"]
        if kind not in DEBT_KINDS:
            continue
        liability_id = _previous_liability(session, st.get("account_key"), active_ids)
        reason = "previous_import"
        if liability_id is None:
            liability_id = _lender_match(st.get("institution"), kind, liabilities)
            reason = "lender_match"
        if liability_id is not None:
            out.append(
                {
                    "file_hash": st["file_hash"],
                    "account_key": st.get("account_key"),
                    "liability_id": liability_id,
                    "reason": reason,
                }
            )
    return out


def _history(session: Any, keys: list[str], since: date) -> list[dict[str, Any]]:
    rows: list[ImportTransaction] = []
    for chunk in _chunks(keys):
        rows.extend(
            session.query(ImportTransaction)
            .filter(
                ImportTransaction.merchant_key.in_(chunk),
                ImportTransaction.amount < 0,
                ImportTransaction.posted_date >= since,
            )
            .all()
        )
    rows.sort(key=lambda r: (r.posted_date, r.merchant_key, r.id))
    return [
        {"merchant_key": r.merchant_key, "posted_date": r.posted_date.isoformat(), "amount": r.amount}
        for r in rows
    ]


@_guarded("preview")
def preview(db: Database, statements: list[dict[str, Any]]) -> dict[str, Any]:
    """What the batch would collide with. Reads only; nothing is written."""
    since = clock.today() - timedelta(days=HISTORY_DAYS)
    dedupe_keys = list(dict.fromkeys(k for st in statements for k in st["dedupe_keys"]))
    merchant_keys = list(
        dict.fromkeys(k[:MAX_STORED_KEY_CHARS] for st in statements for k in st["merchant_keys"])
    )
    hashes = list(dict.fromkeys(st["file_hash"] for st in statements))
    with db.get_session() as session:
        return {
            "existing_dedupe_keys": _existing_dedupe_keys(session, dedupe_keys),
            "prior_files": _prior_files(session, hashes),
            "liability_suggestions": _liability_suggestions(session, statements),
            "history": _history(session, merchant_keys, since),
        }


# ------------------------------------------------------------------ imports


@_guarded("list_imports")
def list_imports(db: Database) -> list[dict[str, Any]]:
    """Smart imports, newest first. Legacy imports (no meta row) are not listed."""
    with db.get_session() as session:
        rows = (
            session.query(SmartImportMeta, BankStatementImport)
            .join(BankStatementImport, BankStatementImport.id == SmartImportMeta.import_id)
            .order_by(SmartImportMeta.created_at.desc(), SmartImportMeta.import_id.desc())
            .all()
        )
        return [
            {
                "import_id": m.import_id,
                "batch_id": m.batch_id,
                "file_name": b.file_name,
                "origin": m.origin,
                "format": m.format,
                "parser": m.parser,
                "account_kind": m.account_kind,
                "account_key": m.account_key,
                "account_label": m.account_label,
                "account_last4": m.account_last4,
                "institution": m.institution,
                "period_start": _iso(m.period_start),
                "period_end": _iso(m.period_end),
                "closing_balance": m.closing_balance,
                "closing_balance_date": _iso(m.closing_balance_date),
                "liability_id": m.liability_id,
                "txn_new": m.txn_new,
                "txn_duplicate": m.txn_duplicate,
                "txn_excluded": m.txn_excluded,
                "ai_used": m.ai_used,
                "ai_provider": m.ai_provider,
                "imported_at": _iso(m.created_at),
            }
            for m, b in rows
        ]


# -------------------------------------------------------------------- rules


@_guarded("list_rules")
def list_rules(db: Database) -> list[dict[str, Any]]:
    """Every remembered merchant; a rule whose category was deleted says so."""
    with db.get_session() as session:
        names = {c.id: c.name for c in _categories(session)}
        return [
            {
                "id": r.id,
                "merchant_key": r.merchant_key,
                "category_id": r.category_id,
                "category_name": names.get(r.category_id) if r.category_id else None,
                "category_deleted": r.category_id is not None and r.category_id not in names,
                "kind": r.kind,
                "hits": r.hits,
                "source": r.source,
                "updated_at": _iso(r.updated_at),
            }
            for r in _rules(session)
        ]


@_guarded("delete_rule", "save_failed")
def delete_rule(db: Database, rule_id: str) -> dict[str, Any]:
    with db.get_session() as session:
        row = session.get(MerchantRule, rule_id)
        if row is None:
            raise SmartImportError("rule_not_found")
        session.delete(row)
        result = {"deleted": True}  # build the response before the commit
        session.commit()
        logger.info("smart_import_rule_deleted id=%s", rule_id)
        return result


# ----------------------------------------------------------------- settings


@_guarded("get_settings")
def get_settings(db: Database) -> dict[str, Any]:
    return read_settings(db)


@_guarded("put_settings", "save_failed")
def put_settings(db: Database, update: SettingsUpdate) -> dict[str, Any]:
    result = write_settings(db, update)
    logger.info("smart_import_settings_saved fields=%d", len(update.model_fields_set))
    return result
