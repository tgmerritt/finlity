"""Smart import data layer for the server path: read side and settings.

Pure functions over a ``Database``. The browser twin (``local-smart-import.ts``)
mirrors these names and results exactly, so keep behavior changes in step.

Logging rule: log event names, ids, counts and exception types only. Never
file names, descriptions, merchant keys, amounts, balances or account data.
Unexpected errors become a fixed 500 and the original exception is dropped
(``from None``), because SQLAlchemy errors carry bound parameters.
"""

from __future__ import annotations

import calendar
import functools
import json
import logging
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable, Optional, TypeVar

from sqlalchemy import delete, or_, select, update

from src.database import Database
from src.database.models import (
    AppSettings,
    BankStatementImport,
    BudgetExpense,
    BudgetExpenseCategory,
    ImportTransaction,
    Liability,
    LiabilityBalanceSnapshot,
    MerchantRule,
    RecurringCandidate,
    SmartImportLedger,
    SmartImportMeta,
    generate_uuid,
)
from src.liabilities import clock
from src.liabilities.service import _as_date

from .errors import SmartImportError
from .settings_store import SETTINGS_KEY, SettingsUpdate, read_settings, sanitize, write_settings

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


def _existing_rows(session: Any, keys: list[str]) -> dict[str, tuple[str, str]]:
    """dedupe_key -> (row id, owning import id) for stored rows with these keys."""
    found: dict[str, tuple[str, str]] = {}
    for chunk in _chunks(keys):
        for key, row_id, import_id in session.execute(
            select(ImportTransaction.dedupe_key, ImportTransaction.id, ImportTransaction.import_id).where(
                ImportTransaction.dedupe_key.in_(chunk)
            )
        ):
            found[key] = (row_id, import_id)
    return found


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


# ------------------------------------------------------------------- apply

SPEND_KINDS = ("expense", "fee", "interest", "refund")  # refunds are positive, so they subtract
ANNUAL_MULTIPLIER = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "annual": 1, "one_time": 0}


def _truncate(value: Optional[str]) -> Optional[str]:
    return None if value is None else value[:MAX_STORED_KEY_CHARS]


def _add_ledger(
    session: Any,
    import_id: str,
    action: str,
    target_table: str,
    target_id: str,
    before: Optional[dict[str, Any]],
    after: Optional[dict[str, Any]],
) -> None:
    """One ledger row: what an import created, linked or moved, so Undo is exact."""
    session.add(
        SmartImportLedger(
            import_id=import_id,
            action=action,
            target_table=target_table,
            target_id=target_id,
            before_json=None if before is None else json.dumps(before, sort_keys=True),
            after_json=None if after is None else json.dumps(after, sort_keys=True),
        )
    )


def _months_ago(today: date, months: int) -> date:
    """The same day ``months`` calendar months back, clamped to the month's last day."""
    index = today.year * 12 + (today.month - 1) - months
    year, month = divmod(index, 12)
    month += 1
    return date(year, month, min(today.day, calendar.monthrange(year, month)[1]))


def _prune(session: Any, retention_months: int, today: date) -> int:
    """Delete stored transactions older than the retention, never those of sample imports."""
    if retention_months <= 0:
        return 0
    cutoff = _months_ago(today, retention_months)
    sample_ids = select(SmartImportMeta.import_id).where(SmartImportMeta.origin == "sample")
    result = session.execute(
        delete(ImportTransaction).where(
            ImportTransaction.posted_date < cutoff, ImportTransaction.import_id.not_in(sample_ids)
        )
    )
    return int(result.rowcount or 0)


def _check_references(session: Any, request: dict[str, Any]) -> None:
    """Refuse a request that points at a missing category, expense or debt, before any write."""
    categories = {c.id for c in _categories(session)}
    for rule in request["rules"]:
        if rule.get("category_id") and rule["category_id"] not in categories:
            raise SmartImportError("category_not_found")
    for rec in request["recurring"]:
        if rec["decision"] == "create" and rec["category_id"] not in categories:
            raise SmartImportError("category_not_found")
        if rec["decision"] == "link":
            expense = session.get(BudgetExpense, rec["expense_id"])
            household = expense is not None and expense.entity_id is None
            if (
                expense is None
                or not expense.is_active
                or not (household or expense.entity_id == request.get("entity_id"))
            ):
                raise SmartImportError("expense_not_found")
    for st in request["statements"]:
        liability_id = st.get("liability_id")
        if liability_id and session.get(Liability, liability_id) is None:
            raise SmartImportError("liability_not_found")


def _insert_statement(
    session: Any, st: dict[str, Any], content_hash: str, batch: dict[str, Any], seen_keys: dict[str, tuple[str, str]], now: datetime
) -> dict[str, Any]:
    account = st["account"]
    period = st["period"] or {}
    closing = st["closing_balance"]
    import_row = BankStatementImport(
        entity_id=batch["entity_id"],
        file_name=st["file_name"][:255],
        content_hash=content_hash,
        row_count=0,
        status="applied",
        analyzed_at=now,
    )
    session.add(import_row)
    session.flush()
    import_id = import_row.id
    txs = st["transactions"]
    excluded = sum(1 for t in txs if t["excluded"])
    candidates = [t for t in txs if not t["excluded"]]
    existing = _existing_rows(session, list({t["dedupe_key"] for t in candidates}))
    new = duplicate = 0
    for t in candidates:
        key = t["dedupe_key"]
        owner = existing.get(key) or seen_keys.get(key)
        if owner is not None:
            duplicate += 1
            if owner[1] != import_id:
                # The row stays with its owner, but this import claims it, so Undo of
                # the owner hands the row over instead of deleting it.
                _add_ledger(session, import_id, "claimed", "import_transactions", owner[0], None,
                            {"dedupe_key": key})
            continue
        row_id = generate_uuid()
        seen_keys[key] = (row_id, import_id)
        new += 1
        session.add(
            ImportTransaction(
                id=row_id,
                import_id=import_id,
                entity_id=batch["entity_id"],
                account_key=account["key"],
                posted_date=t["posted_date"],
                amount=t["amount"],
                description=t["description"][:MAX_STORED_KEY_CHARS],
                merchant_key=t["merchant_key"][:MAX_STORED_KEY_CHARS],
                kind=t["kind"],
                category_id=t["category_id"],
                category_source=t["category_source"],
                ai_confidence=t["ai_confidence"],
                external_id=t["external_id"],
                dedupe_key=key,
            )
        )
    import_row.row_count = new
    session.add(
        SmartImportMeta(
            import_id=import_id,
            batch_id=batch["batch_id"],
            origin=st["origin"],
            format=st["format"],
            parser=st["parser"],
            account_kind=account["kind"],
            account_key=account["key"],
            account_label=account["label"],
            account_last4=None if account["last4"] is None else account["last4"][-4:],
            institution=account["institution"],
            period_start=period.get("start"),
            period_end=period.get("end"),
            closing_balance=None if closing is None else closing["amount"],
            closing_balance_date=None if closing is None else closing["as_of"],
            liability_id=st["liability_id"],
            txn_new=new,
            txn_duplicate=duplicate,
            txn_excluded=excluded,
            ai_used=1 if st["ai_used"] else 0,
            ai_provider=st["ai_provider"],
        )
    )
    session.flush()
    return {
        "import_id": import_id,
        "file_hash": st["file_hash"],
        "txn_new": new,
        "txn_duplicate": duplicate,
        "txn_excluded": excluded,
        "balance": "none",
        "_statement": st,
    }


def _upsert_rules(session: Any, rules: list[dict[str, Any]], import_id: str, now: datetime) -> int:
    by_key: dict[str, dict[str, Any]] = {}
    for rule in rules:
        by_key[rule["merchant_key"][:MAX_STORED_KEY_CHARS]] = rule  # the last choice per merchant wins
    for key, rule in by_key.items():
        row = session.query(MerchantRule).filter_by(merchant_key=key).first()
        if row is None:
            row = MerchantRule(merchant_key=key, hits=0)
            session.add(row)
            row.created_at = now
        row.category_id = rule.get("category_id")
        row.kind = rule.get("kind")
        row.hits = (row.hits or 0) + 1
        row.source = rule["source"]
        row.last_import_id = import_id
        row.updated_at = now
    session.flush()
    return len(by_key)


def _apply_recurring(
    session: Any, recurring: list[dict[str, Any]], imports: list[dict[str, Any]], entity_id: Optional[str]
) -> tuple[int, int]:
    """Candidates attach to the import of the file holding the latest occurrence;
    if that file was skipped, to the first import of the batch."""
    first = imports[0]["import_id"]
    by_hash: dict[str, str] = {}
    for imp in imports:
        by_hash.setdefault(imp["file_hash"], imp["import_id"])
    created = linked = 0
    for rec in recurring:
        import_id = by_hash.get(rec["file_hash"], first)
        decision = rec["decision"]
        expense_id: Optional[str] = None
        if decision == "create":
            expense = BudgetExpense(
                entity_id=entity_id,
                category_id=rec["category_id"],
                name=rec["name"],
                amount=rec["amount"],
                frequency=rec["frequency"],
                is_active=True,
            )
            session.add(expense)
            session.flush()
            expense_id = expense.id
            _add_ledger(session, import_id, "created", "budget_expenses", expense_id, None,
                        _expense_state(expense))
            created += 1
        elif decision == "link":
            expense_id = rec["expense_id"]
            _add_ledger(session, import_id, "linked", "budget_expenses", expense_id, None, None)
            linked += 1
        session.add(
            RecurringCandidate(
                import_id=import_id,
                name=rec["name"],
                amount=rec["amount"],
                frequency=rec["frequency"],
                occurrences=rec["occurrences"],
                status="rejected" if decision == "reject" else "accepted",
                created_expense_id=expense_id,
            )
        )
    session.flush()
    return created, linked


def _record_balance(session: Any, imp: dict[str, Any], today: date, now: datetime) -> str:
    """Snapshot a statement's closing balance for its liability (design 7.3).

    Never overwrites: a snapshot already on that day wins. The liability moves
    only when this day is its newest snapshot, as ``record_balance`` does.
    """
    st = imp["_statement"]
    closing = st["closing_balance"]
    liability_id = st["liability_id"]
    if closing is None or not liability_id or closing["amount"] < 0:
        return "none"  # a credit balance never reaches a debt (liabilities require balance >= 0)
    day = _as_date(closing["as_of"])
    if day > today:
        return "skipped_future"
    snapshots = session.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability_id)
    if snapshots.filter_by(snapshot_date=day).first() is not None:
        return "skipped_existing"
    import_id = imp["import_id"]
    snap = LiabilityBalanceSnapshot(
        liability_id=liability_id,
        snapshot_date=day,
        balance=closing["amount"],
        source="import",
        source_ref=import_id,
    )
    session.add(snap)
    session.flush()
    _add_ledger(
        session, import_id, "snapshot", "liability_balance_snapshots", snap.id, None,
        {"liability_id": liability_id, "snapshot_date": day.isoformat(), "balance": closing["amount"]},
    )
    newest = max(_as_date(x.snapshot_date) for x in snapshots)
    if day == newest:
        row = session.get(Liability, liability_id)
        before = {
            "current_balance": row.current_balance,
            "balance_as_of": _iso(row.balance_as_of),
            "updated_at": _iso(row.updated_at),
        }
        row.current_balance = closing["amount"]
        row.balance_as_of = day
        row.updated_at = now
        _add_ledger(
            session, import_id, "balance_moved", "liabilities", liability_id, before,
            {"current_balance": closing["amount"], "balance_as_of": day.isoformat()},
        )
    session.flush()
    return "recorded"


def _retention_months(session: Any) -> int:
    """The profile's retention setting, read inside the apply transaction."""
    row = session.query(AppSettings).filter_by(key=SETTINGS_KEY).first()
    try:
        stored = json.loads(row.value) if row is not None and row.value else None
    except (TypeError, ValueError):
        stored = None
    return int(sanitize(stored)["retention_months"])


def _apply(session: Any, request: dict[str, Any], today: date, now: datetime) -> dict[str, Any]:
    """Rules, recurring candidates, balances and the prune only run when the batch
    created at least one import; with none, every one of them is dropped (rules_saved 0)."""
    _check_references(session, request)
    batch = {"batch_id": request["batch_id"], "entity_id": request.get("entity_id")}
    indexes: dict[str, int] = {}
    seen_keys: dict[str, tuple[str, str]] = {}
    skipped: list[str] = []
    imports: list[dict[str, Any]] = []
    for st in request["statements"]:
        file_hash = st["file_hash"]
        index = indexes.get(file_hash, 0)
        indexes[file_hash] = index + 1
        content_hash = file_hash if index == 0 else f"{file_hash}:{index}"
        known = session.query(BankStatementImport.id).filter_by(content_hash=content_hash).first()
        if known is not None:
            if file_hash not in skipped:
                skipped.append(file_hash)
            continue
        imports.append(_insert_statement(session, st, content_hash, batch, seen_keys, now))
    rules_saved = created = linked = pruned = 0
    if imports:
        first_id = imports[0]["import_id"]
        rules_saved = _upsert_rules(session, request["rules"], first_id, now) if request["rules"] else 0
        created, linked = _apply_recurring(session, request["recurring"], imports, batch["entity_id"])
        for imp in imports:
            imp["balance"] = _record_balance(session, imp, today, now)
        pruned = _prune(session, _retention_months(session), today)
    # A hash whose later statement was new (its earlier statement already stored) is
    # reported in imports only. Built before the commit, so a failure rolls everything back.
    applied_hashes = {imp["file_hash"] for imp in imports}
    return {
        "imports": [{k: v for k, v in imp.items() if k != "_statement"} for imp in imports],
        "skipped_files": [h for h in skipped if h not in applied_hashes],
        "rules_saved": rules_saved,
        "expenses_created": created,
        "expenses_linked": linked,
        "pruned": pruned,
    }


@_guarded("apply", "save_failed")
def apply_import(db: Database, request: dict[str, Any]) -> dict[str, Any]:
    """Apply a reviewed batch in one transaction (design 9). Writes nothing on any failure."""
    today = clock.today()
    now = datetime.utcnow()
    with db.get_session() as session:
        try:
            result = _apply(session, request, today, now)
            session.commit()
        except BaseException:
            session.rollback()
            raise
    logger.info(
        "smart_import_applied imports=%d skipped=%d new=%d duplicates=%d",
        len(result["imports"]),
        len(result["skipped_files"]),
        sum(i["txn_new"] for i in result["imports"]),
        sum(i["txn_duplicate"] for i in result["imports"]),
    )
    return result


# -------------------------------------------------------------------- undo

_EXPENSE_FIELDS = (
    "entity_id", "category_id", "name", "amount", "frequency", "is_pretax", "is_mortgage",
    "principal_portion", "interest_portion", "is_active", "start_date", "end_date", "updated_at",
)


def _expense_state(expense: BudgetExpense) -> dict[str, Any]:
    """Every user-editable column plus updated_at, as stored in the ledger (dates as ISO text)."""
    state: dict[str, Any] = {}
    for field in _EXPENSE_FIELDS:
        value = getattr(expense, field)
        state[field] = value.isoformat() if isinstance(value, (date, datetime)) else value
    return state


def _expense_unchanged(expense: BudgetExpense, after: dict[str, Any]) -> bool:
    """Any difference in a recorded field (updated_at included) means the user edited it."""
    now = _expense_state(expense)
    for field, was in after.items():
        if field not in now:
            continue
        value = now[field]
        if isinstance(value, float) or isinstance(was, float):
            if value is None or was is None or abs(float(value) - float(was)) > 1e-9:
                return False
        elif isinstance(value, bool) or isinstance(was, bool):
            if bool(value) != bool(was):
                return False
        elif value != was:
            return False
    return True


def _restore_liability_balance(
    session: Any, liability_id: str, before: dict[str, Any], now: datetime
) -> None:
    """Set the balance from the newest remaining snapshot, as ``record_balance`` would
    (so a later manual balance wins); with none left, from the ledger's ``before``."""
    row = session.get(Liability, liability_id)
    if row is None:
        return
    snaps = session.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability_id).all()
    if snaps:
        newest = max(snaps, key=lambda x: _as_date(x.snapshot_date))
        balance, day = newest.balance, _as_date(newest.snapshot_date)
    else:
        balance, day = before["current_balance"], date.fromisoformat(before["balance_as_of"])
    if row.current_balance != balance or _as_date(row.balance_as_of) != day:
        row.current_balance = balance
        row.balance_as_of = day
        row.updated_at = now


def _hand_over_claimed_rows(session: Any, import_id: str) -> int:
    """Rows this import owns that a later import claimed as duplicates move to the
    newest claimer (and its counts move with them) instead of being deleted."""
    owned = [row_id for (row_id,) in session.query(ImportTransaction.id).filter_by(import_id=import_id)]
    claims: dict[str, str] = {}  # row id -> newest surviving claimer
    for chunk in _chunks(owned):
        rows = (
            session.query(SmartImportLedger)
            .filter(
                SmartImportLedger.action == "claimed",
                SmartImportLedger.target_id.in_(chunk),
                SmartImportLedger.import_id != import_id,
            )
            .order_by(SmartImportLedger.created_at, SmartImportLedger.id)
            .all()
        )
        for row in rows:
            claims[row.target_id] = row.import_id  # ascending order, so the newest wins
    by_claimer: dict[str, list[str]] = {}
    for row_id, claimer in claims.items():
        by_claimer.setdefault(claimer, []).append(row_id)
    for claimer, ids in by_claimer.items():
        for chunk in _chunks(ids):
            session.execute(update(ImportTransaction).where(ImportTransaction.id.in_(chunk)).values(import_id=claimer))
            session.execute(
                delete(SmartImportLedger).where(
                    SmartImportLedger.action == "claimed",
                    SmartImportLedger.import_id == claimer,
                    SmartImportLedger.target_id.in_(chunk),
                )
            )
        meta = session.get(SmartImportMeta, claimer)
        bsi = session.get(BankStatementImport, claimer)
        if meta is not None:
            meta.txn_new += len(ids)
            meta.txn_duplicate = max(0, meta.txn_duplicate - len(ids))
        if bsi is not None:
            bsi.row_count = (bsi.row_count or 0) + len(ids)
    session.flush()
    return len(claims)


def _undo(session: Any, import_id: str, now: datetime) -> dict[str, Any]:
    if session.get(SmartImportMeta, import_id) is None:
        # A plain statement import row is a legacy import; no row at all means unknown
        # or already undone (Undo deletes the import row; nothing else records it).
        if session.get(BankStatementImport, import_id) is not None:
            raise SmartImportError("not_smart_import")
        raise SmartImportError("import_not_found")
    ledger = (
        session.query(SmartImportLedger)
        .filter_by(import_id=import_id)
        .order_by(SmartImportLedger.created_at, SmartImportLedger.id)
        .all()
    )
    kept: list[dict[str, str]] = []
    deleted = {"transactions": 0, "recurring_candidates": 0, "expenses": 0, "snapshots": 0}
    reassigned = _hand_over_claimed_rows(session, import_id)
    deleted["transactions"] = int(
        session.execute(delete(ImportTransaction).where(ImportTransaction.import_id == import_id)).rowcount or 0
    )
    # Candidates go before any expense: created_expense_id is a declared foreign key.
    deleted["recurring_candidates"] = int(
        session.execute(delete(RecurringCandidate).where(RecurringCandidate.import_id == import_id)).rowcount or 0
    )
    session.flush()
    for row in ledger:
        if row.action != "created" or row.target_table != "budget_expenses":
            continue
        expense = session.get(BudgetExpense, row.target_id)
        if expense is None:
            continue
        reason = None
        if not _expense_unchanged(expense, json.loads(row.after_json or "{}")):
            reason = "edited"
        elif session.query(Liability).filter(Liability.expense_id == expense.id).first() is not None:
            reason = "linked_to_debt"
        elif (
            session.query(RecurringCandidate)
            .filter(RecurringCandidate.created_expense_id == expense.id, RecurringCandidate.import_id != import_id)
            .first()
            is not None
        ):
            reason = "used_by_other_import"
        if reason:
            kept.append({"table": "budget_expenses", "id": expense.id, "reason": reason})
        else:
            session.delete(expense)
            deleted["expenses"] += 1
    for row in ledger:
        if row.action != "snapshot":
            continue
        snap = session.get(LiabilityBalanceSnapshot, row.target_id)
        if snap is None:
            continue
        after = json.loads(row.after_json or "{}")
        untouched = (
            snap.source == "import"
            and snap.source_ref == import_id
            and abs(snap.balance - float(after.get("balance", 0))) < 1e-9
            and _iso(snap.snapshot_date) == after.get("snapshot_date")
        )
        if untouched:
            session.delete(snap)
            deleted["snapshots"] += 1
        else:
            kept.append({"table": "liability_balance_snapshots", "id": snap.id, "reason": "edited"})
    session.flush()
    for row in ledger:
        if row.action == "balance_moved":
            _restore_liability_balance(session, row.target_id, json.loads(row.before_json or "{}"), now)
    session.execute(delete(SmartImportLedger).where(SmartImportLedger.import_id == import_id))
    session.execute(delete(SmartImportMeta).where(SmartImportMeta.import_id == import_id))
    session.execute(delete(BankStatementImport).where(BankStatementImport.id == import_id))
    return {"undone": True, "deleted": deleted, "reassigned": {"transactions": reassigned}, "kept": kept}


@_guarded("undo", "save_failed")
def undo_import(db: Database, import_id: str) -> dict[str, Any]:
    """Remove exactly what one import created and restore what it moved (design 9).

    Anything the user changed since is kept and listed, never overwritten.
    """
    now = datetime.utcnow()
    with db.get_session() as session:
        try:
            result = _undo(session, import_id, now)
            session.commit()
        except BaseException:
            session.rollback()
            raise
    logger.info("smart_import_undone id=%s", import_id)
    return result


@_guarded("delete_transactions", "save_failed")
def delete_transactions(db: Database) -> dict[str, Any]:
    """Delete every stored transaction detail. Imports, expenses, rules and snapshots stay."""
    with db.get_session() as session:
        try:
            count = int(session.execute(delete(ImportTransaction)).rowcount or 0)
            result = {"deleted": count}
            session.commit()
        except BaseException:
            session.rollback()
            raise
    logger.info("smart_import_transactions_deleted count=%d", count)
    return result


# --------------------------------------------------------- spending summary


def _month_keys(start: date, end: date) -> Iterable[str]:
    year, month = start.year, start.month
    for _ in range(1200):
        if (year, month) > (end.year, end.month):
            return
        yield f"{year:04d}-{month:02d}"
        year, month = (year, month + 1) if month < 12 else (year + 1, 1)


def _covered_months(session: Any, entity_id: Optional[str]) -> set[str]:
    """Months with statement coverage. An import covers a month only while it still
    stores a transaction in it (so a delete-all or a prune removes the coverage); with
    a period, only months the period overlaps count."""
    query = session.query(SmartImportMeta).join(
        BankStatementImport, BankStatementImport.id == SmartImportMeta.import_id
    )
    if entity_id:
        query = query.filter(BankStatementImport.entity_id == entity_id)
    periods: dict[str, Optional[set[str]]] = {}
    for meta in query.all():
        start, end = _as_date(meta.period_start), _as_date(meta.period_end)
        periods[meta.import_id] = set(_month_keys(start, end)) if start and end else None
    covered: set[str] = set()
    for chunk in _chunks(list(periods)):
        for import_id, day in session.execute(
            select(ImportTransaction.import_id, ImportTransaction.posted_date)
            .where(ImportTransaction.import_id.in_(chunk))
            .distinct()
        ):
            month = f"{day.year:04d}-{day.month:02d}"
            allowed = periods[import_id]
            if allowed is None or month in allowed:
                covered.add(month)
    return covered


def _planned_monthly(session: Any, entity_id: Optional[str]) -> dict[Optional[str], float]:
    # Same as the Budget expenses list: every active expense counts (its start and end
    # dates are not applied there either), one_time is 0 and an unknown frequency is monthly.
    query = session.query(BudgetExpense).filter(BudgetExpense.is_active.is_(True))
    if entity_id:
        query = query.filter(BudgetExpense.entity_id == entity_id)
    planned: dict[Optional[str], float] = {}
    for e in query.all():
        yearly = float(e.amount) * ANNUAL_MULTIPLIER.get(e.frequency or "", 12)
        planned[e.category_id] = planned.get(e.category_id, 0.0) + yearly / 12
    return planned


@_guarded("spending_summary")
def spending_summary(db: Database, months: int, entity_id: Optional[str]) -> dict[str, Any]:
    """Planned versus actual monthly spending by category (design 7.4)."""
    today = clock.today()
    current = f"{today.year:04d}-{today.month:02d}"
    with db.get_session() as session:
        covered = sorted((m for m in _covered_months(session, entity_id) if m < current), reverse=True)
        selected = sorted(covered[:months])
        names = {c.id: c.name for c in _categories(session)}
        actual: dict[Optional[str], float] = {}
        if selected:
            first = date(int(selected[0][:4]), int(selected[0][5:]), 1)
            query = session.query(
                ImportTransaction.category_id, ImportTransaction.amount, ImportTransaction.posted_date
            ).filter(ImportTransaction.kind.in_(SPEND_KINDS), ImportTransaction.posted_date >= first)
            if entity_id:
                query = query.filter(ImportTransaction.entity_id == entity_id)
            chosen = set(selected)
            for category_id, amount, day in query.all():
                if f"{day.year:04d}-{day.month:02d}" not in chosen:
                    continue
                key = category_id if category_id in names else None  # a deleted category is uncategorized
                actual[key] = actual.get(key, 0.0) - float(amount)
        planned: dict[Optional[str], float] = {}
        for category_id, value in _planned_monthly(session, entity_id).items():
            key = category_id if category_id in names else None
            planned[key] = planned.get(key, 0.0) + value
        divisor = len(selected) or 1
        lines = []
        for key in set(actual) | set(planned):
            a = round(actual.get(key, 0.0) / divisor, 2)
            p = round(planned.get(key, 0.0), 2)
            if key is None and a == 0 and p == 0:
                continue
            lines.append(
                {
                    "category_id": key,
                    "category_name": names[key] if key else "Uncategorized",
                    "actual_monthly": a,
                    "planned_monthly": p,
                    "difference": round(a - p, 2),
                }
            )
        lines.sort(key=lambda x: (x["category_id"] is None, x["category_name"].lower(), x["category_id"] or ""))
        totals_a = round(sum(x["actual_monthly"] for x in lines), 2)
        totals_p = round(sum(x["planned_monthly"] for x in lines), 2)
        return {
            "months_covered": len(selected),
            "months": selected,
            "categories": lines,
            "totals": {
                "actual_monthly": totals_a,
                "planned_monthly": totals_p,
                "difference": round(totals_a - totals_p, 2),
            },
        }
