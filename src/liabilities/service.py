"""Liabilities service: pure functions over a Database session.

Logging rule: never log balances, payments, names or lenders. Only ids and
exception types appear in log records.
"""

import logging
from contextlib import contextmanager
from datetime import date, datetime, timedelta
from typing import Any, Iterator, Optional

from src.database import Database
from src.database.models import (
    Account,
    BudgetExpense,
    BudgetExpenseCategory,
    Entity,
    Liability,
    LiabilityBalanceSnapshot,
    Position,
)
from src.liabilities import clock
from src.liabilities.amortization import (
    PERIODS_PER_YEAR,
    month_ends,
    shift,
    balance_at,
    due_dates_between,
    schedule,
    summarize,
)

logger = logging.getLogger(__name__)

AMORTIZING_BY_TYPE = {
    "mortgage": True,
    "auto_loan": True,
    "student_loan": True,
    "credit_card": False,
    "personal_loan": True,
    "heloc": False,
    "other": False,
}
CATEGORY_BY_TYPE = {"mortgage": "Housing", "heloc": "Housing", "auto_loan": "Transportation"}
DEFAULT_CATEGORY = "Debt Payments"
FALLBACK_CATEGORY = "Other"
SAVE_FAILED = "Could not save the liability"
CALENDAR_DATE_FIELDS = ("balance_as_of", "next_payment_date", "origination_date", "maturity_date", "closed_date")
# Changing any of these re-syncs the linked expense (design D6).
SYNC_FIELDS = ("payment_amount", "escrow_amount", "payment_frequency")
MAX_SERIES_POINTS = 600
_UNSET: Any = object()


class LiabilityError(Exception):
    """A request problem with an HTTP-style status and a fixed, safe message."""

    def __init__(self, status_code: int, message: str):
        super().__init__(message)
        self.status_code = status_code
        self.message = message


def _not_found() -> LiabilityError:
    return LiabilityError(404, "Liability not found")


@contextmanager
def _write(session: Any, operation: str, liability_id: Optional[str] = None) -> Iterator[None]:
    """Roll back on any failure; unexpected errors become a fixed 500.

    The original exception is suppressed (`from None`) so SQLAlchemy errors, which
    carry bound parameters (balances, names), never reach a log or a traceback.
    """
    try:
        yield
    except LiabilityError:
        session.rollback()
        raise
    except Exception as exc:
        session.rollback()
        logger.error("Liability %s failed id=%s: %s", operation, liability_id, type(exc).__name__)
        raise LiabilityError(500, SAVE_FAILED) from None


def _default_amortizing(liability_type: str, term_months: Optional[int]) -> bool:
    return AMORTIZING_BY_TYPE[liability_type] or (liability_type == "other" and bool(term_months))


def _check_not_future(day: date, today: date) -> None:
    if day > today:
        raise LiabilityError(422, "Date cannot be in the future")


def _check_expense_free(session: Any, expense_id: str, liability_id: Optional[str]) -> BudgetExpense:
    """The expense must exist (404) and not be linked to a different liability (409)."""
    expense = session.get(BudgetExpense, expense_id)
    if expense is None:
        raise LiabilityError(404, "Expense not found")
    query = session.query(Liability).filter(Liability.expense_id == expense_id)
    if liability_id:
        query = query.filter(Liability.id != liability_id)
    if query.first() is not None:
        raise LiabilityError(409, "Expense is already linked to another liability")
    return expense


def _as_date(value: Any) -> Optional[date]:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.date()
    return value


def _iso(value: Any) -> Optional[str]:
    d = _as_date(value)
    return d.isoformat() if d else None


def _money(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(float(value), 2)


def _monthly(amount: Optional[float], frequency: Optional[str]) -> float:
    ppy = PERIODS_PER_YEAR.get(frequency or "")
    if not amount or not ppy:
        return 0.0
    return float(amount) * ppy / 12


def _liability_dict(row: Liability) -> dict[str, Any]:
    """Plain-dict view of a row, in the shape balance_at and summarize expect."""
    return {
        "liability_type": row.liability_type,
        "is_amortizing": bool(row.is_amortizing),
        "interest_rate": row.interest_rate,
        "payment_amount": row.payment_amount,
        "payment_frequency": row.payment_frequency or "monthly",
        "next_payment_date": _as_date(row.next_payment_date),
        "origination_date": _as_date(row.origination_date),
        "closed_date": _as_date(row.closed_date),
    }


def _snapshot_dicts(session: Any, liability_id: str) -> list[dict[str, Any]]:
    rows = session.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability_id).all()
    return [{"snapshot_date": _as_date(r.snapshot_date), "balance": r.balance, "source": r.source} for r in rows]


def _first_due_after(anchor: Optional[date], frequency: str, today: date) -> date:
    """The next due date after today (anchor plus whole periods); today's next period if no anchor."""
    base = anchor or today
    return due_dates_between(base, frequency, today, today + timedelta(days=400))[0]


def _payment_summary(balance: float, row: Any, today: date) -> dict[str, Any]:
    apr = row.interest_rate or 0.0
    freq = row.payment_frequency or "monthly"
    if balance <= 0 or not row.payment_amount or row.payment_amount <= 0:
        return {"payoff_date": None, "periods_remaining": None, "total_interest_remaining": None, "never_pays_off": False}
    first_due = _first_due_after(_as_date(row.next_payment_date), freq, today)
    return summarize(balance, apr, row.payment_amount, freq, first_due)


def _maturity(row: Any) -> Optional[date]:
    stored = _as_date(row.maturity_date)
    if stored:
        return stored
    origination = _as_date(row.origination_date)
    if origination and row.term_months:
        return shift(origination, "monthly", int(row.term_months))
    return None


def _serialize(session: Any, row: Liability, today: date) -> dict[str, Any]:
    snaps = _snapshot_dicts(session, row.id)
    estimated = balance_at(_liability_dict(row), snaps, today)
    summary = _payment_summary(estimated, row, today)
    escrow_monthly = _monthly(row.escrow_amount, row.payment_frequency)
    monthly_payment = _monthly(row.payment_amount, row.payment_frequency)

    position = session.get(Position, row.linked_position_id) if row.linked_position_id else None
    expense = session.get(BudgetExpense, row.expense_id) if row.expense_id else None
    linked_position = None
    if position is not None:
        linked_position = {"id": position.id, "name": position.name, "value": _money(position.market_value)}
    linked_expense = None
    if expense is not None:
        linked_expense = {
            "id": expense.id,
            "name": expense.name,
            "monthly_amount": _money(_monthly(expense.amount, expense.frequency)),
        }
    last_reported = max((s["snapshot_date"] for s in snaps), default=None)
    return {
        "id": row.id,
        "entity_id": row.entity_id,
        "name": row.name,
        "liability_type": row.liability_type,
        "lender": row.lender,
        "current_balance": row.current_balance,
        "balance_as_of": _iso(row.balance_as_of),
        "interest_rate": row.interest_rate,
        "payment_amount": row.payment_amount,
        "payment_frequency": row.payment_frequency,
        "next_payment_date": _iso(row.next_payment_date),
        "escrow_amount": row.escrow_amount,
        "original_principal": row.original_principal,
        "origination_date": _iso(row.origination_date),
        "term_months": row.term_months,
        "maturity_date": _iso(_maturity(row)),
        "credit_limit": row.credit_limit,
        "is_amortizing": bool(row.is_amortizing),
        "linked_position_id": row.linked_position_id if position is not None else None,
        "expense_id": row.expense_id if expense is not None else None,
        "source": row.source,
        "source_ref": row.source_ref,
        "is_active": bool(row.is_active),
        "closed_date": _iso(row.closed_date),
        "notes": row.notes,
        "created_at": row.created_at.isoformat() if row.created_at else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
        "estimated_balance": _money(estimated),
        "payoff_date": _iso(summary["payoff_date"]),
        "periods_remaining": summary["periods_remaining"],
        "total_interest_remaining": _money(summary["total_interest_remaining"]),
        "monthly_payment": _money(monthly_payment),
        "monthly_cash_flow": _money(monthly_payment + escrow_monthly),
        "linked_position": linked_position,
        "linked_position_missing": bool(row.linked_position_id) and position is None,
        "expense": linked_expense,
        "expense_missing": bool(row.expense_id) and expense is None,
        "last_reported_date": _iso(last_reported),
    }


# ---------------------------------------------------------------------------
# Expense helpers (design D6)
# ---------------------------------------------------------------------------


def _pick_category(session: Any, liability_type: str, explicit: Optional[str]) -> str:
    if explicit:
        if session.get(BudgetExpenseCategory, explicit) is None:
            raise LiabilityError(404, "Expense category not found")
        return explicit
    wanted = CATEGORY_BY_TYPE.get(liability_type, DEFAULT_CATEGORY)
    for name in (wanted, FALLBACK_CATEGORY):
        found = session.query(BudgetExpenseCategory).filter_by(name=name).first()
        if found:
            return found.id
    any_category = session.query(BudgetExpenseCategory).order_by(BudgetExpenseCategory.sort_order).first()
    if any_category:
        return any_category.id
    raise LiabilityError(422, "No expense category exists")


def _mortgage_split(row: Liability, balance: float, today: date) -> Optional[tuple[float, float]]:
    """Monthly (principal, interest) of the next payment, or None when there is no schedule."""
    if not row.payment_amount or balance <= 0:
        return None
    freq = row.payment_frequency or "monthly"
    first_due = _first_due_after(_as_date(row.next_payment_date), freq, today)
    rows = schedule(balance, row.interest_rate or 0.0, row.payment_amount, freq, first_due)
    if not rows:
        return None
    factor = PERIODS_PER_YEAR[freq] / 12
    return rows[0]["principal"] * factor, rows[0]["interest"] * factor


def apply_expense_values(session: Any, expense: BudgetExpense, row: Liability, today: date, *, set_amount: bool) -> None:
    snaps = _snapshot_dicts(session, row.id)
    balance = balance_at(_liability_dict(row), snaps, today)
    if set_amount:
        flow = _monthly(row.payment_amount, row.payment_frequency) + _monthly(row.escrow_amount, row.payment_frequency)
        expense.amount = round(flow, 2)
        expense.frequency = "monthly"
        summary = _payment_summary(balance, row, today)
        payoff = summary["payoff_date"]
        # Server end_date is a datetime; the browser path stores 'YYYY-MM-DD'. Readers must take [:10].
        expense.end_date = datetime.combine(payoff, datetime.min.time()) if payoff else None
    if row.liability_type == "mortgage":
        split = _mortgage_split(row, balance, today)
        expense.is_mortgage = True
        if split:
            expense.principal_portion = round(split[0], 2)
            expense.interest_portion = round(split[1], 2)


def _create_expense(session: Any, row: Liability, category_id: Optional[str], today: date) -> BudgetExpense:
    if not row.payment_amount:
        raise LiabilityError(422, "A payment amount is required to create an expense")
    entity_id = row.entity_id if row.entity_id and session.get(Entity, row.entity_id) else None
    expense = BudgetExpense(
        entity_id=entity_id,
        category_id=_pick_category(session, row.liability_type, category_id),
        name=row.name,
        amount=0.0,
        frequency="monthly",
        is_active=True,
    )
    session.add(expense)
    apply_expense_values(session, expense, row, today, set_amount=True)
    session.flush()
    return expense


# ---------------------------------------------------------------------------
# Property helper
# ---------------------------------------------------------------------------


def _property_account(session: Any) -> Account:
    account = session.query(Account).filter_by(account_type="property").order_by(Account.created_at).first()
    if account is None:
        account = Account(name="Real estate", account_type="property", entity_id=None)
        session.add(account)
        session.flush()
    return account


def _apply_property(session: Any, prop: dict[str, Any]) -> str:
    if prop["mode"] == "link":
        if session.get(Position, prop["position_id"]) is None:
            raise LiabilityError(404, "Position not found")
        return str(prop["position_id"])
    account = _property_account(session)
    purchase = prop.get("purchase_date")
    position = Position(
        account_id=account.id,
        ticker="RE",
        name=prop["name"],
        shares=1.0,
        current_price=prop["value"],
        cost_basis=prop.get("cost_basis"),
        position_type="real_estate",
        asset_class="alternative",
        purchase_date=datetime.combine(purchase, datetime.min.time()) if purchase else None,
    )
    session.add(position)
    session.flush()
    return str(position.id)


# ---------------------------------------------------------------------------
# Public operations
# ---------------------------------------------------------------------------


def list_liabilities(
    db: Database, entity_id: Optional[str] = None, include_archived: bool = False
) -> list[dict[str, Any]]:
    today = clock.today()
    with db.get_session() as session:
        query = session.query(Liability)
        if entity_id:
            query = query.filter(Liability.entity_id == entity_id)
        if not include_archived:
            query = query.filter(Liability.is_active.is_(True))
        rows = query.order_by(Liability.name, Liability.id).all()
        return [_serialize(session, r, today) for r in rows]


def get_liability(db: Database, liability_id: str) -> dict[str, Any]:
    today = clock.today()
    with db.get_session() as session:
        row = session.get(Liability, liability_id)
        if row is None:
            raise _not_found()
        return _serialize(session, row, today)


def create_liability(db: Database, data: dict[str, Any]) -> dict[str, Any]:
    """Create the liability, its first snapshot and the optional property and expense, atomically."""
    today = clock.today()
    data = dict(data)
    prop = data.pop("property", None)
    cash_flow = data.pop("cash_flow", None)
    data["balance_as_of"] = data.get("balance_as_of") or today
    _check_not_future(data["balance_as_of"], today)
    if data.get("is_amortizing") is None:
        data["is_amortizing"] = _default_amortizing(data["liability_type"], data.get("term_months"))
    with db.get_session() as session, _write(session, "create"):
        row = Liability(**data)
        if prop:
            row.linked_position_id = _apply_property(session, prop)
        session.add(row)
        session.flush()
        session.add(
            LiabilityBalanceSnapshot(
                liability_id=row.id, snapshot_date=row.balance_as_of, balance=row.current_balance, source=row.source
            )
        )
        session.flush()
        if cash_flow and cash_flow["mode"] == "create":
            row.expense_id = _create_expense(session, row, cash_flow.get("category_id"), today).id
        elif cash_flow and cash_flow["mode"] == "link":
            expense = _check_expense_free(session, cash_flow["expense_id"], None)
            row.expense_id = expense.id
            if row.liability_type == "mortgage":
                apply_expense_values(session, expense, row, today, set_amount=False)
        session.commit()
        logger.info("Liability created id=%s", row.id)
        return _serialize(session, row, today)


def update_liability(db: Database, liability_id: str, changes: dict[str, Any], sync_expense: bool = True) -> dict[str, Any]:
    today = clock.today()
    with db.get_session() as session:
        row = session.get(Liability, liability_id)
        if row is None:
            raise _not_found()
        with _write(session, "update", liability_id):
            changes = dict(changes)
            archive = changes.pop("is_active", None)
            relink = changes.pop("expense_id") if "expense_id" in changes else _UNSET
            sync_needed = any(f in changes and changes[f] != getattr(row, f) for f in SYNC_FIELDS)
            if changes.get("linked_position_id") and session.get(Position, changes["linked_position_id"]) is None:
                raise LiabilityError(404, "Position not found")
            new_expense = None
            if relink is not _UNSET and relink is not None:
                new_expense = _check_expense_free(session, relink, liability_id)
            if "liability_type" in changes and "is_amortizing" not in changes:
                term = changes.get("term_months", row.term_months)
                changes["is_amortizing"] = _default_amortizing(changes["liability_type"], term)
            for key, value in changes.items():
                setattr(row, key, value)
            if relink is not _UNSET:
                row.expense_id = relink
            if archive is False and row.is_active:
                row.is_active = False
                row.closed_date = row.closed_date or today
            elif archive is True and not row.is_active:
                row.is_active = True
                row.closed_date = None
            row.updated_at = datetime.utcnow()
            session.flush()
            if new_expense is not None:
                if row.liability_type == "mortgage":
                    apply_expense_values(session, new_expense, row, today, set_amount=False)
            elif sync_expense and sync_needed and row.expense_id and relink is _UNSET:
                expense = session.get(BudgetExpense, row.expense_id)
                if expense is not None:
                    if not row.payment_amount or row.payment_amount <= 0:
                        raise LiabilityError(422, "A payment amount is required to sync the linked expense")
                    apply_expense_values(session, expense, row, today, set_amount=True)
            session.commit()
            logger.info("Liability updated id=%s", liability_id)
            return _serialize(session, row, today)


def delete_liability(db: Database, liability_id: str, delete_expense: bool = False) -> dict[str, Any]:
    with db.get_session() as session:
        row = session.get(Liability, liability_id)
        if row is None:
            raise _not_found()
        with _write(session, "delete", liability_id):
            expense_deleted = False
            if delete_expense and row.expense_id:
                expense = session.get(BudgetExpense, row.expense_id)
                if expense is not None:
                    session.delete(expense)
                    expense_deleted = True
            session.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability_id).delete()
            session.delete(row)
            session.commit()
            logger.info("Liability deleted id=%s", liability_id)
            return {"deleted": True, "id": liability_id, "expense_deleted": expense_deleted}


def record_balance(
    db: Database, liability_id: str, balance: float, as_of: Optional[date] = None, source: str = "manual"
) -> dict[str, Any]:
    today = clock.today()
    day = as_of or today
    _check_not_future(day, today)
    with db.get_session() as session:
        row = session.get(Liability, liability_id)
        if row is None:
            raise _not_found()
        with _write(session, "balance", liability_id):
            snap = session.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability_id, snapshot_date=day).first()
            if snap is None:
                session.add(LiabilityBalanceSnapshot(liability_id=liability_id, snapshot_date=day, balance=balance, source=source))
            else:
                snap.balance = balance
                snap.source = source
            session.flush()
            newest = max(_as_date(s.snapshot_date) for s in session.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability_id))
            if day == newest:
                row.current_balance = balance
                row.balance_as_of = day
                row.updated_at = datetime.utcnow()
            session.commit()
            logger.info("Liability balance recorded id=%s", liability_id)
            return _serialize(session, row, today)


def get_history(db: Database, liability_id: str) -> dict[str, Any]:
    today = clock.today()
    with db.get_session() as session:
        row = session.get(Liability, liability_id)
        if row is None:
            raise _not_found()
        snaps = sorted(_snapshot_dicts(session, liability_id), key=lambda s: s["snapshot_date"])
        reported = [
            {"date": s["snapshot_date"].isoformat(), "balance": _money(s["balance"]), "source": s["source"]} for s in snaps
        ]
        base = _liability_dict(row)
        dates = month_ends(snaps[0]["snapshot_date"], today - timedelta(days=1), MAX_SERIES_POINTS) if snaps else []
        dates.append(today)
        series = [{"date": d.isoformat(), "balance": _money(balance_at(base, snaps, d))} for d in dates]
        return {"liability_id": liability_id, "reported": reported, "series": series}


# ---------------------------------------------------------------------------
# Dashboard payload (design section 4, decision D7). Read only.
# ---------------------------------------------------------------------------


def dashboard_block(db: Database, filtered: bool, history_dates: list[str]) -> dict[str, Any]:
    """Liabilities part of /api/dashboard/data.

    Returns {"summary": {...}, "history": {date: total owed}}. Filtered responses
    (a view that narrows the accounts) carry only liabilities_included=False: debts
    are household-wide, not tied to accounts. Archived debts count in history until
    their closed_date (balance_at handles it) but are not listed or totalled today.
    Never writes.
    """
    if filtered:
        return {"summary": {"liabilities_included": False}, "history": {}}
    today = clock.today()
    with db.get_session() as session:
        rows = session.query(Liability).order_by(Liability.name, Liability.id).all()
        snapshots: dict[str, list[dict[str, Any]]] = {row.id: [] for row in rows}
        for snap in session.query(LiabilityBalanceSnapshot).all():
            if snap.liability_id in snapshots:
                snapshots[snap.liability_id].append(
                    {"snapshot_date": _as_date(snap.snapshot_date), "balance": snap.balance, "source": snap.source}
                )
        linked_ids = [r.linked_position_id for r in rows if r.linked_position_id]
        existing_positions = (
            {pid for (pid,) in session.query(Position.id).filter(Position.id.in_(linked_ids))} if linked_ids else set()
        )
        for snaps in snapshots.values():
            snaps.sort(key=lambda s: s["snapshot_date"])
        entries = []
        total = 0.0
        for row in rows:
            if not row.is_active:
                continue
            snaps = snapshots[row.id]
            balance = balance_at(_liability_dict(row), snaps, today)
            summary = _payment_summary(balance, row, today)
            total += balance
            entries.append(
                {
                    "id": row.id,
                    "name": row.name,
                    "liability_type": row.liability_type,
                    "balance": _money(balance),
                    "interest_rate": row.interest_rate,
                    "payment_amount": row.payment_amount,
                    "payment_frequency": row.payment_frequency,
                    "payoff_date": _iso(summary["payoff_date"]),
                    "linked_position_id": row.linked_position_id if row.linked_position_id in existing_positions else None,
                    "entity_id": row.entity_id,
                    "is_amortizing": bool(row.is_amortizing),
                    "last_reported_date": _iso(max((s["snapshot_date"] for s in snaps), default=None)),
                }
            )
        history: dict[str, float] = {}
        prepared = [(_liability_dict(row), snapshots[row.id]) for row in rows]
        for text in history_dates:
            day = date.fromisoformat(text[:10])
            history[text] = round(sum(balance_at(liability, snaps, day) for liability, snaps in prepared), 2)
    return {
        "summary": {
            "liabilities_included": True,
            "liabilities_total": round(total, 2),
            "liabilities": entries,
        },
        "history": history,
    }
