"""Build the shared connection-store fixtures from the server code (plan B5).

Writes two files next to this script, both read by pytest and by vitest:

* ``connections_sanitize_cases.json``: raw ``connections`` rows and what
  ``store.sanitize`` keeps of each, at a pinned ``now``.
* ``connections_plan_cases.json``: one stored connection plus the import
  facts the plan reads (newest synced end and newest posted date per account
  key), and the detail ``service._detail`` returns for it at a pinned
  ``today``: ``next_since`` per account, the windows and the quota fields.

Every case is synthetic. Run from the repository root after a change to the
server rules, then review the diff by hand:

    python tests/fixtures/build_connections_cases.py
"""

from __future__ import annotations

import json
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.connectors import service, store  # noqa: E402

HERE = Path(__file__).resolve().parent
NOW = "2026-10-04T12:00:00Z"
TODAY = "2026-10-04"

U = [f"00000000-0000-4000-8000-{n:012d}" for n in range(1, 13)]
KEY = "acct:" + "a" * 64
KEY_B = "acct:" + "b" * 64
LIAB = "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"
EMOJI = "\U0001f600"
# Unicode digits: Python's regex \\d matches them, fromisoformat does not.
FULLWIDTH_2026 = "\uff12\uff10\uff12\uff16"
FULLWIDTH_5 = "\uff15"


def parse_now(text: str) -> datetime:
    return datetime.fromisoformat(text.replace("Z", "+00:00"))


def conn(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "provider": "demo",
        "label": "Demo",
        "created_at": "2026-10-01T09:00:00Z",
        "status": "ok",
        "status_at": "2026-10-01T09:00:00Z",
        "last_synced_at": None,
        "first_sync_days": 90,
        "requests": [],
        "accounts": {},
    }
    base.update(over)
    return base


def acct(**over: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "name": "Everyday",
        "institution": "Sample Bank",
        "currency": "USD",
        "kind": "checking",
        "role": "cash_flow",
        "label": "Everyday",
        "account_key": KEY,
        "liability_id": None,
        "flip_balance": False,
        "same_as_key": None,
    }
    base.update(over)
    return base


def doc(items: dict[str, Any], **extra: Any) -> str:
    return json.dumps({"version": 1, "items": items, **extra})


# --- sanitize cases ------------------------------------------------------------------


def sanitize_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    def add(name: str, value: str | None, now: str = NOW) -> None:
        cases.append({"name": name, "now": now, "value": value})

    # Plan B3's existence cases, kept as they were.
    exists = json.loads((HERE / "connections_exists_cases.json").read_text(encoding="utf-8"))
    for case in exists["cases"]:
        add("exists: " + case["name"], case["value"])

    add("full entry keeps every known field", doc({U[0]: conn(
        provider="simplefin", label="My bank", status="rate_limited",
        status_at="2026-10-03T08:00:00+02:00", last_synced_at="2026-10-04T11:00:00.5Z",
        first_sync_days=60, requests=["2026-10-04T10:00:00Z"],
        accounts={"acc-1": acct(), "acc-2": acct(
            kind="credit_card", role="debt", account_key=KEY_B, liability_id=LIAB,
            flip_balance=True, same_as_key="label:Main card", institution=None, name="",
        )},
    )}))
    add("unknown keys are dropped at every level", doc(
        {U[0]: {**conn(accounts={"acc-1": {**acct(), "balance": 12.5, "secret": "x"}}),
                "access_url": "https://u:p@bridge.simplefin.org/simplefin", "extra": 1}},
        extra={"x": 1},
    ))
    add("version is always 1", json.dumps({"version": 7, "items": {U[0]: conn()}}))
    add("duplicate id: the last value at the first position", (
        '{"version": 1, "items": {"%s": %s, "%s": %s, "%s": %s}}'
        % (U[0], json.dumps(conn(label="first")), U[1], json.dumps(conn(label="other")),
           U[0], json.dumps(conn(label="last")))
    ))
    add("status_at and last_synced_at fall back", doc({
        U[0]: conn(status_at="yesterday", last_synced_at="2026-13-01T00:00:00Z"),
        U[1]: conn(status_at=None, last_synced_at=12),
        U[2]: {k: v for k, v in conn().items() if k not in ("status_at", "last_synced_at")},
    }))
    add("first_sync_days", doc({
        U[0]: conn(first_sync_days=30), U[1]: conn(first_sync_days=60),
        U[2]: conn(first_sync_days=True), U[3]: conn(first_sync_days=45),
        U[4]: conn(first_sync_days="30"), U[5]: conn(first_sync_days=None),
        U[6]: conn(first_sync_days=30.5), U[7]: conn(first_sync_days=[30]),
        U[8]: {k: v for k, v in conn().items() if k != "first_sync_days"},
    }))
    add("eleven valid connections keep the first ten", doc({u: conn(label=f"C{i}") for i, u in enumerate(U[:11])}))
    mixed: dict[str, Any] = {}
    for i, u in enumerate(U):
        mixed[f"00000000-0000-4000-9000-{i:012d}"] = conn(provider="plaid", label=f"bad entry {i}")
        mixed[u] = conn(label=f"C{i}")
        if i % 3 == 0:
            mixed[f"0000000a-0000-4000-8000-{i:012d}".upper()] = conn(label=f"upper id {i}")
            mixed[f"not-a-uuid-{i}"] = conn(label=f"bad id {i}")
    add("invalid connections among twelve valid ones do not count toward the ten", doc(mixed))

    # Timestamps: year bounds, leap days, leap seconds, fractions, offsets.
    stamps = [
        "0001-01-01T00:00:00Z", "0000-01-01T00:00:00Z", "9999-12-31T23:59:59Z",
        "9999-12-31T23:59:59-01:00", "0001-01-01T00:00:00+01:00", "0004-02-29T00:00:00Z",
        "2024-02-29T00:00:00Z", "2023-02-29T00:00:00Z", "1900-02-29T00:00:00Z",
        "2000-02-29T00:00:00Z", "2026-04-31T00:00:00Z", "2026-00-10T00:00:00Z",
        "2026-10-01T23:59:60Z", "2016-12-31T23:59:60Z", "2026-10-01T09:00:00.1234567Z",
        "2026-10-01T09:00:00.Z", "2026-10-01T09:00:00z", "2026-10-01T09:00:00+0000",
        "2026-10-01T09:00:00+00", "2026-10-01T09:00:00-00:00", "2026-10-01T09:60:00Z",
        "+2026-10-01T09:00:00Z", "2026-10-01T09:00:00Z ",
        FULLWIDTH_2026 + "-10-01T09:00:00Z", "2026-10-01T09:00:00." + FULLWIDTH_5 + "Z",
        "2026-10-01T09:00:00+0" + FULLWIDTH_5 + ":00", "2026-10-01T09:00:00.000000Z",
    ]
    for start in range(0, len(stamps), 9):
        group = stamps[start:start + 9]
        add(
            f"created_at bounds {start // 9 + 1}",
            doc({U[i]: conn(created_at=s) for i, s in enumerate(group)}),
        )
    add("requests: the last 24 hours, by instant", doc({U[0]: conn(requests=[
        "2026-10-04T12:00:00Z",          # exactly now: kept
        "2026-10-03T12:00:00Z",          # exactly 24 h ago: dropped
        "2026-10-03T12:00:00.000001Z",   # just inside: kept
        "2026-10-04T12:00:00.000001Z",   # just after now: dropped
        "2026-10-04T13:30:00+02:00",     # 11:30Z
        "2026-10-04T11:30:00Z",          # same instant, later in the list
        "2026-10-04T11:30:00.5Z",
        "2026-10-04T11:30:00.123456Z",
        "2026-10-04T06:00:00-04:00",     # 10:00Z
        "2026-10-04T11:59:60Z",          # leap second: dropped
        "2026-10-04T12:00:00",           # no offset: dropped
        "2026-10-04 11:00:00Z",          # space: dropped
        1728043200, None, ["2026-10-04T11:00:00Z"], {"at": "2026-10-04T11:00:00Z"},
        "2026-10-04T11:00:00Z",          # duplicate of nothing yet: kept
        "2026-10-04T11:00:00Z",          # a repeat is kept too
        "2026-10-04T05:00:00-07:00",     # 12:00Z == now: kept
        "2026-10-04T12:00:01+00:01",     # 11:59:01Z: kept
    ])}))
    add("requests: not a list", doc({U[0]: conn(requests="2026-10-04T11:00:00Z"), U[1]: conn(requests={"a": 1}), U[2]: conn(requests=None)}))
    add("requests: at most 64, the newest", doc({U[0]: conn(requests=[
        f"2026-10-04T{h:02d}:{m:02d}:00Z" for h in range(1, 12) for m in range(0, 60, 10)
    ])}))  # 66 entries
    add("requests: a different now", doc({U[0]: conn(requests=[
        "2026-10-04T12:00:00Z", "2026-10-05T01:00:00Z", "2026-10-03T23:00:00Z",
    ])}), now="2026-10-05T00:00:00.000001Z")

    # Accounts: every rule that drops one, and what is kept.
    long201 = "n" * 201
    accounts_bad = {
        "name-not-str": acct(name=5), "name-control": acct(name="a\tb"), "name-201": acct(name=long201),
        "name-missing": {k: v for k, v in acct().items() if k != "name"},
        "inst-number": acct(institution=7), "inst-control": acct(institution="x\x00"),
        "inst-201": acct(institution=long201),
        "cur-lower": acct(currency="usd"), "cur-2": acct(currency="US"), "cur-4": acct(currency="USDX"),
        "cur-none": acct(currency=None),
        "kind-bad": acct(kind="brokerage"), "kind-list": acct(kind=["checking"]),
        "role-bad": acct(role="spend"), "role-dict": acct(role={"r": 1}),
        "label-empty": acct(label=""), "label-121": acct(label="l" * 121), "label-control": acct(label="a\nb"),
        "key-short": acct(account_key="acct:abc"), "key-label": acct(account_key="label:Main"),
        "key-upper": acct(account_key="acct:" + "A" * 64), "key-65": acct(account_key="acct:" + "a" * 65),
        "liab-bad": acct(liability_id="not-a-uuid"), "liab-upper": acct(liability_id=LIAB.upper()),
        "same-bad-prefix": acct(same_as_key="foo:x"), "same-empty": acct(same_as_key="acct:"),
        "same-191": acct(same_as_key="label:" + "x" * 191), "same-control": acct(same_as_key="label:a\x7fb"),
        "same-astral-191": acct(same_as_key="label:" + EMOJI * 191),
        "entry-list": [acct()], "entry-null": None,
        "": acct(), "id-control\x01": acct(), "i" * 201: acct(),
    }
    accounts_good = {
        "name-empty": acct(name=""), "name-200": acct(name="n" * 200), "name-astral-200": acct(name=EMOJI * 200),
        "inst-null": acct(institution=None), "inst-missing": {k: v for k, v in acct().items() if k != "institution"},
        "inst-empty": acct(institution=""),
        "label-120": acct(label="l" * 120), "label-astral-120": acct(label=EMOJI * 120),
        "same-label": acct(same_as_key="label:Main"), "same-190": acct(same_as_key="label:" + "x" * 190),
        "same-astral-190": acct(same_as_key="label:" + EMOJI * 190), "same-acct": acct(same_as_key=KEY_B),
        "flip-1": acct(flip_balance=1), "flip-str": acct(flip_balance="true"), "flip-true": acct(flip_balance=True),
        "flip-missing": {k: v for k, v in acct().items() if k != "flip_balance"},
        "same-missing": {k: v for k, v in acct().items() if k != "same_as_key"},
        "liab-missing": {k: v for k, v in acct().items() if k != "liability_id"},
        "i" * 200: acct(), "id " + EMOJI: acct(), "XXX-cur": acct(currency="XXX"),
        **{f"kind-{k}": acct(kind=k) for k in ("savings", "credit_card", "loan", "unknown")},
        **{f"role-{r}": acct(role=r) for r in ("debt", "ignore")},
    }
    add("accounts: rules that drop an account", doc({U[0]: conn(accounts=accounts_bad)}))
    add("accounts: what is kept", doc({U[0]: conn(accounts=accounts_good)}))
    add("accounts: not an object", doc({U[0]: conn(accounts=[acct()]), U[1]: conn(accounts=None), U[2]: conn(accounts="x")}))
    add("accounts: invalid entries do not count toward 50", doc({U[0]: conn(accounts={
        "bad-a": acct(kind="x"), "bad-b": None,
        **{f"a{n:03d}": acct(label=f"A{n}") for n in range(51)},
    })}))
    return cases


def sanitized_for(case: dict[str, Any]) -> dict[str, Any]:
    """What the server keeps of ``case["value"]`` at ``case["now"]``."""
    parsed: Any = None
    if case["value"]:
        try:
            parsed = json.loads(case["value"])
        except ValueError:
            parsed = None
    return store.sanitize(parsed, now=parse_now(case["now"]))


def build_sanitize() -> dict[str, Any]:
    out = [{**case, "sanitized": sanitized_for(case)} for case in sanitize_cases()]
    return {
        "_comment": (
            "Synthetic cases (plan B5): a raw app_settings 'connections' row ('value', null for no row), "
            "the 'now' it is read at, and what store.sanitize keeps ('sanitized'). Generated by "
            "build_connections_cases.py from the server code. Read by "
            "tests/connectors/test_connections_shared_cases.py and "
            "src/web/test/database/connections-store.test.ts."
        ),
        "cases": out,
    }


# --- plan cases ------------------------------------------------------------------------


def plan_cases() -> list[dict[str, Any]]:
    cases: list[dict[str, Any]] = []

    def add(name: str, connection: dict[str, Any], *, import_ends: dict[str, str] | None = None,
            posted: dict[str, str] | None = None, today: str = TODAY, now: str = NOW,
            imports: list[dict[str, Any]] | None = None) -> None:
        case: dict[str, Any] = {
            "name": name, "today": today, "now": now, "id": U[0], "connection": connection,
            "import_ends": import_ends or {}, "posted": posted or {},
        }
        if imports is not None:
            # Applied imports of any connection ('imports'); 'import_ends' is what
            # store.newest_import_ends returns for this one. Both test suites also
            # run these rows through their real database query.
            case["imports"] = imports
            case["import_ends"] = own_import_ends(U[0], imports)
        cases.append(case)

    one = {"acc-1": acct()}
    for days in (30, 60, 90):
        add(f"first sync {days} days", conn(first_sync_days=days, accounts=one))
    add("no accounts: no windows", conn())
    add("every account ignored: no windows", conn(accounts={"acc-1": acct(role="ignore"), "acc-2": acct(role="ignore", account_key=KEY_B)}))
    add("newest synced end minus 5 days", conn(accounts=one), import_ends={KEY: "2026-09-30"})
    add("synced end in the future is capped at today", conn(accounts=one), import_ends={KEY: "2026-10-20"})
    add("synced end 3 days ahead", conn(accounts=one), import_ends={KEY: "2026-10-07"})
    add("same as: the day after the newest posted row",
        conn(accounts={"acc-1": acct(same_as_key="label:Main")}), posted={"label:Main": "2026-09-20"})
    add("same as: a synced end wins over posted rows",
        conn(accounts={"acc-1": acct(same_as_key="label:Main")}),
        import_ends={"label:Main": "2026-10-01"}, posted={"label:Main": "2026-09-20"})
    add("same as: the own key's end does not count",
        conn(accounts={"acc-1": acct(same_as_key="label:Main")}), import_ends={KEY: "2026-10-01"})
    add("same as with no rows: first sync", conn(first_sync_days=30, accounts={"acc-1": acct(same_as_key="label:Main")}))
    add("posted rows without same as are ignored", conn(first_sync_days=30, accounts=one), posted={KEY: "2026-10-01"})
    add("posted today: since is capped at today",
        conn(accounts={"acc-1": acct(same_as_key="label:Main")}), posted={"label:Main": TODAY})
    add("another connection's import of the same key does not count",
        conn(first_sync_days=30, accounts=one),
        imports=[{"connection_id": U[1], "account_key": KEY, "period_end": "2026-10-01"}])
    add("only this connection's imports move the start",
        conn(accounts=one),
        imports=[
            {"connection_id": U[0], "account_key": KEY, "period_end": "2026-09-20"},
            {"connection_id": U[0], "account_key": KEY, "period_end": "2026-09-10"},
            {"connection_id": U[1], "account_key": KEY, "period_end": "2026-10-02"},
            {"connection_id": None, "account_key": KEY, "period_end": "2026-10-03"},
            {"connection_id": U[0], "account_key": KEY_B, "period_end": "2026-10-03"},
        ])
    add("windows: 91 days is two", conn(accounts=one), import_ends={KEY: "2026-07-11"})
    add("windows: exactly 90 days is one", conn(accounts=one), import_ends={KEY: "2026-07-12"})
    add("windows: at most four, oldest first", conn(accounts=one), import_ends={KEY: "2025-06-01"})
    add("mixed accounts: oldest since starts the windows", conn(first_sync_days=30, accounts={
        "b-card": acct(kind="credit_card", role="debt", account_key=KEY_B, flip_balance=True, liability_id=LIAB),
        "a-chk": acct(),
        "c-ignored": acct(role="ignore", account_key="acct:" + "c" * 64),
    }), import_ends={KEY: "2026-04-01"})
    add("accounts sorted by code point", conn(first_sync_days=30, accounts={
        "b": acct(), "a": acct(), "B": acct(), EMOJI: acct(), "\uffef": acct(), "a\u00e9": acct(),
    }))
    add("leap year month end", conn(first_sync_days=30, accounts=one), today="2024-03-01", now="2024-03-01T12:00:00Z")
    add("year boundary", conn(first_sync_days=60, accounts=one), today="2026-01-15", now="2026-01-15T12:00:00Z")
    add("simplefin: 19 requests leave 1", conn(provider="simplefin", accounts=one, requests=[
        f"2026-10-04T{h:02d}:00:00Z" for h in range(0, 12)] + [f"2026-10-03T{h:02d}:30:00Z" for h in range(13, 20)]))
    add("simplefin: 20 requests, resets 24 h after the oldest", conn(provider="simplefin", accounts=one, requests=[
        "2026-10-03T14:15:16.987654+02:00"] + [f"2026-10-04T{h:02d}:00:00Z" for h in range(0, 12)]
        + [f"2026-10-03T{h:02d}:30:00Z" for h in range(15, 22)]))
    add("simplefin: old requests do not count", conn(provider="simplefin", accounts=one, requests=[
        f"2026-10-02T{h:02d}:00:00Z" for h in range(0, 24)]))
    add("akahu budget", conn(provider="akahu", accounts=one, requests=[f"2026-10-04T{h:02d}:00:00Z" for h in range(0, 12)]))
    add("akahu: 48 requests", conn(provider="akahu", accounts=one, requests=[
        f"2026-10-04T{h:02d}:{m:02d}:00Z" for h in range(0, 12) for m in (0, 15, 30, 45)]))
    add("demo has no quota", conn(provider="demo", accounts=one, requests=["2026-10-04T11:00:00Z"] * 30))
    add("summary fields", conn(provider="simplefin", label="Bank", status="reconnect_needed",
                               last_synced_at="2026-10-02T10:00:00Z", status_at="bad",
                               accounts={"acc-1": acct(), "acc-2": acct(role="ignore", account_key=KEY_B)}))
    return cases


def own_import_ends(connection_id: str, imports: list[dict[str, Any]]) -> dict[str, str]:
    """What ``store.newest_import_ends`` returns for ``connection_id``: the newest
    ``period_end`` per account key among that connection's imports."""
    out: dict[str, str] = {}
    for row in imports:
        if row["connection_id"] != connection_id or row["period_end"] is None:
            continue
        key = row["account_key"]
        if key not in out or row["period_end"] > out[key]:
            out[key] = row["period_end"]
    return out


def detail_for(case: dict[str, Any]) -> dict[str, Any]:
    """The server's detail for ``case``: the stored connection sanitized at
    ``now``, with the plan's database reads and ``today`` pinned."""
    stored = store.sanitize(
        {"version": 1, "items": {case["id"]: case["connection"]}}, now=parse_now(case["now"])
    )
    entry = stored["items"][case["id"]]
    ends = {k: date.fromisoformat(v) for k, v in case["import_ends"].items()}
    posted = {k: date.fromisoformat(v) for k, v in case["posted"].items()}
    today = date.fromisoformat(case["today"])

    def import_ends(_db: Any, _cid: str, keys: Any) -> dict[str, date]:
        return {k: v for k, v in ends.items() if k in set(keys)}

    def posted_dates(_db: Any, keys: Any) -> dict[str, date]:
        return {k: v for k, v in posted.items() if k in set(keys)}

    with mock.patch.object(store, "newest_import_ends", import_ends), mock.patch.object(
        store, "newest_posted_dates", posted_dates
    ), mock.patch.object(service.clock, "today", lambda: today):
        return service._detail(None, case["id"], entry)


def build_plan() -> dict[str, Any]:
    out = [{**case, "detail": detail_for(case)} for case in plan_cases()]
    return {
        "_comment": (
            "Synthetic cases (plan B5): one stored connection ('connection', sanitized at 'now'), the "
            "newest synced period_end and newest posted_date per account key, and the detail the server "
            "returns at 'today' (service._detail). Generated by build_connections_cases.py. Read by "
            "tests/connectors/test_connections_shared_cases.py and "
            "src/web/test/database/connections.test.ts."
        ),
        "cases": out,
    }


def write(name: str, data: dict[str, Any]) -> None:
    text = json.dumps(data, indent=1, ensure_ascii=True) + "\n"
    (HERE / name).write_text(text, encoding="utf-8")


if __name__ == "__main__":
    write("connections_sanitize_cases.json", build_sanitize())
    write("connections_plan_cases.json", build_plan())
    print("wrote connections_sanitize_cases.json and connections_plan_cases.json")
