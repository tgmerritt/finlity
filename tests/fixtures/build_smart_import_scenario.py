"""Build tests/fixtures/smart_import_scenario.json (synthetic data only).

The smart import parity scenario, run by tests/api/test_smart_import_parity.py
(server) and src/web/test/api/smart-import-parity.test.ts (browser). Moved
into the repository from a scratch directory in plan B7 so the fixture can be
regenerated from here. Run from the repository root after changing the
scenario, then regenerate the expected file from the server path and review
it by hand:

    python tests/fixtures/build_smart_import_scenario.py
    WRITE_SMART_IMPORT_PARITY_EXPECTED=1 python -m pytest tests/api/test_smart_import_parity.py
"""

import json
import sys
from pathlib import Path

A, B, C, D = "a" * 64, "b" * 64, "c" * 64, "d" * 64
E, F, G, H = "e" * 64, "f" * 64, "1" * 64, "2" * 64
X, OLD, SAMPLE = "3" * 64, "4" * 64, "5" * 64
S1, S2, S3 = "6" * 64, "7" * 64, "8" * 64
CONN = "0f0e0d0c-0b0a-4908-8706-050403020100"
OTHER_CONN = "11111111-2222-4333-8444-555555555555"
CONNECTIONS_DOC = {"version": 1, "items": {CONN: {
    "provider": "demo", "label": "Demo", "created_at": "2026-10-01T09:00:00Z", "status": "ok",
    "status_at": "2026-10-01T09:00:00Z", "last_synced_at": "2026-10-04T08:00:00Z", "first_sync_days": 30,
    "requests": [], "accounts": {},
}}}

K1, K2, K3 = "9" * 64, "ab" * 32, "cd" * 32
K4, K5, K6 = "ef" * 32, "a1" * 32, "b2" * 32
SECOND_DOC = {"version": 1, "items": {OTHER_CONN: {
    "provider": "simplefin", "label": "Second", "created_at": "2026-10-02T09:00:00Z", "status": "ok",
    "status_at": "2026-10-02T09:00:00Z", "last_synced_at": None, "first_sync_days": 30,
    "requests": [], "accounts": {},
}}}

def txn(acct, posted, amount, merchant, kind="expense", category=None, source="rule", excluded=False):
    return {
        "posted_date": posted, "amount": amount, "description": f"{merchant} SYNTHETIC", "merchant_key": merchant,
        "kind": kind, "category_id": category, "category_source": source if category else "none",
        "dedupe_key": f"{acct}|{merchant}|{posted}|{amount}", "excluded": excluded,
    }


def stmt(file_hash, key, kind, txns, *, origin="file", fmt="csv", closing=None, liability=None, period=None,
         label="Main", last4="1234"):
    return {
        "file_hash": file_hash, "file_name": f"synthetic-{key.split(':')[1]}.{fmt}", "origin": origin,
        "format": fmt, "parser": fmt,
        "account": {"kind": kind, "key": key, "label": label, "last4": last4, "institution": "Sample Bank"},
        "period": period or {"start": None, "end": None},
        "closing_balance": closing, "liability_id": liability, "ai_used": False, "transactions": txns,
    }


def synced(file_hash, key, kind, txns, *, cid=CONN, **kw):
    """A statement synced from a connection, as the wizard applies it."""
    body = stmt(file_hash, key, kind, txns, origin="connector", fmt="connector", **kw)
    body["parser"] = "connector:demo"
    body["account"]["last4"] = None
    if cid is not None:
        body["connection_id"] = cid
    return body


CHK = "acct:chk"
AUG_SHARED = [
    txn(CHK, "2026-08-03", -15.49, "NETFLIX", category="cat-dining"),
    txn(CHK, "2026-08-12", -95.5, "GROCER", category="cat-groceries"),
    txn(CHK, "2026-08-15", -10.99, "SPOTIFY", category="cat-other"),
    txn(CHK, "2026-08-28", 3000, "PAYROLL", kind="income"),
    txn(CHK, "2026-08-05", -500, "CARD PAYMENT", kind="payment"),
    txn(CHK, "2026-08-06", -200, "TO SAVINGS", kind="transfer"),
    txn(CHK, "2026-08-20", 20, "GROCER", kind="refund", category="cat-groceries"),
    txn(CHK, "2026-08-22", -33.33, "MYSTERY SHOP"),
]
ST_A = stmt(A, CHK, "checking", [
    txn(CHK, "2026-07-03", -15.49, "NETFLIX", category="cat-dining"),
    txn(CHK, "2026-07-10", -80, "GROCER", category="cat-groceries"),
    txn(CHK, "2026-07-15", -10.99, "SPOTIFY", category="cat-other"),
    txn(CHK, "2026-07-20", -60, "WATERCO", category="cat-other"),
    txn(CHK, "2026-07-28", 3000, "PAYROLL", kind="income"),
    *AUG_SHARED,
    txn(CHK, "2026-08-25", -9, "SKIPPED", category="cat-other", excluded=True),
], period={"start": "2026-07-01", "end": "2026-08-31"})
ST_C1 = stmt(C, "acct:card", "credit_card", [
    txn("acct:card", "2026-09-05", -400, "AIRLINE", category="cat-other"),
    txn("acct:card", "2026-09-10", 500, "PAYMENT THANK YOU", kind="payment"),
    txn("acct:card", "2026-09-14", -42, "BISTRO", category="cat-dining"),
    txn("acct:card", "2026-09-20", -95, "ANNUAL FEE", kind="fee", category="cat-debt"),
    txn("acct:card", "2026-09-25", -12.34, "INTEREST CHARGE", kind="interest", category="cat-debt"),
], fmt="ofx", closing={"amount": 640, "as_of": "2026-09-25"}, liability="L-card",
    period={"start": "2026-08-26", "end": "2026-09-25"}, label="Visa", last4="5678")
NETFLIX_SEP = txn(CHK, "2026-09-03", -15.49, "NETFLIX", category="cat-dining")
ST_B = stmt(B, CHK, "checking", [
    *AUG_SHARED,
    NETFLIX_SEP,
    dict(NETFLIX_SEP),  # repeat inside one statement: a duplicate with no claim
    txn(CHK, "2026-09-12", -70.25, "GROCER", category="cat-groceries"),
    txn(CHK, "2026-09-15", -10.99, "SPOTIFY", category="cat-other"),
    txn(CHK, "2026-09-18", -45, "GYMCLUB", category="cat-other"),
    txn(CHK, "2026-09-28", 3000, "PAYROLL", kind="income"),
], period={"start": "2026-08-01", "end": "2026-09-30"})

BATCH1 = {
    "batch_id": "batch-1",
    "statements": [ST_A, ST_C1],
    "rules": [
        {"merchant_key": "NETFLIX", "category_id": "cat-dining", "kind": "expense", "source": "user"},
        {"merchant_key": "GROCER", "category_id": "cat-groceries", "kind": "expense", "source": "import"},
        {"merchant_key": "PAYROLL", "category_id": None, "kind": "income", "source": "user"},
    ],
    "recurring": [
        {"merchant_key": "NETFLIX", "name": "Netflix", "amount": 15.49, "frequency": "monthly",
         "category_id": "cat-dining", "occurrences": 2, "file_hash": A, "decision": "link", "expense_id": "E-netflix"},
        {"merchant_key": "SPOTIFY", "name": "Spotify", "amount": 10.99, "frequency": "monthly",
         "category_id": "cat-other", "occurrences": 2, "file_hash": A, "decision": "create"},
        {"merchant_key": "WATERCO", "name": "Water Co", "amount": 60, "frequency": "quarterly",
         "category_id": "cat-other", "occurrences": 1, "file_hash": A, "decision": "create"},
        {"merchant_key": "PAYROLL", "name": "Payroll", "amount": 3000, "frequency": "monthly",
         "category_id": "cat-other", "occurrences": 2, "file_hash": A, "decision": "reject"},
    ],
}


def preview_of(*statements):
    return {"statements": [{
        "file_hash": s["file_hash"], "account_key": s["account"]["key"], "account_kind": s["account"]["kind"],
        "institution": s["account"]["institution"],
        "dedupe_keys": sorted({t["dedupe_key"] for t in s["transactions"]}),
        "merchant_keys": sorted({t["merchant_key"] for t in s["transactions"]}),
    } for s in statements]}


def get(name, path, **extra):
    return {"name": name, "method": "GET", "path": path, **extra}


def send(name, method, path, body=None, **extra):
    step = {"name": name, "method": method, "path": path, **extra}
    if body is not None:
        step["body"] = body
    return step


def probe(name, kind):
    return {"name": name, "probe": kind}


def probes(label, *kinds):
    return [probe(f"probe {k} {label}", k) for k in kinds]


ALL = ("counts", "imports_raw", "transactions", "rules", "expenses", "candidates", "liabilities", "ledger")

steps = [
    get("settings start at defaults", "/api/smart-import/settings"),
    send("put empty settings is a no-op", "PUT", "/api/smart-import/settings", {}),
    probe("probe counts after empty put", "counts"),
    send("put bad retention refused", "PUT", "/api/smart-import/settings", {"retention_months": 7}),
    send("put unknown settings key refused", "PUT", "/api/smart-import/settings", {"theme": "dark"}),
    send("put retention 12", "PUT", "/api/smart-import/settings", {"retention_months": 12}),
    get("context before any import", "/api/smart-import/context"),
    send("preview before any import", "POST", "/api/smart-import/preview", preview_of(ST_A, ST_C1)),
    send("apply A and card statement", "POST", "/api/smart-import/apply", BATCH1,
         save={"A": "imports.0.import_id", "C1": "imports.1.import_id"}),
    *probes("after apply A", *ALL),
    send("preview after apply A", "POST", "/api/smart-import/preview", preview_of(ST_A, ST_C1, ST_B)),
    send("re-apply same batch is skipped by file hash", "POST", "/api/smart-import/apply", BATCH1),
    probe("probe counts after re-apply", "counts"),
    send("apply overlapping B", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-3", "statements": [ST_B],
        "rules": [
            {"merchant_key": "NETFLIX", "category_id": "cat-dining", "kind": "expense", "source": "ai"},
            {"merchant_key": "GYMCLUB", "category_id": "cat-other", "kind": "expense", "source": "import"},
        ],
        "recurring": [],
    }, save={"B": "imports.0.import_id"}),
    *probes("after apply B", "counts", "transactions", "rules", "ledger"),
    get("imports after apply B", "/api/smart-import/imports"),
    send("apply one file with two statements (hash split)", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-4",
        "statements": [
            stmt(D, "acct:sav", "savings", [
                txn("acct:sav", "2026-09-06", 200, "FROM CHECKING", kind="transfer"),
                txn("acct:sav", "2026-09-30", 1.25, "INTEREST PAID", kind="income"),
            ], fmt="ofx", label="Savings", last4="9012"),
            stmt(D, "acct:card", "credit_card", [
                txn("acct:card", "2026-08-30", -25, "BOOKSHOP", category="cat-other"),
            ], fmt="ofx", closing={"amount": 700, "as_of": "2026-09-01"}, liability="L-card", label="Visa",
                last4="5678"),
        ],
        "rules": [], "recurring": [],
    }, save={"D0": "imports.0.import_id", "D1": "imports.1.import_id"}),
    probe("probe imports_raw after hash split", "imports_raw"),
    get("imports after hash split", "/api/smart-import/imports"),
    send("preview finds both statements of the split file", "POST", "/api/smart-import/preview",
         preview_of(stmt(D, "acct:card", "credit_card", []))),
    send("apply snapshots: older day, negative, future, no debt", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-5",
        "statements": [
            stmt(E, "acct:card", "credit_card", [
                txn("acct:card", "2026-08-20", -55, "HARDWARE", category="cat-other"),
            ], closing={"amount": 600, "as_of": "2026-08-25"}, liability="L-card", label="Visa", last4="5678"),
            stmt(F, "acct:card", "credit_card", [], closing={"amount": -20, "as_of": "2026-09-20"},
                 liability="L-card", label="Visa", last4="5678"),
            stmt(G, "acct:card", "credit_card", [], closing={"amount": 300, "as_of": "2026-10-10"},
                 liability="L-card", label="Visa", last4="5678"),
            stmt(H, "acct:chk2", "checking", [], closing={"amount": 1000, "as_of": "2026-09-30"},
                 label="Bills", last4="4321"),
        ],
        "rules": [], "recurring": [],
    }),
    *probes("after snapshots", "liabilities", "ledger"),
    send("link to an inactive expense is refused", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6",
        "statements": [stmt(X, "acct:chk", "checking", [txn(CHK, "2026-09-29", -45, "GYMCLUB", category="cat-other")])],
        "rules": [],
        "recurring": [{"merchant_key": "GYMCLUB", "name": "Gym", "amount": 45, "frequency": "monthly",
                       "category_id": "cat-other", "occurrences": 2, "file_hash": X, "decision": "link",
                       "expense_id": "E-gym"}],
    }),
    probe("probe counts after refused link", "counts"),
    send("apply with unknown rule category", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6", "statements": [stmt(X, "acct:chk", "checking", [])],
        "rules": [{"merchant_key": "GYMCLUB", "category_id": "cat-missing", "kind": "expense"}], "recurring": [],
    }),
    send("apply with unknown liability", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6",
        "statements": [stmt(X, "acct:card", "credit_card", [], closing={"amount": 1, "as_of": "2026-09-01"},
                            liability="L-missing")],
        "rules": [], "recurring": [],
    }),
    send("apply with a bad date", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6",
        "statements": [stmt(X, "acct:chk", "checking", [dict(txn(CHK, "2026-09-29", -1, "X"), posted_date="2026-9-29")])],
        "rules": [], "recurring": [],
    }),
    send("apply with an extra key", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6", "statements": [], "rules": [], "recurring": [], "extra": True,
    }),
    send("apply with a string ai_confidence", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6",
        "statements": [stmt(X, "acct:chk", "checking", [dict(txn(CHK, "2026-09-29", -1, "X"), ai_confidence="0.5")])],
        "rules": [], "recurring": [],
    }),
    send("apply with a string recurring amount", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6", "statements": [stmt(X, "acct:chk", "checking", [])], "rules": [],
        "recurring": [{"merchant_key": "GYMCLUB", "name": "Gym", "amount": "45", "frequency": "monthly",
                       "category_id": "cat-other", "occurrences": 2, "file_hash": X, "decision": "create"}],
    }),
    send("apply with string occurrences", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-6", "statements": [stmt(X, "acct:chk", "checking", [])], "rules": [],
        "recurring": [{"merchant_key": "GYMCLUB", "name": "Gym", "amount": 45, "frequency": "monthly",
                       "category_id": "cat-other", "occurrences": "2", "file_hash": X, "decision": "create"}],
    }),
    send("preview with a bad hash", "POST", "/api/smart-import/preview", {"statements": [
        {"file_hash": "not a hash", "account_key": None, "account_kind": "checking", "institution": None,
         "dedupe_keys": [], "merchant_keys": []}]}),
    probe("probe counts after refused requests", "counts"),
    get("context after imports", "/api/smart-import/context"),
    get("spending summary three months", "/api/budget/spending-summary?months=3"),
    get("spending summary for another entity", "/api/budget/spending-summary?months=3&entity_id=ent-other"),
    get("spending summary bad months", "/api/budget/spending-summary?months=0"),
    get("spending summary unknown query", "/api/budget/spending-summary?months=3&foo=1"),
    {"name": "edit the created Spotify expense", "db": "edit_expense", "expense_name": "Spotify", "amount": 11.99},
    send("undo A hands its overlap to B", "DELETE", "/api/smart-import/imports/{A}"),
    *probes("after undo A", "counts", "imports_raw", "transactions", "expenses", "candidates", "ledger"),
    get("imports after undo A", "/api/smart-import/imports"),
    send("undo card statement restores the balance", "DELETE", "/api/smart-import/imports/{C1}"),
    probe("probe liabilities after undo card", "liabilities"),
    get("spending summary after undo A and card", "/api/budget/spending-summary?months=3"),
    send("undo B", "DELETE", "/api/smart-import/imports/{B}"),
    *probes("after undo B", "counts", "transactions", "rules", "expenses"),
    send("undo B again", "DELETE", "/api/smart-import/imports/{B}"),
    send("undo an unknown import", "DELETE", "/api/smart-import/imports/no-such-import"),
    {"name": "insert a legacy statement import", "db": "insert_legacy_import", "id": "legacy-1",
     "content_hash": "legacy-hash", "file_name": "legacy.csv"},
    send("undo a legacy import", "DELETE", "/api/smart-import/imports/legacy-1"),
    send("preview sees the legacy file", "POST", "/api/smart-import/preview", {"statements": [
        {"file_hash": "legacy-hash", "account_key": None, "account_kind": "checking", "institution": None,
         "dedupe_keys": [], "merchant_keys": []}]}),
    send("apply prunes old rows except the sample", "POST", "/api/smart-import/apply", {
        "batch_id": "batch-7",
        "statements": [
            stmt(OLD, "acct:old", "checking", [
                txn("acct:old", "2025-06-10", -10, "OLDSHOP", category="cat-other"),
                txn("acct:old", "2025-06-11", -11, "OLDSHOP", category="cat-other"),
                txn("acct:old", "2025-11-15", -5, "RECENTSHOP", category="cat-other"),
            ], period={"start": "2025-05-01", "end": "2025-11-30"}, label="Old", last4="1111"),
            stmt(SAMPLE, "acct:sample", "checking", [
                txn("acct:sample", "2025-06-12", -12, "SAMPLESHOP", category="cat-groceries"),
            ], origin="sample", period={"start": "2025-06-01", "end": "2025-06-30"}, label="Sample", last4="0000"),
        ],
        "rules": [], "recurring": [],
    }),
    probe("probe transactions after prune", "transactions"),
    get("spending summary after prune", "/api/budget/spending-summary?months=24"),
    send("delete all imported transactions", "DELETE", "/api/smart-import/transactions"),
    *probes("after delete all", "counts", "transactions"),
    get("spending summary after delete all", "/api/budget/spending-summary?months=24"),
    get("rules list", "/api/smart-import/rules", save={"R0": "0.id"}),
    send("delete first rule", "DELETE", "/api/smart-import/rules/{R0}"),
    send("delete first rule again", "DELETE", "/api/smart-import/rules/{R0}"),
    get("rules after delete", "/api/smart-import/rules"),
    send("put ai and account label", "PUT", "/api/smart-import/settings",
         {"ai_enabled": True, "accounts": {"acct:sav": "Rainy Day"}}),
    send("put empty settings keeps everything", "PUT", "/api/smart-import/settings", {}),
    get("settings at the end", "/api/smart-import/settings"),
    get("context at the end", "/api/smart-import/context"),
    probe("probe counts at the end", "counts"),
    # Plan B3: statements synced from a connection carry its connection_id.
    send("apply a synced statement before any connection exists", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-0", "statements": [synced(S1, "acct:conn-chk", "checking", [])],
        "rules": [], "recurring": [],
    }),
    {"name": "store a connection", "db": "store_connections", "value": CONNECTIONS_DOC},
    send("apply a synced statement without connection_id", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-0", "statements": [synced(S1, "acct:conn-chk", "checking", [], cid=None)],
        "rules": [], "recurring": [],
    }),
    send("apply a file statement with connection_id", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-0", "statements": [dict(stmt(S1, "acct:chk", "checking", []), connection_id=CONN)],
        "rules": [], "recurring": [],
    }),
    send("apply a sample statement with connection_id", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-0",
        "statements": [dict(stmt(S1, "acct:chk", "checking", [], origin="sample"), connection_id=CONN)],
        "rules": [], "recurring": [],
    }),
    send("apply a synced statement with an unknown connection", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-0",
        "statements": [synced(S1, "acct:conn-chk", "checking", [], cid=OTHER_CONN)],
        "rules": [], "recurring": [],
    }),
    probe("probe counts after refused syncs", "counts"),
    send("apply a sync: balance dated tomorrow, two days ahead, checking", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-1",
        "statements": [
            synced(S1, "acct:conn-card", "credit_card", [
                txn("acct:conn-card", "2026-10-01", -18.5, "CAFE", category="cat-dining"),
            ], closing={"amount": 410, "as_of": "2026-10-05"}, liability="L-card",
                period={"start": "2026-09-05", "end": "2026-10-04"}),
            synced(S2, "acct:conn-card2", "credit_card", [],
                   closing={"amount": 90, "as_of": "2026-10-06"}, liability="L-card",
                   period={"start": "2026-09-05", "end": "2026-10-04"}),
            synced(S3, "acct:conn-chk", "checking", [
                txn("acct:conn-chk", "2026-09-30", 3000, "PAYROLL", kind="income"),
                txn("acct:conn-chk", "2026-10-02", -64.2, "GROCER", category="cat-groceries"),
            ], closing={"amount": 2500, "as_of": "2026-10-05"},
                period={"start": "2026-09-05", "end": "2026-10-04"}),
        ],
        "rules": [{"merchant_key": "CAFE", "category_id": "cat-dining", "kind": "expense", "source": "connector"}],
        "recurring": [],
    }, save={"SY1": "imports.0.import_id", "SY2": "imports.1.import_id", "SY3": "imports.2.import_id"}),
    *probes("after sync", "counts", "transactions", "rules", "liabilities", "ledger"),
    get("imports after sync", "/api/smart-import/imports"),
    send("re-apply the same sync is skipped by file hash", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-2",
        "statements": [synced(S3, "acct:conn-chk", "checking", [
            txn("acct:conn-chk", "2026-09-30", 3000, "PAYROLL", kind="income"),
        ])],
        "rules": [], "recurring": [],
    }),
    send("undo the synced card statement", "DELETE", "/api/smart-import/imports/{SY1}"),
    *probes("after undo synced card", "counts", "liabilities", "ledger"),
    send("undo the synced card statement dated two days ahead", "DELETE", "/api/smart-import/imports/{SY2}"),
    send("undo the synced checking statement", "DELETE", "/api/smart-import/imports/{SY3}"),
    *probes("after undo sync", "counts", "transactions", "rules"),
    get("imports after undo sync", "/api/smart-import/imports"),
    # Plan B4: disconnect, keeping the imported data, then a second connection
    # disconnected with remove_data (design 8.6).
    {"name": "store a secret for the connection", "db": "store_connection_secret", "id": CONN},
    probe("probe connections before disconnect", "connections"),
    send("apply a sync before disconnect", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-3",
        "statements": [synced(K1, "acct:conn-chk", "checking", [
            txn("acct:conn-chk", "2026-09-30", 3000, "PAYROLL", kind="income"),
            txn("acct:conn-chk", "2026-10-02", -64.2, "GROCER", category="cat-groceries"),
        ], period={"start": "2026-09-05", "end": "2026-10-04"})],
        "rules": [], "recurring": [],
    }, save={"P1": "imports.0.import_id"}),
    send("apply an overlapping sync before disconnect", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-4",
        "statements": [synced(K2, "acct:conn-chk", "checking", [
            txn("acct:conn-chk", "2026-10-02", -64.2, "GROCER", category="cat-groceries"),
            txn("acct:conn-chk", "2026-10-03", -12.5, "CAFE", category="cat-dining"),
        ], period={"start": "2026-09-28", "end": "2026-10-04"})],
        "rules": [], "recurring": [],
    }, save={"P2": "imports.0.import_id"}),
    send("disconnect with an unrecognised remove_data", "DELETE", f"/api/connections/{CONN}?remove_data=maybe"),
    send("disconnect an unknown connection", "DELETE", f"/api/connections/{OTHER_CONN}"),
    send("disconnect keeping the imported data", "DELETE", f"/api/connections/{CONN}"),
    *probes("after disconnect", "counts", "connections"),
    get("imports after disconnect", "/api/smart-import/imports"),
    send("disconnect the removed connection again", "DELETE", f"/api/connections/{CONN}?remove_data=true"),
    send("a sync for the removed connection is refused", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-5", "statements": [synced(K6, "acct:conn-chk", "checking", [])],
        "rules": [], "recurring": [],
    }),
    send("undo a sync of the removed connection", "DELETE", "/api/smart-import/imports/{P2}"),
    probe("probe counts after undo of a removed connection's sync", "counts"),
    {"name": "store a second connection", "db": "store_connections", "value": SECOND_DOC},
    {"name": "store a secret for the second connection", "db": "store_connection_secret", "id": OTHER_CONN},
    probe("probe connections with the second connection", "connections"),
    send("apply a card sync of the second connection", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-6",
        "statements": [synced(K3, "acct:conn2-card", "credit_card", [
            txn("acct:conn2-card", "2026-09-12", -9.99, "STREAMCO", category="cat-other"),
            txn("acct:conn2-card", "2026-09-20", -31, "BOOKSHOP", category="cat-other"),
        ], cid=OTHER_CONN, closing={"amount": 450, "as_of": "2026-10-03"}, liability="L-card",
            period={"start": "2026-09-05", "end": "2026-10-03"})],
        "rules": [{"merchant_key": "STREAMCO", "category_id": "cat-other", "kind": "expense", "source": "connector"}],
        "recurring": [{"merchant_key": "STREAMCO", "name": "Streamco", "amount": 9.99, "frequency": "monthly",
                       "category_id": "cat-other", "occurrences": 2, "file_hash": K3, "decision": "create"}],
    }, save={"Q1": "imports.0.import_id"}),
    send("apply a checking sync of the second connection", "POST", "/api/smart-import/apply", {
        "batch_id": "sync-7",
        "statements": [synced(K4, "acct:conn2-chk", "checking", [
            txn("acct:conn2-chk", "2026-09-15", -40, "PHARMACY", category="cat-other"),
            txn("acct:conn2-chk", "2026-09-16", -22, "BAKERY", category="cat-groceries"),
        ], cid=OTHER_CONN, period={"start": "2026-09-05", "end": "2026-10-03"})],
        "rules": [], "recurring": [],
    }, save={"Q2": "imports.0.import_id"}),
    send("a file import overlaps the second connection's sync", "POST", "/api/smart-import/apply", {
        "batch_id": "file-9",
        "statements": [stmt(K5, "acct:conn2-chk", "checking", [
            txn("acct:conn2-chk", "2026-09-15", -40, "PHARMACY", category="cat-other"),
        ], label="Second", last4="2468")],
        "rules": [], "recurring": [],
    }),
    {"name": "edit the expense the second connection created", "db": "edit_expense", "expense_name": "Streamco",
     "amount": 10.99},
    *probes("before disconnect with remove_data", "counts", "liabilities", "ledger"),
    send("disconnect and remove imported data", "DELETE", f"/api/connections/{OTHER_CONN}?remove_data=true"),
    *probes("after disconnect with remove_data", "counts", "transactions", "rules", "expenses", "liabilities",
            "ledger", "connections"),
    get("imports after disconnect with remove_data", "/api/smart-import/imports"),
    send("disconnect and remove data again", "DELETE", f"/api/connections/{OTHER_CONN}?remove_data=true"),
]

scenario = {
    "today": "2026-10-04",
    "setup": {
        "categories": [
            {"id": "cat-groceries", "name": "Groceries", "sort_order": 0},
            {"id": "cat-dining", "name": "Dining", "sort_order": 1},
            {"id": "cat-debt", "name": "Debt Payments", "sort_order": 2},
            {"id": "cat-other", "name": "Other", "sort_order": 3},
        ],
        "liabilities": [
            {"id": "L-archived", "name": "Alpha Card", "liability_type": "credit_card", "lender": "Sample Bank",
             "current_balance": 0, "balance_as_of": "2026-01-01", "is_active": False},
            {"id": "L-card", "name": "Visa", "liability_type": "credit_card", "lender": "Sample Bank",
             "current_balance": 500, "balance_as_of": "2026-09-01", "is_active": True},
        ],
        "snapshots": [
            {"id": "S-manual", "liability_id": "L-card", "snapshot_date": "2026-09-01", "balance": 500,
             "source": "manual"},
        ],
        "expenses": [
            {"id": "E-netflix", "category_id": "cat-dining", "name": "Netflix", "amount": 15.49,
             "frequency": "monthly", "is_active": True},
            {"id": "E-gym", "category_id": "cat-other", "name": "Gym", "amount": 45, "frequency": "monthly",
             "is_active": False},
        ],
    },
    "steps": steps,
}

OUT = Path(__file__).resolve().parent / "smart_import_scenario.json"


def render() -> str:
    return json.dumps(scenario, indent=1) + "\n"


if __name__ == "__main__":
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    out.write_text(render())
    print(len(steps), "steps")
