"""Independent generator for tests/fixtures/amortization_cases.json.
Uses closed-form annuity math and calendar-based date logic; imports nothing from the app."""

import calendar
import json
import math
from datetime import date, timedelta

PPY = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "annual": 1}


def annuity(B, apr, n, f):
    r = apr / PPY[f]
    return B / n if r == 0 else B * r / (1 - (1 + r) ** (-n))


def bal_after(B, apr, p, k, f):
    r = apr / PPY[f]
    v = B - k * p if r == 0 else B * (1 + r) ** k - p * ((1 + r) ** k - 1) / r
    return max(v, 0.0)


def ppo(B, apr, p, f):
    if B <= 0:
        return 0
    r = apr / PPY[f]
    if p <= 0:
        return None
    if r == 0:
        n = math.ceil(B / p - 1e-9)
    else:
        if p <= r * B:
            return None
        n = math.ceil(-math.log(1 - r * B / p) / math.log(1 + r) - 1e-9)
    return n if n <= 600 else None


def shift(d, f, k):
    if f in ("weekly", "biweekly"):
        return d + timedelta(days=(7 if f == "weekly" else 14) * k)
    m = {"monthly": 1, "quarterly": 3, "annual": 12}[f] * k
    idx = d.year * 12 + (d.month - 1) + m
    y, mo = divmod(idx, 12)
    mo += 1
    return date(y, mo, min(d.day, calendar.monthrange(y, mo)[1]))


def dues(nxt, f, lo, hi):
    out = sorted({shift(nxt, f, k) for k in range(-1500, 1500)})
    return [d for d in out if lo < d <= hi]


def sched(B, apr, p, f, first):
    r = apr / PPY[f]
    rows = []
    bal = B
    i = 0
    while bal > 1e-9 and len(rows) < 600:
        it = bal * r
        if p >= bal + it - 1e-9:
            pay, pr = bal + it, bal
            nb = 0.0
        else:
            pay, pr = p, p - it
            nb = bal - pr
        rows.append(
            {
                "date": shift(first, f, i).isoformat(),
                "payment": pay,
                "interest": it,
                "principal": pr,
                "balance": nb,
            }
        )
        bal = nb
        i += 1
    return rows


def sched_expect(rows):
    e = {
        "length": len(rows),
        "first": rows[0],
        "last": rows[-1],
        "total_interest": sum(r["interest"] for r in rows),
        "total_payments": sum(r["payment"] for r in rows),
    }
    if len(rows) <= 12:
        e["rows"] = rows
    return e


def D(s):
    return date.fromisoformat(s)


cases = {}

# annuity
a = []
for name, B, apr, n, f in [
    ("30y mortgage", 520000, 0.0625, 360, "monthly"),
    ("zero apr", 12000, 0, 24, "monthly"),
    ("student loan", 40000, 0.055, 120, "monthly"),
    ("biweekly", 250000, 0.05, 780, "biweekly"),
    ("weekly", 10000, 0.08, 104, "weekly"),
    ("quarterly", 80000, 0.06, 20, "quarterly"),
    ("annual", 50000, 0.04, 10, "annual"),
]:
    a.append(
        {
            "name": name,
            "balance": B,
            "apr": apr,
            "n_periods": n,
            "frequency": f,
            "expected": annuity(B, apr, n, f),
        }
    )
assert abs(a[0]["expected"] - 3201.73) < 0.005, a[0]
cases["annuity_payment"] = a

# balance_after
b = []
mp = 3201.73
for name, B, apr, p, k, f in [
    ("k zero", 520000, 0.0625, mp, 0, "monthly"),
    ("mortgage 12", 520000, 0.0625, mp, 12, "monthly"),
    ("mortgage 120", 520000, 0.0625, mp, 120, "monthly"),
    ("mortgage 360", 520000, 0.0625, mp, 360, "monthly"),
    ("floored past payoff", 520000, 0.0625, mp, 400, "monthly"),
    ("zero apr", 1200, 0, 100, 5, "monthly"),
    ("zero apr floored", 1200, 0, 100, 20, "monthly"),
    ("biweekly", 250000, 0.05, 1400, 26, "biweekly"),
    ("quarterly", 80000, 0.06, 5000, 8, "quarterly"),
    ("payment below interest grows", 10000, 0.12, 50, 12, "monthly"),
]:
    b.append(
        {
            "name": name,
            "balance": B,
            "apr": apr,
            "payment": p,
            "k": k,
            "frequency": f,
            "expected": bal_after(B, apr, p, k, f),
        }
    )
cases["balance_after"] = b

# periods_to_payoff
c = []
for name, B, apr, p, f in [
    ("mortgage", 520000, 0.0625, mp, "monthly"),
    ("zero apr exact", 1000, 0, 100, "monthly"),
    ("zero apr remainder", 1050, 0, 100, "monthly"),
    ("never: payment equals interest", 120000, 0.06, 600, "monthly"),
    ("never: payment below interest", 120000, 0.06, 400, "monthly"),
    ("one period", 500, 0.12, 1000, "monthly"),
    ("zero balance", 0, 0.07, 100, "monthly"),
    ("biweekly", 250000, 0.05, 1400, "biweekly"),
    ("weekly", 5000, 0.09, 150, "weekly"),
    ("quarterly", 80000, 0.06, 5000, "quarterly"),
    ("annual", 50000, 0.04, 7000, "annual"),
    ("beyond 600 cap", 1000000, 0.05, 4170, "monthly"),
    ("zero payment", 1000, 0.05, 0, "monthly"),
]:
    c.append(
        {
            "name": name,
            "balance": B,
            "apr": apr,
            "payment": p,
            "frequency": f,
            "expected": ppo(B, apr, p, f),
        }
    )
assert c[0]["expected"] == 360, c[0]
cases["periods_to_payoff"] = c

# due dates
d = []


def dd(name, nxt, f, lo, hi):
    d.append(
        {
            "name": name,
            "next_payment_date": nxt,
            "frequency": f,
            "start_exclusive": lo,
            "end_inclusive": hi,
            "expected": [x.isoformat() for x in dues(D(nxt), f, D(lo), D(hi))],
        }
    )


dd(
    "jan31 monthly through feb 2026",
    "2026-01-31",
    "monthly",
    "2026-01-31",
    "2026-05-31",
)
dd(
    "jan31 monthly through leap feb 2028",
    "2028-01-31",
    "monthly",
    "2028-01-01",
    "2028-04-30",
)
dd(
    "anchor after range, walk backward",
    "2026-12-31",
    "monthly",
    "2026-01-15",
    "2026-05-31",
)
dd("anchor day 30 clamps february", "2026-04-30", "monthly", "2026-01-01", "2026-04-29")
dd("start exclusive end inclusive", "2026-03-15", "monthly", "2026-03-15", "2026-05-15")
dd("empty range", "2026-03-15", "monthly", "2026-03-16", "2026-04-14")
dd("weekly", "2026-01-02", "weekly", "2025-12-20", "2026-01-30")
dd("biweekly backward", "2026-06-12", "biweekly", "2026-03-01", "2026-04-30")
dd("quarterly", "2026-01-31", "quarterly", "2025-12-31", "2026-12-31")
dd("annual leap day", "2028-02-29", "annual", "2027-12-31", "2030-12-31")
dd("end before start", "2026-03-15", "monthly", "2026-06-01", "2026-05-01")
cases["due_dates_between"] = d

# schedule
s = []


def sc(name, B, apr, p, f, first):
    rows = sched(B, apr, p, f, D(first))
    s.append(
        {
            "name": name,
            "balance": B,
            "apr": apr,
            "payment": p,
            "frequency": f,
            "first_due": first,
            "expected": sched_expect(rows),
        }
    )


sc("short final payment", 1000, 0.12, 300, "monthly", "2026-01-31")
sc("zero apr", 1000, 0, 400, "monthly", "2026-03-01")
sc("biweekly small", 600, 0.26, 210, "biweekly", "2026-02-06")
sc("mortgage 30y", 520000, 0.0625, mp, "monthly", "2026-11-01")
sc("never pays off hits cap", 10000, 0.12, 50, "monthly", "2026-01-15")
sc("single payment", 100, 0.12, 500, "monthly", "2026-02-10")
cases["schedule"] = s

# summarize
m = []


def sm(name, B, apr, p, f, first):
    rows = sched(B, apr, p, f, D(first))
    n = ppo(B, apr, p, f)
    e = (
        {
            "payoff_date": None,
            "periods_remaining": None,
            "total_interest_remaining": None,
            "never_pays_off": True,
        }
        if n is None
        else {
            "payoff_date": rows[-1]["date"],
            "periods_remaining": len(rows),
            "total_interest_remaining": sum(r["interest"] for r in rows),
            "never_pays_off": False,
        }
    )
    if n is not None:
        assert n == len(rows), (name, n, len(rows))
    m.append(
        {
            "name": name,
            "balance": B,
            "apr": apr,
            "payment": p,
            "frequency": f,
            "first_due": first,
            "expected": e,
        }
    )


sm("mortgage", 520000, 0.0625, mp, "monthly", "2026-11-01")
sm("short final payment", 1000, 0.12, 300, "monthly", "2026-01-31")
sm("zero apr", 1000, 0, 400, "monthly", "2026-03-01")
sm("never pays off", 120000, 0.06, 600, "monthly", "2026-01-01")
sm("beyond 600 cap is never", 1000000, 0.05, 4170, "monthly", "2026-01-01")
sm("weekly", 5000, 0.09, 150, "weekly", "2026-01-02")
cases["summarize"] = m

# balance_at
ba = []


def bat(name, liab, snaps, on):
    L = dict(liab)
    r = L.get("interest_rate") or 0.0
    if on and L.get("closed_date") and L["closed_date"] <= on:
        v = 0.0
    elif L.get("origination_date") and L["origination_date"] > on:
        v = 0.0
    else:
        past = [x for x in snaps if x["snapshot_date"] <= on]
        anc = (
            max(past, key=lambda x: x["snapshot_date"])
            if past
            else min(snaps, key=lambda x: x["snapshot_date"])
        )
        if L["is_amortizing"] and past:
            k = len(
                dues(
                    D(L["next_payment_date"]),
                    L["payment_frequency"],
                    D(anc["snapshot_date"]),
                    D(on),
                )
            )
            v = bal_after(
                anc["balance"], r, L["payment_amount"], k, L["payment_frequency"]
            )
        else:
            v = anc["balance"]
    ba.append(
        {
            "name": name,
            "liability": liab,
            "snapshots": snaps,
            "on_date": on,
            "expected": v,
        }
    )


mort = {
    "is_amortizing": 1,
    "interest_rate": 0.06,
    "payment_amount": 1798.65,
    "payment_frequency": "monthly",
    "next_payment_date": "2026-02-01",
    "origination_date": "2020-01-01",
    "closed_date": None,
}
snaps = [{"snapshot_date": "2026-01-15", "balance": 300000.0}]
bat("before origination", mort, snaps, "2019-12-31")
bat("on origination date", mort, snaps, "2020-01-01")
bat("on closed date", dict(mort, closed_date="2026-09-01"), snaps, "2026-09-01")
bat("after closed date", dict(mort, closed_date="2026-09-01"), snaps, "2027-03-01")
bat(
    "day before closed date still amortizes",
    dict(mort, closed_date="2026-09-01"),
    snaps,
    "2026-08-31",
)
bat("flat back-fill before first snapshot", mort, snaps, "2024-06-01")
bat("on snapshot date", mort, snaps, "2026-01-15")
bat("rolled forward between reports", mort, snaps, "2026-06-20")
bat("due date on query date is counted", mort, snaps, "2026-06-01")
bat("far future roll", mort, snaps, "2030-01-10")
bat(
    "anchor next date far in future",
    dict(mort, next_payment_date="2027-01-01"),
    snaps,
    "2026-06-20",
)
bat(
    "latest snapshot wins",
    mort,
    snaps
    + [
        {"snapshot_date": "2026-04-10", "balance": 296000.0},
        {"snapshot_date": "2026-03-01", "balance": 298000.0},
    ],
    "2026-06-20",
)
bat(
    "snapshot after query date ignored",
    mort,
    snaps + [{"snapshot_date": "2026-09-10", "balance": 290000.0}],
    "2026-06-20",
)
bat("payoff floors at zero", dict(mort, payment_amount=100000.0), snaps, "2026-06-20")
bat(
    "zero apr amortizing",
    dict(mort, interest_rate=0.0, payment_amount=1000.0),
    snaps,
    "2026-06-20",
)
bat(
    "null rate treated as zero",
    dict(mort, interest_rate=None, payment_amount=1000.0),
    snaps,
    "2026-06-20",
)
bat("no origination date", dict(mort, origination_date=None), snaps, "2026-06-20")
card = {
    "is_amortizing": 0,
    "interest_rate": 0.24,
    "payment_amount": 200.0,
    "payment_frequency": "monthly",
    "next_payment_date": "2026-02-10",
    "origination_date": None,
    "closed_date": None,
}
csn = [{"snapshot_date": "2026-01-15", "balance": 4200.0}]
bat("revolving stays flat", card, csn, "2026-08-20")
bat("revolving flat back-fill", card, csn, "2025-01-01")
bat(
    "revolving latest snapshot",
    card,
    csn + [{"snapshot_date": "2026-05-01", "balance": 3900.0}],
    "2026-08-20",
)
bat("revolving after closed", dict(card, closed_date="2026-07-01"), csn, "2026-08-20")
cases["balance_at"] = ba

if __name__ == "__main__":
    json.dump(
        cases,
        open(
            str(
                __import__("pathlib").Path(__file__).resolve().parents[1]
                / "tests"
                / "fixtures"
                / "amortization_cases.json"
            ),
            "w",
        ),
        indent=1,
    )
    print({k: len(v) for k, v in cases.items()}, a[0]["expected"])
