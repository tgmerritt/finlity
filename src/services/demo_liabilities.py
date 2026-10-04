"""Demo liabilities: the fixed rows, their reported-balance history, and the guarded builder.

The tracked demo database carries a home and three debts. Reported balances are
month-end snapshots that always end at the last month-end before yesterday, so
`ensure_recent_demo_history` can re-date them at startup exactly as it re-dates
portfolio history. Every write here is limited to the demo database.
"""
from __future__ import annotations

import calendar
import logging
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Optional

from sqlalchemy import func

from src.database.models import (
    Account,
    BudgetExpense,
    Entity,
    Liability,
    LiabilityBalanceSnapshot,
    Position,
)
from src.liabilities import clock
from src.liabilities.amortization import annuity_payment, balance_after, due_dates_between, month_ends

logger = logging.getLogger(__name__)

SNAPSHOT_MONTHS = 12
PROPERTY_ACCOUNT_ID = "demo-property"
HOME_POSITION_ID = "demo-home"

# Card balances oldest to newest; the card is paid down and re-used, so it wanders.
_CARD_BALANCES = (2640.0, 3115.0, 2280.0, 3870.0, 2925.0, 4210.0, 3340.0, 2470.0, 3605.0, 2810.0, 3290.0, 2755.0)

DEMO_LIABILITIES: list[dict[str, Any]] = [
    {
        "id": "demo-mortgage",
        "entity_id": "household-demo",
        "name": "Mortgage",
        "liability_type": "mortgage",
        "lender": "Rocket Mortgage",
        "interest_rate": 0.0625,
        "payment_amount": round(annuity_payment(520000.0, 0.0625, 360, "monthly"), 2),
        "payment_frequency": "monthly",
        "next_payment_date": date(2022, 8, 1),  # fixed anchor; due dates are this day each month
        "original_principal": 520000.0,
        "origination_date": date(2022, 7, 1),
        "term_months": 360,
        "credit_limit": None,
        "is_amortizing": True,
        "linked_position_id": HOME_POSITION_ID,
        "expense_name": "Mortgage",
    },
    {
        "id": "demo-auto",
        "entity_id": "jane-demo",
        "name": "Auto loan",
        "liability_type": "auto_loan",
        "lender": "Toyota Financial",
        "interest_rate": 0.049,
        "payment_amount": 450.0,
        "payment_frequency": "monthly",
        "next_payment_date": date(2024, 4, 1),
        "original_principal": 23900.0,
        "origination_date": date(2024, 3, 1),
        "term_months": 60,
        "credit_limit": None,
        "is_amortizing": True,
        "linked_position_id": None,
        "expense_name": "Car Payment #1",
    },
    {
        "id": "demo-card",
        "entity_id": "john-demo",
        "name": "Credit card",
        "liability_type": "credit_card",
        "lender": "Chase Sapphire",
        "interest_rate": 0.2299,
        "payment_amount": None,
        "payment_frequency": "monthly",
        "next_payment_date": None,
        "original_principal": None,
        "origination_date": None,
        "term_months": None,
        "credit_limit": 15000.0,
        "is_amortizing": False,
        "linked_position_id": None,
        "expense_name": None,
    },
]


class DemoBuilderError(Exception):
    """The builder refused or could not complete; nothing was written."""


def _trailing_month_ends(end_date: date, count: int) -> list[date]:
    """`count` month-end dates ending at the last month-end on or before `end_date`."""
    last_day = calendar.monthrange(end_date.year, end_date.month)[1]
    last = end_date if end_date.day == last_day else date(end_date.year, end_date.month, 1) - timedelta(days=1)
    index = last.year * 12 + last.month - 1 - (count - 1)
    return month_ends(date(index // 12, index % 12 + 1, 1), last)


def _installment_balance(spec: dict[str, Any], on: date) -> float:
    paid = len(due_dates_between(spec["next_payment_date"], spec["payment_frequency"], spec["origination_date"], on))
    value = balance_after(
        spec["original_principal"], spec["interest_rate"], spec["payment_amount"], paid, spec["payment_frequency"]
    )
    return round(value, 2)


def demo_liability_snapshots(end_date: date) -> list[dict[str, Any]]:
    """The 36 reported balances (12 month-ends per demo liability); pure and deterministic."""
    days = _trailing_month_ends(end_date, SNAPSHOT_MONTHS)
    rows: list[dict[str, Any]] = []
    for spec in DEMO_LIABILITIES:
        for i, day in enumerate(days):
            balance = _installment_balance(spec, day) if spec["is_amortizing"] else _CARD_BALANCES[i]
            rows.append({"liability_id": spec["id"], "snapshot_date": day, "balance": balance, "source": "demo"})
    return rows


def _replace_snapshots(session: Any, rows: list[dict[str, Any]]) -> None:
    ids = [spec["id"] for spec in DEMO_LIABILITIES]
    session.query(LiabilityBalanceSnapshot).filter(LiabilityBalanceSnapshot.liability_id.in_(ids)).delete(
        synchronize_session=False
    )
    session.flush()
    for row in rows:
        session.add(
            LiabilityBalanceSnapshot(
                id=f"{row['liability_id']}-{row['snapshot_date'].isoformat()}",
                liability_id=row["liability_id"],
                snapshot_date=row["snapshot_date"],
                balance=row["balance"],
                source=row["source"],
            )
        )
    session.flush()
    latest: dict[str, dict[str, Any]] = {}
    for row in rows:
        latest[row["liability_id"]] = row  # rows are in date order per liability
    for liability_id, row in latest.items():
        liability = session.get(Liability, liability_id)
        if liability is not None:
            liability.current_balance = row["balance"]
            liability.balance_as_of = row["snapshot_date"]


def rewrite_demo_liability_history(db: Any, end_date: date) -> int:
    """Re-date the demo liabilities' snapshots and latest balances; 0 unless `db` is the demo database.

    This runs at startup against whatever database is active, so it carries its own
    demo-database guard in addition to its caller's. It only touches liabilities that
    already exist (the builder creates them), and never creates rows for others.
    """
    from src.services.demo_history import _is_demo_database

    if not _is_demo_database(db):
        return 0
    with db.get_session() as session:
        present = {r[0] for r in session.query(Liability.id).filter(Liability.id.in_([s["id"] for s in DEMO_LIABILITIES]), Liability.source == "demo")}
        if not present:
            return 0
        newest = session.query(func.max(LiabilityBalanceSnapshot.snapshot_date)).filter(
            LiabilityBalanceSnapshot.liability_id.in_(present), LiabilityBalanceSnapshot.source == "demo"
        ).scalar()
        if newest is not None and newest >= _trailing_month_ends(end_date, 1)[0]:
            return 0
        rows = [r for r in demo_liability_snapshots(end_date) if r["liability_id"] in present]
        _replace_snapshots(session, rows)
        session.commit()
    return len(rows)


def resolve_demo_target(path: str) -> Path:
    """The path to build into, or DemoBuilderError unless it is exactly the demo database.

    Symlinks are resolved and a symlinked file (either side) is refused outright, so a
    link can never redirect the builder at another database.
    """
    from src.services.demo_mode import get_demo_manager

    given = Path(path)
    demo = Path(get_demo_manager().demo_db_path)
    resolved = given.resolve()
    if given.is_symlink() or demo.is_symlink():
        raise DemoBuilderError("Refusing a symlinked database path")
    if resolved != demo.resolve():
        raise DemoBuilderError("Refusing a path that is not the demo database")
    if not resolved.is_file():
        raise DemoBuilderError("The demo database does not exist")
    return resolved


def _upsert(session: Any, model: Any, key: str, values: dict[str, Any]) -> Any:
    row = session.get(model, key)
    if row is None:
        row = model(id=key)
        session.add(row)
    for name, value in values.items():
        setattr(row, name, value)
    return row


def build_demo_liabilities(db: Any, today: Optional[date] = None) -> None:
    """Upsert the demo home, three debts, their snapshots and the two expense links.

    All-or-nothing: the expenses are looked up first and any miss raises before a write.
    """
    from src.services.demo_history import _is_demo_database

    if not _is_demo_database(db):
        raise DemoBuilderError("Refusing a database that is not the demo database")
    today = today or clock.today()
    from src.liabilities.service import apply_expense_values

    with db.get_session() as session:
        expenses: dict[str, BudgetExpense] = {}
        for spec in DEMO_LIABILITIES:
            name = spec["expense_name"]
            if name is None:
                continue
            matches = session.query(BudgetExpense).filter_by(name=name).all()
            if len(matches) != 1:
                raise DemoBuilderError(f"Expected exactly one demo expense for '{spec['id']}', found {len(matches)}")
            expenses[spec["id"]] = matches[0]

        entities = {e.id for e in session.query(Entity.id)}

        _upsert(
            session,
            Account,
            PROPERTY_ACCOUNT_ID,
            {"name": "Home", "account_type": "property", "entity_id": None, "is_retirement_account": False},
        )
        session.flush()
        _upsert(
            session,
            Position,
            HOME_POSITION_ID,
            {
                "account_id": PROPERTY_ACCOUNT_ID,
                "ticker": "RE",
                "name": "Primary Residence",
                "shares": 1.0,
                "current_price": 685000.0,
                "cost_basis": 650000.0,
                "position_type": "real_estate",
                "asset_class": "alternative",
                "purchase_date": datetime(2022, 6, 15),
            },
        )
        session.flush()

        end = today - timedelta(days=1)
        snapshots = demo_liability_snapshots(end)
        for spec in DEMO_LIABILITIES:
            values = {k: v for k, v in spec.items() if k not in ("id", "expense_name")}
            if values["entity_id"] not in entities:
                values["entity_id"] = None
            last = [r for r in snapshots if r["liability_id"] == spec["id"]][-1]
            values.update(
                current_balance=last["balance"],
                balance_as_of=last["snapshot_date"],
                expense_id=expenses[spec["id"]].id if spec["id"] in expenses else None,
                source="demo",
                is_active=True,
            )
            _upsert(session, Liability, spec["id"], values)
        session.flush()
        _replace_snapshots(session, snapshots)
        session.flush()
        for spec in DEMO_LIABILITIES:
            if spec["id"] in expenses and spec["liability_type"] == "mortgage":
                expense = expenses[spec["id"]]
                apply_expense_values(session, expense, session.get(Liability, spec["id"]), today, set_amount=False)
                expense.amount = spec["payment_amount"]  # demo only: amount matches the split
        session.commit()
