"""Amortization math, driven by the golden file shared with the TypeScript path."""

import json
from datetime import date, datetime
from pathlib import Path

import pytest

from src.liabilities import amortization as am

CASES = json.loads(
    (Path(__file__).parent / "fixtures" / "amortization_cases.json").read_text()
)
TOL = 0.01


def _ids(group):
    return [c["name"] for c in CASES[group]]


def _row_matches(actual, expected):
    assert actual["date"].isoformat() == expected["date"]
    for key in ("payment", "interest", "principal", "balance"):
        assert actual[key] == pytest.approx(expected[key], abs=TOL), key


@pytest.mark.parametrize("c", CASES["annuity_payment"], ids=_ids("annuity_payment"))
def test_annuity_payment(c):
    got = am.annuity_payment(c["balance"], c["apr"], c["n_periods"], c["frequency"])
    assert got == pytest.approx(c["expected"], abs=TOL)


def test_mortgage_payment_matches_published_figure():
    assert round(am.annuity_payment(520000, 0.0625, 360, "monthly"), 2) == 3201.73


@pytest.mark.parametrize("c", CASES["balance_after"], ids=_ids("balance_after"))
def test_balance_after(c):
    got = am.balance_after(c["balance"], c["apr"], c["payment"], c["k"], c["frequency"])
    assert got == pytest.approx(c["expected"], abs=TOL)


@pytest.mark.parametrize("c", CASES["periods_to_payoff"], ids=_ids("periods_to_payoff"))
def test_periods_to_payoff(c):
    got = am.periods_to_payoff(c["balance"], c["apr"], c["payment"], c["frequency"])
    assert got == c["expected"]


@pytest.mark.parametrize("c", CASES["due_dates_between"], ids=_ids("due_dates_between"))
def test_due_dates_between(c):
    got = am.due_dates_between(
        date.fromisoformat(c["next_payment_date"]),
        c["frequency"],
        date.fromisoformat(c["start_exclusive"]),
        date.fromisoformat(c["end_inclusive"]),
    )
    assert [d.isoformat() for d in got] == c["expected"]


@pytest.mark.parametrize("c", CASES["schedule"], ids=_ids("schedule"))
def test_schedule(c):
    rows = am.schedule(
        c["balance"],
        c["apr"],
        c["payment"],
        c["frequency"],
        date.fromisoformat(c["first_due"]),
    )
    e = c["expected"]
    assert len(rows) == e["length"]
    assert len(rows) <= 600
    _row_matches(rows[0], e["first"])
    _row_matches(rows[-1], e["last"])
    assert sum(r["interest"] for r in rows) == pytest.approx(
        e["total_interest"], abs=TOL
    )
    assert sum(r["payment"] for r in rows) == pytest.approx(
        e["total_payments"], abs=TOL
    )
    for got, want in zip(rows, e.get("rows", [])):
        _row_matches(got, want)


@pytest.mark.parametrize("c", CASES["summarize"], ids=_ids("summarize"))
def test_summarize(c):
    got = am.summarize(
        c["balance"],
        c["apr"],
        c["payment"],
        c["frequency"],
        date.fromisoformat(c["first_due"]),
    )
    e = c["expected"]
    assert got["never_pays_off"] is e["never_pays_off"]
    assert got["periods_remaining"] == e["periods_remaining"]
    if e["payoff_date"] is None:
        assert got["payoff_date"] is None
        assert got["total_interest_remaining"] is None
    else:
        assert got["payoff_date"].isoformat() == e["payoff_date"]
        assert got["total_interest_remaining"] == pytest.approx(
            e["total_interest_remaining"], abs=TOL
        )


def _snaps(raw):
    return [
        {
            "snapshot_date": date.fromisoformat(s["snapshot_date"]),
            "balance": s["balance"],
        }
        for s in raw
    ]


def _liab(raw):
    out = dict(raw)
    for key in ("next_payment_date", "origination_date", "closed_date"):
        out[key] = date.fromisoformat(raw[key]) if raw.get(key) else None
    return out


@pytest.mark.parametrize("c", CASES["balance_at"], ids=_ids("balance_at"))
def test_balance_at(c):
    got = am.balance_at(
        _liab(c["liability"]), _snaps(c["snapshots"]), date.fromisoformat(c["on_date"])
    )
    assert got == pytest.approx(c["expected"], abs=TOL)


def test_balance_at_accepts_iso_strings():
    c = next(
        x for x in CASES["balance_at"] if x["name"] == "rolled forward between reports"
    )
    got = am.balance_at(c["liability"], c["snapshots"], c["on_date"])
    assert got == pytest.approx(c["expected"], abs=TOL)


def test_periods_per_year():
    assert [
        am.periods_per_year(f)
        for f in ("weekly", "biweekly", "monthly", "quarterly", "annual")
    ] == [52, 26, 12, 4, 1]
    with pytest.raises(ValueError):
        am.periods_per_year("daily")


def test_balance_at_accepts_datetimes():
    c = next(
        x for x in CASES["balance_at"] if x["name"] == "rolled forward between reports"
    )
    liab = _liab(c["liability"])
    for key in ("next_payment_date", "origination_date"):
        liab[key] = datetime.combine(liab[key], datetime.min.time())
    snaps = [
        {
            "snapshot_date": datetime.fromisoformat(s["snapshot_date"] + "T13:45:00"),
            "balance": s["balance"],
        }
        for s in c["snapshots"]
    ]
    on = datetime.fromisoformat(c["on_date"] + "T23:59:59")
    assert am.balance_at(liab, snaps, on) == pytest.approx(c["expected"], abs=TOL)
    liab["closed_date"] = datetime.fromisoformat(c["on_date"] + "T00:00:00")
    assert am.balance_at(liab, snaps, on) == 0.0


def test_unknown_frequency_raises():
    with pytest.raises(ValueError):
        am.annuity_payment(1000, 0.05, 12, "daily")
    with pytest.raises(ValueError):
        am.due_dates_between("2026-01-01", "daily", "2026-01-01", "2026-03-01")
    with pytest.raises(ValueError):
        am.schedule(1000, 0.05, 100, "daily", "2026-01-01")


def test_negative_balance_is_treated_as_paid_off():
    assert am.balance_after(-500, 0.05, 100, 0, "monthly") == 0.0
    assert am.balance_after(-500, 0.05, 100, 3, "monthly") == 0.0
    assert am.periods_to_payoff(-500, 0.05, 100, "monthly") == 0
    assert am.schedule(-500, 0.05, 100, "monthly", "2026-01-01") == []
    s = am.summarize(-500, 0.05, 100, "monthly", "2026-01-01")
    assert s == {
        "payoff_date": None,
        "periods_remaining": 0,
        "total_interest_remaining": 0,
        "never_pays_off": False,
    }


def test_clock_today_is_local_date(monkeypatch):
    import time

    from src.liabilities import clock

    monkeypatch.setenv("TZ", "Pacific/Auckland")
    time.tzset()
    try:
        assert clock.today() == date.today()
        assert isinstance(clock.today(), date) and not isinstance(
            clock.today(), datetime
        )
    finally:
        monkeypatch.undo()
        time.tzset()
