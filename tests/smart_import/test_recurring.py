"""Tests for recurring bill detection. All inputs are synthetic."""

from __future__ import annotations

import ast
import json
from datetime import date
from pathlib import Path

import pytest

from src.smart_import import recurring
from src.smart_import.recurring import detect

FIXTURE = (
    Path(__file__).resolve().parents[1]
    / "fixtures"
    / "smart_import"
    / "recurring_cases.json"
)
EM_DASH = chr(0x2014)
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))
KEYS = {
    "merchant_key",
    "name",
    "amount",
    "frequency",
    "occurrences",
    "last_date",
    "category_id",
    "already_budgeted",
    "matched_expense_id",
}


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_detect_cases(case: dict) -> None:
    got = detect(case["rows"], case["history"], case["expenses"], case["categories"])
    expect = case["expect"]
    assert len(got) == len(expect), got
    for cand, want in zip(got, expect):
        assert set(cand) == KEYS
        for field, value in want.items():
            assert cand[field] == value, (field, cand)


def test_inputs_are_not_mutated() -> None:
    case = next(c for c in CASES if c["name"].startswith("history rows count"))
    snapshot = json.dumps(case, sort_keys=True)
    detect(case["rows"], case["history"], case["expenses"], case["categories"])
    assert json.dumps(case, sort_keys=True) == snapshot


def test_accepts_date_objects_and_ignores_malformed_rows() -> None:
    rows = [
        {"merchant_key": "A", "posted_date": date(2026, 1, 5), "amount": -10.0},
        {"merchant_key": "A", "posted_date": "2026-02-05", "amount": -10.0},
        {"merchant_key": "A", "posted_date": "2026-03-05", "amount": -10.0},
        {"merchant_key": "A", "posted_date": "not a date", "amount": -10.0},
        {"merchant_key": "A", "posted_date": "2026-03-06", "amount": "x"},
        {"merchant_key": "A", "posted_date": "2026-03-07", "amount": float("nan")},
        {"merchant_key": "", "posted_date": "2026-03-05", "amount": -10.0},
        {"posted_date": "2026-03-05", "amount": -10.0},
    ]
    got = detect(rows, [], [], [])
    assert [(c["merchant_key"], c["occurrences"]) for c in got] == [("A", 3)]


def test_rows_without_kind_count_as_outflows_by_sign() -> None:
    rows = [
        {"merchant_key": "A", "posted_date": f"2026-0{m}-05", "amount": -10.0}
        for m in (1, 2, 3)
    ]
    assert len(detect(rows, [], [], [])) == 1


def test_amount_is_median_of_absolute_amounts_rounded() -> None:
    rows = [
        {"merchant_key": "A", "posted_date": f"2026-0{m}-05", "amount": a}
        for m, a in ((1, -10.0), (2, -10.4), (3, -10.123))
    ]
    assert detect(rows, [], [], [])[0]["amount"] == 10.12


def test_module_source_is_clean() -> None:
    src = Path(recurring.__file__).read_text(encoding="utf-8")
    assert EM_DASH not in src
    imported: set[str] = set()
    for node in ast.walk(ast.parse(src)):
        if isinstance(node, ast.Import):
            imported |= {a.name.split(".")[0] for a in node.names}
        elif isinstance(node, ast.ImportFrom) and node.module:
            imported.add(node.module.split(".")[0])
    assert not imported & {"logging", "sqlalchemy", "requests", "subprocess"}


def test_fixture_has_no_em_dash() -> None:
    assert EM_DASH not in FIXTURE.read_text(encoding="utf-8")


# ---- spacing, dates, budgeting and history edge cases ----

from datetime import datetime, timedelta  # noqa: E402


def _series(gaps: list[int], amount: float = -20.0, key: str = "A", start: str = "2026-01-01") -> list[dict]:
    d = date.fromisoformat(start)
    days = [d]
    for g in gaps:
        d += timedelta(days=g)
        days.append(d)
    return [
        {"merchant_key": key, "posted_date": x.isoformat(), "amount": amount, "description": key}
        for x in days
    ]


@pytest.mark.parametrize(
    "gaps,frequency,occurrences",
    [
        ([7, 7, 7], "weekly", 4),
        ([6, 8, 7], "weekly", 4),
        ([14, 14], "biweekly", 3),
        ([28, 31], "monthly", 3),
        ([30], "monthly", 2),
        ([91, 90], "quarterly", 3),
        ([365, 365], "annual", 3),
    ],
)
def test_regular_spacing_qualifies(gaps: list[int], frequency: str, occurrences: int) -> None:
    got = detect(_series(gaps), [], [], [])
    assert [(c["frequency"], c["occurrences"]) for c in got] == [(frequency, occurrences)]


@pytest.mark.parametrize(
    "gaps",
    [
        [1, 1],  # three consecutive days
        [2, 2],  # Mon/Wed/Fri
        [0, 0],  # three charges on one day
        [0, 30],
        [3, 40],
        [5, 5, 5],  # median below the weekly range
        [7, 21, 7],  # skipped period
        [30, 60],  # skipped period
        [10, 10],  # between weekly and biweekly
        [50, 50],  # between monthly and quarterly
        [365],  # annual needs three occurrences
    ],
)
def test_irregular_or_out_of_range_spacing_is_not_recurring(gaps: list[int]) -> None:
    assert detect(_series(gaps), [], [], []) == []


def test_bimodal_amounts_give_no_candidate() -> None:
    rows = [
        {"merchant_key": "A", "posted_date": f"2026-0{m}-05", "amount": a}
        for m, a in ((1, -10.0), (2, -10.0), (3, -50.0), (4, -50.0))
    ]
    assert detect(rows, [], [], []) == []


def test_mixed_date_datetime_and_string_values() -> None:
    rows = _series([30, 30])
    rows[0]["posted_date"] = datetime(2026, 1, 1, 13, 30)
    rows[1]["posted_date"] = date(2026, 1, 31)
    got = detect(rows, [], [], [])
    assert [(c["frequency"], c["last_date"]) for c in got] == [("monthly", "2026-03-02")]


def test_same_day_rows_in_batch_and_history_are_not_recurring() -> None:
    day = "2026-03-04"
    row = {"merchant_key": "A", "posted_date": day, "amount": -20.0}
    assert detect([row, dict(row)], [dict(row), dict(row)], [], []) == []
    assert detect([row, dict(row)], [dict(row)], [], []) == []


def test_history_refund_is_ignored() -> None:
    rows = _series([30])
    hist = [{"merchant_key": "A", "posted_date": "2025-12-02", "amount": -20.0, "kind": "refund"}]
    assert len(detect(rows, hist, [], [])) == 1
    only = detect(rows[:1], hist, [], [])
    assert only == []


def _cat_rows() -> list[dict]:
    rows = _series([30, 30], amount=-50.0, key="K")
    for r in rows:
        r["category_id"] = "c-ent"
    return rows


def test_budget_match_compares_monthly_equivalents() -> None:
    cats = [{"id": "c-ent", "name": "Entertainment"}]
    annual = {"id": "e1", "name": "Other", "amount": 52.0, "frequency": "annual", "category_id": "c-ent"}
    assert detect(_cat_rows(), [], [annual], cats)[0]["already_budgeted"] is False
    yearly_600 = dict(annual, amount=600.0)  # 50 a month
    got = detect(_cat_rows(), [], [yearly_600], cats)[0]
    assert (got["already_budgeted"], got["matched_expense_id"]) == (True, "e1")


def test_budget_match_picks_closest_then_lowest_id() -> None:
    cats = [{"id": "c-ent", "name": "Entertainment"}]

    def exp(i: str, amount: float) -> dict:
        return {"id": i, "name": f"x{i}", "amount": amount, "frequency": "monthly", "category_id": "c-ent"}

    got = detect(_cat_rows(), [], [exp("a", 46.0), exp("b", 52.0)], cats)[0]
    assert got["matched_expense_id"] == "b"
    got = detect(_cat_rows(), [], [exp("z", 50.0), exp("m", 50.0)], cats)[0]
    assert got["matched_expense_id"] == "m"


# --- cost at the request caps ----------------------------------------------


def _cap_inputs(groups: int, n_expenses: int, n_categories: int):
    rows, history = [], []
    for g in range(groups):
        base = {
            "merchant_key": f"M{g}",
            "amount": -10.0 - g % 50,
            "description": f"M{g}",
            "category_id": "c0",
            "kind": "expense",
        }
        rows.append(dict(base, posted_date="2026-03-01"))
        history.append(dict(base, posted_date="2026-01-30"))
    # Every expense shares the candidates' category and none matches by name or
    # amount, so each group looks at the whole category: the old worst case.
    expenses = [
        {
            "id": f"e{i}",
            "name": f"exp{i}",
            "amount": 100_000.0 + i,
            "frequency": "monthly",
            "category_id": "c0",
        }
        for i in range(n_expenses)
    ]
    categories = [{"id": f"c{i}", "name": f"C{i}"} for i in range(n_categories)]
    return rows, history, expenses, categories


def test_detect_at_the_request_caps_is_fast() -> None:
    import time

    from src.api.v2.smart_import import MAX_LIST_ITEMS, MAX_RECURRING_REFERENCE_ITEMS

    args = _cap_inputs(
        MAX_LIST_ITEMS, MAX_RECURRING_REFERENCE_ITEMS, MAX_RECURRING_REFERENCE_ITEMS
    )
    start = time.perf_counter()
    got = detect(*args)
    elapsed = time.perf_counter() - start
    assert len(got) == MAX_LIST_ITEMS
    assert not any(c["already_budgeted"] for c in got)
    assert elapsed < 1.0, elapsed


def test_budget_match_by_amount_uses_nearest_on_either_side() -> None:
    cats = [{"id": "c-ent", "name": "Entertainment"}]

    def exp(i: str, amount: float, freq: str = "monthly") -> dict:
        return {"id": i, "name": f"x{i}", "amount": amount, "frequency": freq, "category_id": "c-ent"}

    # 50 a month: 44 is out of tolerance, 54 is in.
    got = detect(_cat_rows(), [], [exp("a", 44.0), exp("b", 54.0), exp("c", 90.0)], cats)[0]
    assert got["matched_expense_id"] == "b"
    # Equal distance on both sides: the lower id wins.
    got = detect(_cat_rows(), [], [exp("q", 48.0), exp("p", 52.0)], cats)[0]
    assert got["matched_expense_id"] == "p"
    # Inactive, id-less and non-numeric expenses never match.
    bad = [
        dict(exp("a", 50.0), is_active=False),
        dict(exp("b", 50.0), id=None),
        exp("c", "50"),  # type: ignore[arg-type]
        exp("d", 50.0, freq="fortnightly"),
    ]
    assert detect(_cat_rows(), [], bad, cats)[0]["matched_expense_id"] is None


def test_budget_match_by_name_picks_lowest_id_across_keys() -> None:
    rows = _series([30, 30], amount=-50.0, key="NETFLIX")
    expenses = [
        {"id": "z", "name": " netflix ", "amount": 1.0},
        {"id": "b", "name": "Netflix", "amount": 1.0, "is_active": False},
        {"id": "m", "name": "NETFLIX", "amount": 1.0},
    ]
    assert detect(rows, [], expenses, [])[0]["matched_expense_id"] == "m"
