"""Build tests/fixtures/connections_scenario.json (plan B7, design 13).

One scripted connections scenario that runs through both data paths:

* the server: ``tests/api/test_connections_parity.py`` (FastAPI ``TestClient``
  on a temp database, the clocks pinned, a transport that refuses every
  request so nothing can reach a network);
* the browser: ``src/web/test/api/connections-parity.test.ts`` (``apiCall`` in
  local data mode, so the B6 composites and the ``local()`` routes run, with
  the v2 calls answered from ``connections_scenario.v2.json``, which the
  server run records).

Both compare against ``connections_scenario.expected.json``, which the server
run writes. The demo provider is the only one that is called successfully. The two
stored SimpleFIN connections' sync and refresh never reach a provider (their
gates refuse first), the one SimpleFIN claim is refused by the setup-token
decoder before any request, and the one pasted SimpleFIN Access URL
(``REFUSED_ACCESS_URL``) is answered 401 by the server harness's transport.

Every value is synthetic. Run from the repository root after changing the
scenario, then regenerate the expected files from the server path and review
them by hand:

    python tests/fixtures/build_connections_scenario.py
    WRITE_CONNECTIONS_PARITY_EXPECTED=1 python -m pytest tests/api/test_connections_parity.py

Step kinds (both harnesses implement each one):

* API: ``method``, ``path`` (``{alias}`` is replaced with a saved value),
  optional ``body``, ``save`` (``alias: dotted.path`` into the response) and
  ``save_body`` (keep the whole raw response under an alias).
* ``apply_sync``: build a smart import Apply request from a saved sync
  response the way the wizard does (``tests/connectors/apply_contract.py
  as_apply``: ``connection_id`` on every statement, the account label
  cleared, each row's ``dedupe_key``) plus a ``liability_id`` per account
  key and the optional ``rules``, then POST it to ``/api/smart-import/apply``.
* ``db``: ``put_connection`` writes one raw entry into the ``connections``
  row with ``recent_requests`` request stamps one minute apart ending a
  minute before the harness clock, and no secret row.
* ``clock``: move both clocks to 09:00 on another day.
* ``probe``: read the database directly (see the harnesses).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from src.connectors.errors import CONNECTOR_ERRORS  # noqa: E402
from src.connectors.normalize import account_key_for  # noqa: E402
from src.smart_import.errors import ERROR_CATALOG  # noqa: E402

HERE = Path(__file__).resolve().parent
OUT = HERE / "connections_scenario.json"

TODAY = "2026-10-04"
WEEK_LATER = "2026-10-11"

LIAB = "0a0b0c0d-0e0f-4a1b-8c2d-3e4f5a6b7c8d"
UNKNOWN_LIAB = "0a0b0c0d-0e0f-4a1b-8c2d-000000000000"
UNKNOWN_CONN = "11111111-2222-4333-8444-555555555555"
SF_QUOTA = "5f5f5f5f-0000-4000-8000-000000000001"
SF_NO_SECRET = "5f5f5f5f-0000-4000-8000-000000000002"

CHK = "demo-chk"
CARD = "demo-card"
CHK_KEY = account_key_for("demo", CHK)
CARD_KEY = account_key_for("demo", CARD)
SF_KEY = account_key_for("simplefin", "sf-chk")
# The one provider request that is answered (401 Unauthorized) by the server
# harness's transport; synthetic, on the SimpleFIN allowlist.
REFUSED_ACCESS_URL = "https://parity-user:parity-revoked@bridge.simplefin.org/simplefin"

CONNS = "/api/connections"
APPLY = "/api/smart-import/apply"
IMPORTS = "/api/smart-import/imports"

steps: list[dict[str, Any]] = []


def api(name: str, method: str, path: str, body: Any = None, **extra: Any) -> None:
    step: dict[str, Any] = {"name": name, "method": method, "path": path}
    if body is not None:
        step["body"] = body
    step.update(extra)
    steps.append(step)


def probe(name: str, kind: str) -> None:
    steps.append({"name": name, "probe": kind})


def simplefin_entry(label: str) -> dict[str, Any]:
    """A stored SimpleFIN connection with one mapped checking account."""
    return {
        "provider": "simplefin",
        "label": label,
        "created_at": "2026-10-01T09:00:00Z",
        "status": "ok",
        "status_at": "2026-10-01T09:00:00Z",
        "last_synced_at": None,
        "first_sync_days": 30,
        "requests": [],
        "accounts": {
            "sf-chk": {
                "name": "Everyday",
                "institution": "Sample Bank",
                "currency": "USD",
                "kind": "checking",
                "role": "cash_flow",
                "label": "Everyday",
                "account_key": SF_KEY,
                "liability_id": None,
                "flip_balance": False,
                "same_as_key": None,
            }
        },
    }


# --- create: refusals before anything is stored -----------------------------------

api("list before any connection", "GET", CONNS)
api("create with an unknown provider", "POST", CONNS, {"provider": "plaid"})
api("create with an extra field", "POST", CONNS, {"provider": "demo", "region": "us"})
api("create the demo with a setup token", "POST", CONNS, {"provider": "demo", "setup_token": "abc"})
api("create with a first sync range that is not offered", "POST", CONNS,
    {"provider": "demo", "first_sync_days": 45})
api("create with a label over 120 characters", "POST", CONNS, {"provider": "demo", "label": "x" * 121})
api("create with a control character in the label", "POST", CONNS,
    {"provider": "demo", "label": "Demo\u0007"})
api("create simplefin with two credentials", "POST", CONNS,
    {"provider": "simplefin", "setup_token": "abc", "access_url": "https://u:p@bridge.simplefin.org/simplefin"})
api("create simplefin with an access url off the allowlist", "POST", CONNS,
    {"provider": "simplefin", "access_url": "https://synthetic:secret@bridge.example.invalid/simplefin"})
# Refused by the setup-token decoder before any request: the server's claim
# and the browser's v2 claim both answer bad_setup_token, and nothing is stored.
api("create simplefin with a malformed setup token", "POST", CONNS,
    {"provider": "simplefin", "setup_token": "not-a-setup-token"})
probe("probe connections after the refused creates", "connections")

# --- create, list, detail ---------------------------------------------------------

api("create the demo connection", "POST", CONNS,
    {"provider": "demo", "label": "Demo checking and card", "first_sync_days": 30}, save={"C1": "id"})
api("list after the create", "GET", CONNS)
api("detail before the first sync", "GET", f"{CONNS}/{{C1}}")
probe("probe requests after the create", "requests")
api("detail of an unknown connection", "GET", f"{CONNS}/{UNKNOWN_CONN}")
api("detail with an uppercase id", "GET", f"{CONNS}/{SF_QUOTA.upper()}")

# --- account mapping --------------------------------------------------------------

api("update an unknown connection", "PUT", f"{CONNS}/{UNKNOWN_CONN}", {"label": "Other"})
api("update an unknown account", "PUT", f"{CONNS}/{{C1}}", {"accounts": {"nope": {"role": "ignore"}}})
api("update with a null kind", "PUT", f"{CONNS}/{{C1}}", {"accounts": {CHK: {"kind": None}}})
api("update with a role that does not exist", "PUT", f"{CONNS}/{{C1}}", {"accounts": {CHK: {"role": "savings"}}})
api("update with an empty label", "PUT", f"{CONNS}/{{C1}}", {"label": ""})
api("update with an extra field", "PUT", f"{CONNS}/{{C1}}", {"status": "ok"})
api("update with an unknown liability", "PUT", f"{CONNS}/{{C1}}",
    {"accounts": {CARD: {"liability_id": UNKNOWN_LIAB}}})
api("update with the account's own key as same_as", "PUT", f"{CONNS}/{{C1}}",
    {"accounts": {CHK: {"same_as_key": CHK_KEY}}})
api("update the label and the account mapping", "PUT", f"{CONNS}/{{C1}}", {
    "label": "Demo bank",
    "accounts": {CHK: {"label": "Everyday"}, CARD: {"label": "Rewards", "liability_id": LIAB, "flip_balance": False}},
})
probe("probe requests after the mapping update", "requests")

# --- sync 1, apply with connection_id ----------------------------------------------

api("sync with window index 4", "POST", f"{CONNS}/{{C1}}/sync", {"window_index": 4})
api("sync with a window index outside the plan", "POST", f"{CONNS}/{{C1}}/sync", {"window_index": 1})
api("sync with a string window index", "POST", f"{CONNS}/{{C1}}/sync", {"window_index": "0"})
api("sync with an extra key", "POST", f"{CONNS}/{{C1}}/sync", {"window_index": 0, "all": True})
api("sync an unknown connection", "POST", f"{CONNS}/{UNKNOWN_CONN}/sync", {})
api("sync 1", "POST", f"{CONNS}/{{C1}}/sync", {}, save_body="SYNC1")
api("detail after sync 1 before apply", "GET", f"{CONNS}/{{C1}}")
probe("probe requests after sync 1", "requests")
probe("probe counts after sync 1 before apply", "counts")
steps.append({
    "name": "apply sync 1 with connection_id",
    "apply_sync": {
        "sync": "SYNC1", "connection": "C1", "batch_id": "parity-sync-1", "liabilities": {CARD_KEY: LIAB},
        # Two remembered merchants, so later syncs send rules in their context.
        "rules": [
            {"merchant_key": "CHIPOTLE", "category_id": "cat-dining", "kind": "expense", "source": "user"},
            {"merchant_key": "SAFEWAY", "category_id": "cat-groceries", "kind": "expense", "source": "user"},
        ],
    },
    "save": {"I1A": "imports.0.import_id", "I1B": "imports.1.import_id"},
})
probe("probe counts after apply 1", "counts")
probe("probe transactions per account after apply 1", "transaction_counts")
probe("probe liabilities after apply 1", "liabilities")
api("imports list shows the connection", "GET", IMPORTS)
api("detail after apply 1 moves next_since", "GET", f"{CONNS}/{{C1}}")
steps.append({
    "name": "apply sync 1 again is skipped by file hash",
    "apply_sync": {"sync": "SYNC1", "connection": "C1", "batch_id": "parity-sync-1-again",
                   "liabilities": {CARD_KEY: LIAB}},
})
probe("probe counts after the repeated apply", "counts")

# --- a week later: sync 2 overlaps, then undo rewinds the plan ---------------------

steps.append({"name": "a week later", "clock": WEEK_LATER})
api("detail a week later", "GET", f"{CONNS}/{{C1}}")
probe("probe requests a week later", "requests")
api("sync 2 overlapping sync 1", "POST", f"{CONNS}/{{C1}}/sync", None, save_body="SYNC2")
steps.append({
    "name": "apply sync 2 with its overlap",
    "apply_sync": {"sync": "SYNC2", "connection": "C1", "batch_id": "parity-sync-2", "liabilities": {CARD_KEY: LIAB}},
    "save": {"I2A": "imports.0.import_id", "I2B": "imports.1.import_id"},
})
probe("probe counts after apply 2", "counts")
probe("probe transactions per account after apply 2", "transaction_counts")
probe("probe liabilities after apply 2", "liabilities")
api("detail after apply 2", "GET", f"{CONNS}/{{C1}}")
api("undo the first statement of sync 2", "DELETE", f"{IMPORTS}/{{I2A}}")
api("undo the second statement of sync 2", "DELETE", f"{IMPORTS}/{{I2B}}")
api("detail after undoing sync 2 rewinds next_since", "GET", f"{CONNS}/{{C1}}")
probe("probe counts after undoing sync 2", "counts")
probe("probe liabilities after undoing sync 2", "liabilities")

# --- refresh -------------------------------------------------------------------------

api("refresh the account list keeps the mapping", "POST", f"{CONNS}/{{C1}}/accounts")
api("refresh an unknown connection", "POST", f"{CONNS}/{UNKNOWN_CONN}/accounts")
probe("probe requests after the refresh", "requests")
api("reconnect the demo connection", "POST", f"{CONNS}/{{C1}}/credentials", {})
api("reconnect the demo with an access url", "POST", f"{CONNS}/{{C1}}/credentials",
    {"access_url": "https://u:p@bridge.simplefin.org/simplefin"})
api("reconnect an unknown connection", "POST", f"{CONNS}/{UNKNOWN_CONN}/credentials", {})
probe("probe requests after the reconnect", "requests")

# --- quota and the reconnect gate (stored SimpleFIN connections, no provider call) ---

steps.append({"name": "store a simplefin connection at its daily limit", "db": "put_connection",
              "id": SF_QUOTA, "entry": simplefin_entry("Bank at its limit"), "recent_requests": 20})
api("detail at the daily limit", "GET", f"{CONNS}/{SF_QUOTA}")
api("sync at the daily limit", "POST", f"{CONNS}/{SF_QUOTA}/sync", {})
api("refresh at the daily limit", "POST", f"{CONNS}/{SF_QUOTA}/accounts")
steps.append({"name": "store a simplefin connection with no credential", "db": "put_connection",
              "id": SF_NO_SECRET, "entry": simplefin_entry("Bank without a credential"), "recent_requests": 3})
api("sync with no stored credential", "POST", f"{CONNS}/{SF_NO_SECRET}/sync", {})
api("detail after the missing credential", "GET", f"{CONNS}/{SF_NO_SECRET}")
api("sync a connection that needs reconnecting", "POST", f"{CONNS}/{SF_NO_SECRET}/sync", {})
api("refresh a connection that needs reconnecting", "POST", f"{CONNS}/{SF_NO_SECRET}/accounts")
# A pasted credential is tried before it is stored: the bridge's 401 comes back
# as accounts_error, counted, with the status and the (missing) secret kept.
api("reconnect with a pasted access url the bridge refuses", "POST", f"{CONNS}/{SF_NO_SECRET}/credentials",
    {"access_url": REFUSED_ACCESS_URL})
probe("probe connections after the refused reconnect", "connections")
probe("probe requests after the refused calls", "requests")
api("list with three connections", "GET", CONNS)

# --- the ten-connection limit ---------------------------------------------------------

for n in range(1, 8):
    api(f"create filler connection {n}", "POST", CONNS, {"provider": "demo", "label": f"Filler {n}"},
        save={f"F{n}": "id"})
api("create an eleventh connection", "POST", CONNS, {"provider": "demo", "label": "One too many"})
probe("probe connections at the limit", "connections")
for n in range(1, 8):
    api(f"disconnect filler connection {n}", "DELETE", f"{CONNS}/{{F{n}}}")

# --- disconnect -------------------------------------------------------------------------

api("disconnect with an unrecognised remove_data", "DELETE", f"{CONNS}/{{C1}}?remove_data=maybe")
api("disconnect with remove_data=1", "DELETE", f"{CONNS}/{{C1}}?remove_data=1")
api("disconnect an unknown connection", "DELETE", f"{CONNS}/{UNKNOWN_CONN}")
api("disconnect keeping the imported data", "DELETE", f"{CONNS}/{{C1}}?remove_data=false")
probe("probe connections after the plain disconnect", "connections")
probe("probe counts after the plain disconnect", "counts")
api("imports keep the removed connection id", "GET", IMPORTS)
api("detail of the removed connection", "GET", f"{CONNS}/{{C1}}")
api("disconnect the removed connection again", "DELETE", f"{CONNS}/{{C1}}")
steps.append({
    "name": "apply naming the removed connection",
    "apply_sync": {"sync": "SYNC2", "connection": "C1", "batch_id": "parity-removed", "liabilities": {CARD_KEY: LIAB}},
})

api("create a second demo connection", "POST", CONNS, {"provider": "demo", "first_sync_days": 30},
    save={"C2": "id"})
api("map the second connection's card", "PUT", f"{CONNS}/{{C2}}", {"accounts": {CARD: {"liability_id": LIAB}}})
api("sync the second connection", "POST", f"{CONNS}/{{C2}}/sync", {"window_index": 0}, save_body="SYNC3")
steps.append({
    "name": "apply the second connection's sync",
    "apply_sync": {"sync": "SYNC3", "connection": "C2", "batch_id": "parity-sync-3", "liabilities": {CARD_KEY: LIAB}},
    "save": {"I3A": "imports.0.import_id"},
})
probe("probe counts before removing the second connection's data", "counts")
probe("probe liabilities before removing the second connection's data", "liabilities")
api("disconnect the second connection and remove its data", "DELETE", f"{CONNS}/{{C2}}?remove_data=true")
probe("probe counts after removing the data", "counts")
probe("probe transactions per account after removing the data", "transaction_counts")
probe("probe liabilities after removing the data", "liabilities")
probe("probe connections after removing the data", "connections")
api("imports after removing the data", "GET", IMPORTS)
api("undo an import of the removed connection", "DELETE", f"{IMPORTS}/{{I3A}}")
api("undo an import of the plainly disconnected connection", "DELETE", f"{IMPORTS}/{{I1A}}")
api("disconnect the stored connection at its limit", "DELETE", f"{CONNS}/{SF_QUOTA}?remove_data=true")
api("disconnect the stored connection with no credential", "DELETE", f"{CONNS}/{SF_NO_SECRET}")
api("list after every disconnect", "GET", CONNS)
probe("probe requests at the end", "requests")
probe("probe connections at the end", "connections")


# --- divergences ----------------------------------------------------------------------
# Every known difference between the paths, named, with how the parity tests
# handle it. Both harnesses read this and enforce it: the allowlist entries are
# the only normalizations they apply, every connection error code is either
# reached by a step or explained here, and the browser checks its catalog
# against each code's paths.

COVERED = ["tests/api/test_connections_api.py", "src/web/test/api/connections-composite.test.ts"]

ALLOWLIST = [
    {"id": "minted-ids",
     "what": "Connection, import and other generated ids.",
     "why": "Each path mints its own (uuid4 on the server, crypto.randomUUID in the browser).",
     "handling": "Replaced with <id-n> in order of first appearance; the scenario's own ids stay exact."},
    {"id": "wall-clock-stamps",
     "what": "created_at, updated_at, imported_at, analyzed_at, uploaded_at, status_at, last_synced_at, "
             "quota_resets_at.",
     "why": "Each path pins its own clock (the server in UTC, the browser's fake Date in local time), one "
            "second per step.",
     "handling": "Only whether the stamp is set is compared. Dates that follow `today` (next_since, windows, "
                 "posted and snapshot dates) are exact, and the request counts are probed exactly."},
    {"id": "rule-ids",
     "what": "Merchant rule ids inside a v2 sync request's context.rules.",
     "why": "Minted per path; the v2 core matches rules on merchant_key and never reads the id.",
     "handling": "Left out of both sides of the v2 request comparison; every other field is exact."},
    {"id": "v2-status-call",
     "what": "GET /api/v2/connectors/status.",
     "why": "The browser composites read the enabled providers and allowed hosts from it (cached per page); "
            "the server reads its own environment.",
     "handling": "Answered from the recorded server answer and not counted as a provider call."},
]


def code(paths: str, reached: bool, why: str | None = None) -> dict[str, Any]:
    entry: dict[str, Any] = {"paths": paths, "reached": reached}
    if not reached:
        entry["why_not_reached"] = why
        entry["covered_by"] = COVERED
    return entry


ERROR_CODES: dict[str, dict[str, Any]] = {
    # Shared smart import codes the connection routes use.
    "bad_request": code("both", True),
    "liability_not_found": code("both", True),
    "import_not_found": code("both", True),
    "save_failed": code("both", False, "Needs an unusable key or a failing write."),
    # src/connectors/errors.py
    "bad_setup_token": code("both-via-v2", True),
    "claim_refused": code("both-via-v2", False, "Needs SimpleFIN Bridge to refuse a claim (a network answer)."),
    "host_not_allowed": code("both", True),
    "reconnect_needed": code("both", True),
    "payment_required": code("both", False, "Needs a provider 402."),
    "provider_rate_limited": code("both", False, "Needs a provider 429."),
    "quota_reached": code("both", True),
    "window_too_long": code("both-via-v2", False,
                            "The plan never builds a window over 90 days; only a direct v2 call can send one."),
    "provider_timeout": code("both", False, "Needs a provider that does not answer."),
    "response_too_large": code("both-via-v2", False, "Needs an oversized provider answer."),
    "provider_bad_response": code("both", False, "Needs an unusable provider answer."),
    "provider_unavailable": code("both", False, "Needs an unreachable provider."),
    "connector_disabled": code("both", False,
                               "The server routes run only where every provider is enabled (not shared); the "
                               "browser learns it from v2 /status on a shared deployment."),
    "connections_unavailable": code("server-only", False,
                                    "The server refuses connections on a shared deployment; hosted mode keeps "
                                    "them in the browser, which has no such gate."),
    "connection_not_found": code("both", True),
    "connection_limit": code("both", True),
    "claim_not_saved": code("both", False, "Needs a good claim (a network answer) followed by a failed save."),
    "claim_timeout": code("both", False, "Needs a claim that times out."),
    "request_time_short": code("server-only", False,
                               "The server's per-request deadline after waiting on its lock; the browser has "
                               "no request deadline (B5, B6 divergence 4)."),
    # Browser only (src/web/src/database/local-smart-import.ts CATALOG).
    "connection_busy": code("browser-only", False,
                            "A second call on a busy connection in one tab; the server waits on its lock "
                            "instead (B6 divergence 3). The scenario is sequential."),
    "storage_unavailable": code("browser-only", False,
                                "IndexedDB or WebCrypto failing while a sealed credential is opened (B6 review "
                                "round 1, item 2)."),
}

# The server's status and fixed detail per code, for the browser's catalog check.
for _name, _entry in ERROR_CODES.items():
    if _entry["paths"] != "browser-only":
        _status, _detail = CONNECTOR_ERRORS.get(_name) or ERROR_CATALOG[_name]
        _entry["status"], _entry["detail"] = _status, _detail

KNOWN = [
    {"id": "b5-invalid-account-key", "source": "cn-B5 divergence 1",
     "handling": "Not reachable: v2 always sends a valid account_key. Not exercised."},
    {"id": "b5-hand-edited-row", "source": "cn-B3 known gap, cn-B5 divergence 2",
     "handling": "Not reachable: NaN or Infinity, first_sync_days 30.0 and integer-like account ids need a "
                 "hand-edited row; Finlity never writes them. Not exercised."},
    {"id": "b5-write-returns-memory", "source": "cn-B5 divergence 3",
     "handling": "Differs only for a hand-edited row with more than 64 requests. The scenario's create, "
                 "refresh, reconnect and update answers are asserted equal."},
    {"id": "b6-access-url-without-status", "source": "cn-B6 divergence 1 and review round 1, item 1",
     "handling": "Asserted with /status available: both refuse an off-allowlist Access URL with "
                 "host_not_allowed and store nothing (step 'create simplefin with an access url off the "
                 "allowlist'). The /status-down variant is not run here."},
    {"id": "b6-disabled-without-status", "source": "cn-B6 divergence 2",
     "handling": "Not reachable here (connector_disabled above)."},
    {"id": "b6-busy", "source": "cn-B6 divergence 3",
     "handling": "Not reachable in a sequential scenario (connection_busy above)."},
    {"id": "b6-no-deadline", "source": "cn-B5, cn-B6 divergence 4",
     "handling": "Server only (request_time_short above)."},
    {"id": "b6-count-timestamp", "source": "cn-B6 divergence 5",
     "handling": "Stamps are normalized (wall-clock-stamps); the request counts are asserted after every "
                 "provider call and every refusal."},
    {"id": "b6-reconnect-order", "source": "cn-B6 review round 1, item 1 (contract note)",
     "handling": "Asserted: a pasted Access URL the bridge refuses with 401 is verified before it is stored on "
                 "both paths (step 'reconnect with a pasted access url the bridge refuses'): accounts_error, "
                 "the request counted, status and secret rows unchanged. The demo reconnect (no credential, a "
                 "refresh on both paths) is asserted equal too."},
    {"id": "b6-claim-status-0", "source": "cn-B6 review round 1, item 7",
     "handling": "Not reachable: the test transport always answers (claim_timeout above)."},
    {"id": "core-wall-clock", "source": "found in B7",
     "handling": "Not a path divergence: normalize.to_statements takes `now` as a required keyword and never "
                 "reads the wall clock. The service passes its clock and the v2 route its own; the server "
                 "run pins both to the scenario clock and the browser replays the v2 answer, so the "
                 "expected file does not depend on the real date."},
]

scenario: dict[str, Any] = {
    "_comment": (
        "Built by tests/fixtures/build_connections_scenario.py; run by "
        "tests/api/test_connections_parity.py and src/web/test/api/connections-parity.test.ts."
    ),
    "today": TODAY,
    "setup": {
        "categories": [
            {"id": "cat-groceries", "name": "Groceries", "sort_order": 0},
            {"id": "cat-dining", "name": "Dining", "sort_order": 1},
            {"id": "cat-transport", "name": "Transportation", "sort_order": 2},
            {"id": "cat-other", "name": "Other", "sort_order": 3},
        ],
        "liabilities": [
            {"id": LIAB, "name": "Rewards Card", "liability_type": "credit_card", "lender": "Demo Bank",
             "current_balance": 1000, "balance_as_of": "2026-09-01", "is_active": True},
        ],
        "snapshots": [
            {"id": "S-manual", "liability_id": LIAB, "snapshot_date": "2026-09-01", "balance": 1000,
             "source": "manual"},
        ],
        "expenses": [],
    },
    "steps": steps,
    "divergences": {"allowlist": ALLOWLIST, "error_codes": ERROR_CODES, "known": KNOWN},
}


def render() -> str:
    return json.dumps(scenario, indent=1, ensure_ascii=True) + "\n"


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    out.write_text(render())
    print(len(steps), "steps")
