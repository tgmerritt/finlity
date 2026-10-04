"""Server half of the liabilities parity scenario.

Runs tests/fixtures/liabilities_scenario.json through FastAPI against a temp
database and compares the normalized results with
tests/fixtures/liabilities_scenario.expected.json. The browser half is
src/web/test/api/liabilities-parity.test.ts; both must match the same file
(money within 0.01, everything else exact).

Regenerate the expected file from the server path (then review it by hand):
    WRITE_LIABILITIES_PARITY_EXPECTED=1 python -m pytest tests/api/test_liabilities_parity.py
"""

import json
import os
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from src.api.dependencies import get_db
from src.database import Database
from src.database.models import Account, BudgetExpense, BudgetExpenseCategory, Position, PositionLot
from src.main import app

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SCENARIO = json.loads((FIXTURES / "liabilities_scenario.json").read_text())
EXPECTED_PATH = FIXTURES / "liabilities_scenario.expected.json"
ID_KEYS = {"id", "liability_id", "linked_position_id", "expense_id", "position_id", "account_id"}
TIMESTAMP_KEYS = {"created_at", "updated_at"}
EXACT_NUMBER_KEYS = {"interest_rate", "periods_remaining"}


def _fixed_ids() -> set[str]:
    setup = SCENARIO["setup"]
    fixed = {row["id"] for key in ("accounts", "positions", "expenses") for row in setup[key]}
    return fixed | {step["row"]["id"] for step in SCENARIO["steps"] if step.get("db") == "insert"}


class Normalizer:
    """Replaces generated ids with ordered placeholders and timestamps with a marker."""

    def __init__(self) -> None:
        self.fixed = _fixed_ids()
        self.seen: dict[str, str] = {}

    def id(self, value: str) -> str:
        if value in self.fixed:
            return value
        return self.seen.setdefault(value, f"<id-{len(self.seen) + 1}>")

    def __call__(self, value: Any, key: str = "") -> Any:
        if isinstance(value, dict):
            return {k: self(value[k], k) for k in sorted(value)}
        if isinstance(value, list):
            return [self(v, key) for v in value]
        if key in TIMESTAMP_KEYS:
            return "<ts>" if value else None
        if key in ID_KEYS and isinstance(value, str):
            return self.id(value)
        return value


def _seed(db: Database) -> None:
    setup = SCENARIO["setup"]
    with db.get_session() as s:
        for row in setup["categories"]:
            s.add(BudgetExpenseCategory(**row))
        for row in setup["accounts"]:
            s.add(Account(**row))
        s.flush()
        for row in setup["positions"]:
            s.add(Position(**row))
        for row in setup["expenses"]:
            s.add(BudgetExpense(**row))
        s.commit()


def _probe(db: Database, kind: str) -> Any:
    with db.get_session() as s:
        if kind == "counts":
            from src.database.models import Liability, LiabilityBalanceSnapshot

            return {
                "liabilities": s.query(Liability).count(),
                "snapshots": s.query(LiabilityBalanceSnapshot).count(),
                "accounts": s.query(Account).count(),
                "positions": s.query(Position).count(),
                "expenses": s.query(BudgetExpense).count(),
                "categories": s.query(BudgetExpenseCategory).count(),
            }
        if kind == "accounts":
            rows = [{"name": a.name, "account_type": a.account_type, "entity_id": a.entity_id} for a in s.query(Account)]
            return sorted(rows, key=lambda r: r["name"])
        if kind == "positions":
            rows = []
            for p in s.query(Position):
                rows.append(
                    {
                        "account": s.get(Account, p.account_id).name,
                        "name": p.name,
                        "ticker": p.ticker,
                        "shares": p.shares,
                        "current_price": p.current_price,
                        "cost_basis": p.cost_basis,
                        "position_type": str(getattr(p.position_type, "value", p.position_type)),
                        "asset_class": str(getattr(p.asset_class, "value", p.asset_class)),
                        "purchase_date": p.purchase_date.date().isoformat() if p.purchase_date else None,
                    }
                )
            return sorted(rows, key=lambda r: r["name"])
        rows = []
        for e in s.query(BudgetExpense):
            rows.append(
                {
                    "name": e.name,
                    "category": s.get(BudgetExpenseCategory, e.category_id).name,
                    "amount": e.amount,
                    "frequency": e.frequency,
                    "is_mortgage": bool(e.is_mortgage),
                    "principal_portion": e.principal_portion,
                    "interest_portion": e.interest_portion,
                    "end_date": e.end_date.date().isoformat() if e.end_date else None,
                }
            )
        return sorted(rows, key=lambda r: (r["name"], r["amount"]))


def _db_op(db: Database, step: dict) -> None:
    op = step["db"]
    with db.get_session() as s:
        if op == "rename_category":
            s.get(BudgetExpenseCategory, step["id"]).name = step["to"]
        elif op == "delete_position":
            s.delete(s.get(Position, step["id"]))
        elif op == "delete_expense":
            s.delete(s.get(BudgetExpense, step["id"]))
        elif op == "delete_all_expenses":
            s.query(BudgetExpense).delete()
        elif op == "delete_all_categories":
            s.query(BudgetExpenseCategory).delete()
        elif op == "insert":
            models = {
                "accounts": Account,
                "positions": Position,
                "position_lots": PositionLot,
                "budget_expenses": BudgetExpense,
                "budget_expense_categories": BudgetExpenseCategory,
            }
            row = dict(step["row"])
            if step["table"] == "position_lots":
                row["purchase_date"] = datetime.fromisoformat(row["purchase_date"])
            s.add(models[step["table"]](**row))
        elif op == "delete_account":
            s.delete(s.get(Account, step["id"]))
        elif op == "retype_property_accounts":
            for account in s.query(Account).filter_by(account_type="property"):
                account.account_type = "taxable"
        elif op == "set_price":
            s.get(Position, step["id"]).current_price = step["price"]
        else:
            raise AssertionError(op)
        s.commit()


def _substitute(value: Any, aliases: dict[str, str]) -> Any:
    """Replace "{alias}" string values in a request body with saved ids."""
    if isinstance(value, dict):
        return {k: _substitute(v, aliases) for k, v in value.items()}
    if isinstance(value, list):
        return [_substitute(v, aliases) for v in value]
    match = re.fullmatch(r"\{(\w+)\}", value) if isinstance(value, str) else None
    return aliases[match.group(1)] if match else value


def run_scenario(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    monkeypatch.setattr("src.liabilities.clock.today", lambda: date.fromisoformat(SCENARIO["today"]))
    db = Database(str(tmp_path / "parity.db"))
    _seed(db)
    app.dependency_overrides[get_db] = lambda: db
    client = TestClient(app, raise_server_exceptions=False)
    norm = Normalizer()
    aliases: dict[str, str] = {}
    results: list[dict[str, Any]] = []
    try:
        for step in SCENARIO["steps"]:
            if "db" in step:
                _db_op(db, step)
                results.append({"name": step["name"], "ok": "done"})
                continue
            if "probe" in step:
                results.append({"name": step["name"], "ok": norm(_probe(db, step["probe"]))})
                continue
            path = re.sub(r"\{(\w+)\}", lambda m: aliases[m.group(1)], step["path"])
            resp = client.request(step["method"], path, json=_substitute(step.get("body"), aliases))
            if resp.status_code >= 400:
                detail = resp.json().get("detail")
                results.append({"name": step["name"], "error": resp.status_code, "detail": "<validation>" if resp.status_code == 422 else detail})
                continue
            body = resp.json()
            if "save" in step:
                aliases[step["save"]] = body["id"] if "id" in body else body["liability"]["id"]
            if "save_home" in step:
                aliases[step["save_home"]] = body["created"]["position_id"]
            results.append({"name": step["name"], "ok": norm(body)})
    finally:
        app.dependency_overrides.pop(get_db, None)
    return results


def assert_matches(actual: Any, expected: Any, where: str = "") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), f"{where}: keys differ {sorted(actual) if isinstance(actual, dict) else actual} vs {sorted(expected)}"
        for k in expected:
            assert_matches(actual[k], expected[k], f"{where}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f"{where}: length differs"
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_matches(a, e, f"{where}[{i}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), f"{where}: {actual!r} vs {expected!r}"
        tolerance = 0 if where.rsplit(".", 1)[-1] in EXACT_NUMBER_KEYS else 0.01
        assert abs(actual - expected) <= tolerance, f"{where}: {actual!r} vs {expected!r}"
    else:
        assert actual == expected, f"{where}: {actual!r} vs {expected!r}"


def test_server_path_matches_expected(tmp_path, monkeypatch):
    results = run_scenario(tmp_path, monkeypatch)
    if os.environ.get("WRITE_LIABILITIES_PARITY_EXPECTED"):
        EXPECTED_PATH.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n")
    expected = json.loads(EXPECTED_PATH.read_text())
    assert [r["name"] for r in results] == [e["name"] for e in expected]
    for actual, want in zip(results, expected):
        assert_matches(actual, want, want["name"])
