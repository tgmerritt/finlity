"""Dashboard payload with liabilities, server half of the dashboard parity scenario.

Runs tests/fixtures/dashboard_liabilities_scenario.json through FastAPI against a
temp database and compares the normalized results with
tests/fixtures/dashboard_liabilities_scenario.expected.json. The browser half is
src/web/test/api/dashboard-data-liabilities.test.ts; both must match the same file
(money within 0.01, everything else exact; history dates compared on their first
10 characters because the server serializes datetimes).

Regenerate the expected file from the server path (then review it by hand):
    WRITE_DASHBOARD_PARITY_EXPECTED=1 python -m pytest tests/test_dashboard_liabilities.py
"""

import json
import os
import re
from datetime import date, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event

from src.api.dependencies import get_db
from src.database import Database
from src.database.models import Account, Liability, LiabilityBalanceSnapshot, PortfolioSnapshot, PortfolioView, Position
from src.main import app

FIXTURES = Path(__file__).resolve().parent / "fixtures"
SCENARIO = json.loads((FIXTURES / "dashboard_liabilities_scenario.json").read_text())
EXPECTED_PATH = FIXTURES / "dashboard_liabilities_scenario.expected.json"
ID_KEYS = {"id", "liability_id", "linked_position_id", "expense_id", "position_id"}
EXACT_NUMBER_KEYS = {"interest_rate", "periods_remaining"}
COMMON_FIELDS = {
    "positions": ["id", "ticker", "shares", "value", "position_type", "account"],
    "accounts": ["id", "name", "account_type", "value", "position_count"],
}
WRITE_SQL = re.compile(r"^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b", re.IGNORECASE)


def _fixed_ids() -> set[str]:
    setup = SCENARIO["setup"]
    return {row["id"] for key in ("accounts", "positions", "views") for row in setup[key]}


class Normalizer:
    def __init__(self) -> None:
        self.fixed = _fixed_ids()
        self.seen: dict[str, str] = {}

    def __call__(self, value: Any, key: str = "") -> Any:
        if isinstance(value, dict):
            return {k: self(value[k], k) for k in sorted(value)}
        if isinstance(value, list):
            items = [self(v, key) for v in value]
            if key in COMMON_FIELDS and all(set(COMMON_FIELDS[key]) <= set(i) for i in items):
                # Row order and some extra row fields differ between the paths today and are
                # not part of this task; compare the shared, meaningful fields only.
                items = sorted(({f: i[f] for f in COMMON_FIELDS[key]} for i in items), key=lambda i: i["id"])
            return items
        if key in ("created_at", "updated_at"):
            return "<ts>" if value else None
        if key == "demo_mode":
            return "<env>"  # the server's global demo flag, not part of the payload under test
        if key == "date" and isinstance(value, str):
            return value[:10]
        if key in ID_KEYS and isinstance(value, str):
            if value in self.fixed:
                return value
            return self.seen.setdefault(value, f"<id-{len(self.seen) + 1}>")
        return value


def _seed(db: Database) -> None:
    setup = SCENARIO["setup"]
    with db.get_session() as s:
        for row in setup["accounts"]:
            s.add(Account(**row))
        s.flush()
        for row in setup["positions"]:
            s.add(Position(**row))
        for row in setup["views"]:
            s.add(PortfolioView(id=row["id"], name=row["name"], account_ids=json.dumps(row["account_ids"])))
        for row in setup["snapshots"]:
            s.add(
                PortfolioSnapshot(
                    snapshot_date=datetime.fromisoformat(row["date"]),
                    total_value=row["total"],
                    retirement_value=row["retirement"],
                    taxable_value=row["taxable"],
                )
            )
        s.commit()


def _counts(db: Database) -> dict[str, int]:
    with db.get_session() as s:
        return {
            "liabilities": s.query(Liability).count(),
            "liability_snapshots": s.query(LiabilityBalanceSnapshot).count(),
            "portfolio_snapshots": s.query(PortfolioSnapshot).count(),
            "accounts": s.query(Account).count(),
            "positions": s.query(Position).count(),
        }


@pytest.fixture
def scenario_db(tmp_path, monkeypatch):
    monkeypatch.setattr("src.liabilities.clock.today", lambda: date.fromisoformat(SCENARIO["today"]))
    db = Database(str(tmp_path / "dashboard-parity.db"))
    _seed(db)
    app.dependency_overrides[get_db] = lambda: db
    try:
        yield db
    finally:
        app.dependency_overrides.pop(get_db, None)


def run_scenario(db: Database) -> list[dict[str, Any]]:
    client = TestClient(app, raise_server_exceptions=False)
    norm = Normalizer()
    aliases: dict[str, str] = {}
    results: list[dict[str, Any]] = []
    for step in SCENARIO["steps"]:
        if "probe" in step:
            results.append({"name": step["name"], "ok": _counts(db)})
            continue
        path = re.sub(r"\{(\w+)\}", lambda m: aliases[m.group(1)], step["path"])
        resp = client.request(step["method"], path, json=step.get("body"))
        assert resp.status_code < 400, f"{step['name']}: {resp.status_code}"
        body = resp.json()
        if "save" in step:
            aliases[step["save"]] = body["id"]
        results.append({"name": step["name"], "ok": norm(body)})
    return results


def assert_matches(actual: Any, expected: Any, where: str = "") -> None:
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys(), f"{where}: keys differ"
        for k in expected:
            assert_matches(actual[k], expected[k], f"{where}.{k}")
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected), f"{where}: length differs"
        for i, (a, e) in enumerate(zip(actual, expected)):
            assert_matches(a, e, f"{where}[{i}]")
    elif isinstance(expected, (int, float)) and not isinstance(expected, bool):
        assert isinstance(actual, (int, float)) and not isinstance(actual, bool), f"{where}: type"
        tolerance = 0 if where.rsplit(".", 1)[-1] in EXACT_NUMBER_KEYS else 0.01
        assert abs(actual - expected) <= tolerance, f"{where}: {actual!r} vs {expected!r}"
    else:
        assert actual == expected, f"{where}: {actual!r} vs {expected!r}"


@pytest.fixture
def results(scenario_db):
    return run_scenario(scenario_db)


def _by_name(results: list[dict[str, Any]], name: str) -> Any:
    return next(r["ok"] for r in results if r["name"] == name)


def test_server_path_matches_expected(results):
    if os.environ.get("WRITE_DASHBOARD_PARITY_EXPECTED"):
        EXPECTED_PATH.write_text(json.dumps(results, indent=2, sort_keys=True) + "\n")
    expected = json.loads(EXPECTED_PATH.read_text())
    assert [r["name"] for r in results] == [e["name"] for e in expected]
    for actual, want in zip(results, expected):
        assert_matches(actual, want, want["name"])


def test_unfiltered_dashboard_includes_net_worth(results):
    data = _by_name(results, "dashboard unfiltered with liabilities")
    summary = data["summary"]
    assert summary["liabilities_included"] is True
    names = [row["name"] for row in summary["liabilities"]]
    assert names == ["Home loan", "Rewards card"], "archived debts are not listed"
    assert summary["liabilities_total"] == pytest.approx(sum(row["balance"] for row in summary["liabilities"]), abs=0.01)
    assert summary["net_worth"] == pytest.approx(summary["total_value"] - summary["liabilities_total"], abs=0.01)
    assert set(summary["liabilities"][0]) == {
        "id", "name", "liability_type", "balance", "interest_rate", "payment_amount", "payment_frequency",
        "payoff_date", "linked_position_id", "entity_id", "is_amortizing", "last_reported_date",
    }
    for item in data["history"]:
        assert item["net_worth"] == pytest.approx(item["total"] - item["liabilities"], abs=0.01)
    last = data["history"][-1]
    assert last["date"].startswith("2026-10-04")
    assert last["liabilities"] == pytest.approx(summary["liabilities_total"], abs=0.01)
    first = data["history"][0]
    assert first["liabilities"] > last["liabilities"], "archived loan still counts before it closed"


def test_total_value_is_unchanged_by_liabilities(results):
    before = _by_name(results, "dashboard with no liabilities")["summary"]["total_value"]
    after = _by_name(results, "dashboard unfiltered with liabilities")["summary"]["total_value"]
    assert before == after


def test_no_liabilities(results):
    data = _by_name(results, "dashboard with no liabilities")
    assert data["summary"]["liabilities_included"] is True
    assert data["summary"]["liabilities_total"] == 0
    assert data["summary"]["liabilities"] == []
    assert data["summary"]["net_worth"] == data["summary"]["total_value"]
    for item in data["history"]:
        assert item["liabilities"] == 0 and item["net_worth"] == item["total"]


def test_filtered_view_gets_no_liability_fields(results):
    data = _by_name(results, "dashboard filtered by view")
    assert data["summary"]["liabilities_included"] is False
    for key in ("liabilities_total", "net_worth", "liabilities"):
        assert key not in data["summary"]
    assert all(set(item) == {"date", "total", "retirement", "taxable"} for item in data["history"])
    assert data["summary"]["position_count"] == 3


def test_empty_and_unknown_views_are_unfiltered(results):
    unfiltered = _by_name(results, "dashboard unfiltered with liabilities")
    for name in ("dashboard with a view that has no accounts", "dashboard with an unknown view"):
        data = _by_name(results, name)
        assert data["summary"]["liabilities_included"] is True
        assert data["summary"]["net_worth"] == unfiltered["summary"]["net_worth"]


def test_duplicates_skip_real_estate(results):
    dup = _by_name(results, "duplicates ignore real estate")
    assert dup["count"] == 1
    assert dup["duplicates"][0]["ticker"] == "VXUS"


def test_dashboard_reads_never_write(scenario_db):
    client = TestClient(app, raise_server_exceptions=False)
    client.post(
        "/api/liabilities",
        json={"name": "Card", "liability_type": "credit_card", "current_balance": 100, "balance_as_of": "2026-10-01", "cash_flow": {"mode": "none"}},
    )
    before = _counts(scenario_db)
    statements: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        statements.append(statement)

    event.listen(scenario_db.engine, "before_cursor_execute", record)
    try:
        for path in ("/api/dashboard/data", "/api/dashboard/data?view_id=view-brokerage", "/api/portfolio/duplicates"):
            assert client.get(path).status_code == 200
    finally:
        event.remove(scenario_db.engine, "before_cursor_execute", record)
    assert statements, "the listener saw the reads"
    assert [s for s in statements if WRITE_SQL.match(s)] == []
    assert _counts(scenario_db) == before


def test_dashboard_survives_a_failing_liabilities_block(scenario_db, monkeypatch, caplog):
    client = TestClient(app, raise_server_exceptions=False)
    created = client.post(
        "/api/liabilities",
        json={"name": "Secret Lender Card", "liability_type": "credit_card", "current_balance": 123456.78, "balance_as_of": "2026-10-01", "cash_flow": {"mode": "none"}},
    )
    assert created.status_code == 201

    def boom(*args, **kwargs):
        raise RuntimeError("balance 123456.78 for Secret Lender Card")

    monkeypatch.setattr("src.main.dashboard_block", boom)
    with caplog.at_level("DEBUG"):
        resp = client.get("/api/dashboard/data")
    assert resp.status_code == 200
    data = resp.json()
    healthy = client.get("/api/dashboard/data?view_id=view-brokerage").json()
    assert data["summary"]["liabilities_included"] is False
    for key in ("liabilities_total", "net_worth", "liabilities"):
        assert key not in data["summary"]
    assert all(set(item) == {"date", "total", "retirement", "taxable"} for item in data["history"])
    assert data["summary"]["total_value"] > 0 and len(data["history"]) == 10
    assert healthy["summary"]["liabilities_included"] is False
    messages = [r.getMessage() for r in caplog.records]
    assert "dashboard liabilities block failed: RuntimeError" in messages
    logged = " ".join(messages) + " ".join(str(r.exc_info) for r in caplog.records if r.exc_info)
    assert "123456" not in logged and "Secret Lender" not in logged
    assert all(r.exc_info is None for r in caplog.records if "liabilities block" in r.getMessage())
