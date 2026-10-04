"""Server half of the smart import parity scenario.

Runs tests/fixtures/smart_import_scenario.json through FastAPI against a temp
database and compares the normalized results with
tests/fixtures/smart_import_scenario.expected.json. The browser half is
src/web/test/api/smart-import-parity.test.ts; both must match the same file
(money within 0.01, everything else exact, error_type and detail included).

Regenerate the expected file from the server path (then review it by hand):
    WRITE_SMART_IMPORT_PARITY_EXPECTED=1 python -m pytest tests/api/test_smart_import_parity.py
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
)
from src.main import app

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SCENARIO = json.loads((FIXTURES / "smart_import_scenario.json").read_text())
EXPECTED_PATH = FIXTURES / "smart_import_scenario.expected.json"
ID_KEYS = {
    "id", "import_id", "liability_id", "expense_id", "created_expense_id", "last_import_id", "target_id",
    "source_ref",
}
TIMESTAMP_KEYS = {"created_at", "updated_at", "imported_at", "analyzed_at", "uploaded_at"}


def _fixed_ids() -> set[str]:
    setup = SCENARIO["setup"]
    fixed = {row["id"] for key in ("categories", "liabilities", "snapshots", "expenses") for row in setup[key]}
    return fixed | {step["id"] for step in SCENARIO["steps"] if step.get("db") == "insert_legacy_import"}


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


def _day(value: Any) -> Any:
    return value.isoformat()[:10] if isinstance(value, (date, datetime)) else value


def _seed(db: Database) -> None:
    setup = SCENARIO["setup"]
    with db.get_session() as s:
        for row in setup["categories"]:
            s.add(BudgetExpenseCategory(**row))
        for row in setup["liabilities"]:
            s.add(Liability(**{**row, "balance_as_of": date.fromisoformat(row["balance_as_of"]), "is_amortizing": False}))
        s.flush()
        for row in setup["snapshots"]:
            s.add(LiabilityBalanceSnapshot(**{**row, "snapshot_date": date.fromisoformat(row["snapshot_date"])}))
        for row in setup["expenses"]:
            s.add(BudgetExpense(**row))
        s.commit()


def _probe(db: Database, kind: str) -> Any:
    with db.get_session() as s:
        if kind == "counts":
            tables = {
                "bank_statement_imports": BankStatementImport,
                "smart_import_meta": SmartImportMeta,
                "import_transactions": ImportTransaction,
                "merchant_rules": MerchantRule,
                "smart_import_ledger": SmartImportLedger,
                "recurring_candidates": RecurringCandidate,
                "budget_expenses": BudgetExpense,
                "liabilities": Liability,
                "liability_balance_snapshots": LiabilityBalanceSnapshot,
            }
            out: dict[str, Any] = {name: s.query(model).count() for name, model in tables.items()}
            out["smart_import_settings_rows"] = s.query(AppSettings).filter_by(key="smart_import").count()
            return out
        if kind == "imports_raw":
            rows = [
                {"content_hash": r.content_hash, "file_name": r.file_name, "row_count": r.row_count, "status": r.status}
                for r in s.query(BankStatementImport)
            ]
            return sorted(rows, key=lambda r: r["content_hash"])
        if kind == "transactions":
            rows = [
                {
                    "import_id": t.import_id, "account_key": t.account_key, "posted_date": _day(t.posted_date),
                    "amount": t.amount, "description": t.description, "merchant_key": t.merchant_key,
                    "kind": t.kind, "category_id": t.category_id, "category_source": t.category_source,
                    "dedupe_key": t.dedupe_key,
                }
                for t in s.query(ImportTransaction)
            ]
            return sorted(rows, key=lambda r: r["dedupe_key"])
        if kind == "rules":
            rows = [
                {
                    "merchant_key": r.merchant_key, "category_id": r.category_id, "kind": r.kind, "hits": r.hits,
                    "source": r.source, "last_import_id": r.last_import_id,
                    "has_updated_at": r.updated_at is not None,
                    "updated_since_created": r.updated_at != r.created_at,
                }
                for r in s.query(MerchantRule)
            ]
            return sorted(rows, key=lambda r: r["merchant_key"])
        if kind == "expenses":
            rows = [
                {"id": e.id, "name": e.name, "amount": e.amount, "frequency": e.frequency,
                 "category_id": e.category_id, "entity_id": e.entity_id, "is_active": bool(e.is_active)}
                for e in s.query(BudgetExpense)
            ]
            return sorted(rows, key=lambda r: (r["name"], r["amount"]))
        if kind == "candidates":
            rows = [
                {"import_id": c.import_id, "name": c.name, "amount": c.amount, "frequency": c.frequency,
                 "occurrences": c.occurrences, "status": c.status, "created_expense_id": c.created_expense_id}
                for c in s.query(RecurringCandidate)
            ]
            return sorted(rows, key=lambda r: (r["name"], r["status"]))
        if kind == "liabilities":
            out_rows = []
            for liability in sorted(s.query(Liability), key=lambda x: x.id):
                snaps = s.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability.id)
                out_rows.append({
                    "id": liability.id,
                    "current_balance": liability.current_balance,
                    "balance_as_of": _day(liability.balance_as_of),
                    "snapshots": sorted(
                        ({"snapshot_date": _day(x.snapshot_date), "balance": x.balance, "source": x.source,
                          "source_ref": x.source_ref} for x in snaps),
                        key=lambda r: r["snapshot_date"],
                    ),
                })
            return out_rows
        if kind == "ledger":
            counts: dict[str, int] = {}
            for (action,) in s.query(SmartImportLedger.action):
                counts[action] = counts.get(action, 0) + 1
            return counts
        raise AssertionError(kind)


def _db_op(db: Database, step: dict) -> None:
    op = step["db"]
    with db.get_session() as s:
        if op == "edit_expense":
            s.query(BudgetExpense).filter_by(name=step["expense_name"]).one().amount = step["amount"]
        elif op == "insert_legacy_import":
            s.add(BankStatementImport(
                id=step["id"], content_hash=step["content_hash"], file_name=step["file_name"], row_count=3,
                status="analyzed", uploaded_at=datetime(2026, 1, 15, 9, 30), analyzed_at=datetime(2026, 1, 15, 9, 31),
            ))
        else:
            raise AssertionError(op)
        s.commit()


def _pick(body: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        body = body[int(part)] if isinstance(body, list) else body[part]
    return body


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
    monkeypatch.setenv("PORTFOLIO_TEST_MODE", "true")
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
            if "body" in step:
                resp = client.request(step["method"], path, json=_substitute(step["body"], aliases))
            else:
                resp = client.request(step["method"], path)
            body = resp.json()
            if resp.status_code >= 400:
                results.append({
                    "name": step["name"], "error": resp.status_code,
                    "error_type": body.get("error_type"), "detail": body.get("detail"),
                })
                continue
            for alias, dotted in step.get("save", {}).items():
                aliases[alias] = _pick(body, dotted)
            results.append({"name": step["name"], "ok": norm(body)})
    finally:
        app.dependency_overrides.pop(get_db, None)
    return results


def assert_matches(actual: Any, expected: Any, where: str = "") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), (
            f"{where}: keys differ {sorted(actual) if isinstance(actual, dict) else actual} vs {sorted(expected)}"
        )
        for k in expected:
            assert_matches(actual[k], expected[k], f"{where}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f"{where}: length differs"
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_matches(a, e, f"{where}[{i}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), f"{where}: {actual!r} vs {expected!r}"
        assert abs(actual - expected) <= 0.01, f"{where}: {actual!r} vs {expected!r}"
    else:
        assert actual == expected, f"{where}: {actual!r} vs {expected!r}"


def test_server_path_matches_expected(tmp_path, monkeypatch):
    results = run_scenario(tmp_path, monkeypatch)
    if os.environ.get("WRITE_SMART_IMPORT_PARITY_EXPECTED"):
        EXPECTED_PATH.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n")
    expected = json.loads(EXPECTED_PATH.read_text())
    assert [r["name"] for r in results] == [e["name"] for e in expected]
    for actual, want in zip(results, expected):
        assert_matches(actual, want, want["name"])
