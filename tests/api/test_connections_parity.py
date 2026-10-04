"""Server half of the connections parity scenario (plan B7, design 13).

Runs tests/fixtures/connections_scenario.json through FastAPI against a temp
database and compares the normalized results with
tests/fixtures/connections_scenario.expected.json. The browser half is
src/web/test/api/connections-parity.test.ts; both must match the same file
(money within 0.01, everything else exact, error_type and detail included).

The server run also records what the browser composites need from the
stateless core: for every step, each provider call the service made, turned
into the v2 request the browser sends (rule ids left out, see below) and the
real v2 route's answer to it (tests/fixtures/connections_scenario.v2.json).
For a sync, the v2 answer must equal the connections route's answer, so the
service and the v2 route agree before the browser replays it.

Only the demo provider is called successfully. The transport is a
MockTransport, so nothing can reach a network: it answers 401 to a SimpleFIN
accounts request made with the scenario's one pasted Access URL (the reconnect
that must verify before it stores) and refuses every other request; the demo
never asks for one.

Regenerate both files from the server path (then review them by hand):
    python tests/fixtures/build_connections_scenario.py
    WRITE_CONNECTIONS_PARITY_EXPECTED=1 python -m pytest tests/api/test_connections_parity.py
"""

from __future__ import annotations

import base64
import importlib.util
import json
import os
import re
import socket
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from src.api.dependencies import get_db
from src.api.v2 import connectors as v2_connectors
from src.api.v2.connectors import transport_factory
from src.connectors.errors import CONNECTOR_ERRORS
from src.connectors import service as connection_service
from src.connectors import store as connection_store
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
from src.smart_import.errors import ERROR_CATALOG
from tests.connectors.apply_contract import as_apply

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"
SCENARIO_PATH = FIXTURES / "connections_scenario.json"
SCENARIO = json.loads(SCENARIO_PATH.read_text())
EXPECTED_PATH = FIXTURES / "connections_scenario.expected.json"
V2_PATH = FIXTURES / "connections_scenario.v2.json"
# The pasted Access URL the transport answers 401 (the builder's REFUSED_ACCESS_URL).
REFUSED_USER = "parity-user"
REFUSED_HOST = "bridge.simplefin.org"
CREDENTIAL_FIELDS = ("access_url", "user_token", "app_token")
WRITE = bool(os.environ.get("WRITE_CONNECTIONS_PARITY_EXPECTED"))

# Ids minted by either path become ordered placeholders; the scenario's own
# ids stay. `ids` is the connections probe's list.
ID_KEYS = {
    "id", "import_id", "liability_id", "expense_id", "created_expense_id", "last_import_id", "target_id",
    "source_ref", "connection_id", "ids",
}
# Wall-clock stamps differ between the paths (each pins its own clock); only
# whether one is set is compared. Dates (next_since, windows, posted dates,
# snapshot dates) follow the pinned `today` and are compared exactly.
TIMESTAMP_KEYS = {
    "created_at", "updated_at", "imported_at", "analyzed_at", "uploaded_at",
    "status_at", "last_synced_at", "quota_resets_at",
}


def _fixed_ids() -> set[str]:
    setup = SCENARIO["setup"]
    fixed = {row["id"] for key in ("categories", "liabilities", "snapshots", "expenses") for row in setup[key]}
    fixed |= {step["id"] for step in SCENARIO["steps"] if step.get("db") == "put_connection"}
    return fixed


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


def v2_request(body: dict[str, Any]) -> dict[str, Any]:
    """A v2 request as the transport file keeps it: rule ids are left out.

    Allowlisted divergence `rule-ids`: each path mints its own merchant rule
    ids, and the v2 core never reads them (seed_rules.apply_rules matches on
    merchant_key), so the browser's request is compared without them.
    """
    out = json.loads(json.dumps(body))
    rules = out.get("context", {}).get("rules")
    if isinstance(rules, list):
        out["context"]["rules"] = [{k: v for k, v in r.items() if k != "id"} for r in rules]
    return out


class Clocks:
    """The pinned `today` and the service and store clocks (UTC), one second
    per step, like the browser harness's fake Date."""

    def __init__(self, today: str) -> None:
        self.set(today)

    def set(self, day: str) -> None:
        self.today = date.fromisoformat(day)
        self.now = datetime.combine(self.today, datetime.min.time(), tzinfo=timezone.utc) + timedelta(hours=9)

    def tick(self) -> None:
        self.now += timedelta(seconds=1)


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


def _day(value: Any) -> Any:
    return value.isoformat()[:10] if isinstance(value, (date, datetime)) else value


def _stored_order(doc: dict[str, Any]) -> list[tuple[str, dict[str, Any]]]:
    """Connections in list order: (created_at, id)."""
    return sorted(doc["items"].items(), key=lambda kv: (kv[1]["created_at"], kv[0]))


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
            return {name: s.query(model).count() for name, model in tables.items()}
        if kind == "transaction_counts":
            counts: dict[str, int] = {}
            for (key,) in s.query(ImportTransaction.account_key):
                counts[key] = counts.get(key, 0) + 1
            return counts
        if kind == "liabilities":
            out = []
            for liability in sorted(s.query(Liability), key=lambda x: x.id):
                snaps = s.query(LiabilityBalanceSnapshot).filter_by(liability_id=liability.id)
                out.append({
                    "id": liability.id,
                    "current_balance": liability.current_balance,
                    "balance_as_of": _day(liability.balance_as_of),
                    "snapshots": sorted(
                        ({"snapshot_date": _day(x.snapshot_date), "balance": x.balance, "source": x.source}
                         for x in snaps),
                        key=lambda r: r["snapshot_date"],
                    ),
                })
            return out
        if kind == "connections":
            doc = connection_store.read_connections(None, session=s)
            secrets = s.query(AppSettings).filter(AppSettings.key.like("connection_secret:%")).count()
            return {"ids": [cid for cid, _ in _stored_order(doc)], "secret_rows": secrets}
        if kind == "requests":
            # The request history the quota counts (the last 24 hours).
            doc = connection_store.read_connections(None, session=s)
            return [{"connection_id": cid, "requests": len(c["requests"])} for cid, c in _stored_order(doc)]
        raise AssertionError(kind)


def _stamp(when: datetime) -> str:
    return when.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _db_op(db: Database, step: dict[str, Any], now: datetime) -> None:
    if step["db"] != "put_connection":
        raise AssertionError(step["db"])
    count = step["recent_requests"]
    entry = {**step["entry"], "requests": [_stamp(now - timedelta(minutes=count - i)) for i in range(count)]}
    with db.get_session() as s:
        row = s.query(AppSettings).filter_by(key="connections").first()
        doc = json.loads(row.value) if row is not None else {"version": 1, "items": {}}
        doc["items"][step["id"]] = entry
        if row is None:
            s.add(AppSettings(key="connections", value=json.dumps(doc), encrypted=False))
        else:
            row.value = json.dumps(doc)
        s.commit()


def apply_body(spec: dict[str, Any], saved: dict[str, Any], aliases: dict[str, str]) -> dict[str, Any]:
    """The Apply request the wizard sends for a saved sync answer."""
    statements = []
    for st in saved[spec["sync"]]["statements"]:
        out = as_apply(st, connection_id=aliases[spec["connection"]])
        out["liability_id"] = spec["liabilities"].get(st["account"]["key"])
        statements.append(out)
    return {"batch_id": spec["batch_id"], "statements": statements, "rules": spec.get("rules", []), "recurring": []}


def _pick(body: Any, dotted: str) -> Any:
    for part in dotted.split("."):
        body = body[int(part)] if isinstance(body, list) else body[part]
    return body


class Recorder:
    """The provider calls the service makes during one step, as v2 requests."""

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []
        # The request body of the current step: a pasted credential's v2
        # request carries the credential the step sent.
        self.step_body: Any = None

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        real_call = connection_service._provider_call
        real_map = connection_service.to_statements

        real_claim = connection_service._claim

        def provider_call(event, connection_id, provider, factory, deadline, call):  # type: ignore[no-untyped-def]
            # The demo lists and syncs with v2 credentials {}; any other
            # provider is called only to verify a pasted credential before a
            # reconnect stores it. A claim is recorded by claim() below.
            if event != "claim":
                credentials: dict[str, Any] = {}
                if provider.id != "demo":
                    assert event == "accounts" and isinstance(self.step_body, dict), (provider.id, event)
                    credentials = {k: v for k, v in self.step_body.items() if k in CREDENTIAL_FIELDS}
                self.calls.append(
                    {"event": event, "path": f"{provider.id}/{event}", "body": {"credentials": credentials}}
                )
            return real_call(event, connection_id, provider, factory, deadline, call)

        def claim(connection_id, provider, setup_token, factory, deadline):  # type: ignore[no-untyped-def]
            self.calls.append({"event": "claim", "path": "simplefin/claim", "body": {"setup_token": setup_token}})
            return real_claim(connection_id, provider, setup_token, factory, deadline)

        def to_statements(provider_id, fetched, requests, window, context, *, now):  # type: ignore[no-untyped-def]
            self.calls[-1]["body"].update({
                "start": window[0].isoformat(),
                "end": window[1].isoformat(),
                "accounts": [
                    {"provider_account_id": r.provider_account_id, "since": r.since.isoformat(),
                     "account_key": r.account_key, "kind": r.kind, "flip_balance": r.flip_balance}
                    for r in requests
                ],
                "context": {"rules": context["rules"], "categories": context["categories"]},
            })
            return real_map(provider_id, fetched, requests, window, context, now=now)

        monkeypatch.setattr(connection_service, "_provider_call", provider_call)
        monkeypatch.setattr(connection_service, "to_statements", to_statements)
        monkeypatch.setattr(connection_service, "_claim", claim)

    def take(self) -> list[dict[str, Any]]:
        calls, self.calls = self.calls, []
        return calls


def run_scenario(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    for name in (
        "DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA", "CONNECTORS_ENABLED", "CONNECTORS_SIMPLEFIN_EXTRA_HOSTS",
        "RATE_LIMIT_ENABLED", "RATE_LIMIT_SECRET_KEY",
    ):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("PORTFOLIO_TEST_MODE", "true")
    # A usable Fernet key (store.check_key runs before a claim) that touches
    # no real key file, and no sockets at all.
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("SECRET_KEY", Fernet.generate_key().decode())

    def no_network(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError("the parity scenario must not open a socket")

    monkeypatch.setattr(socket, "getaddrinfo", no_network)
    monkeypatch.setattr(socket, "create_connection", no_network)
    clocks = Clocks(SCENARIO["today"])
    monkeypatch.setattr("src.liabilities.clock.today", lambda: clocks.today)
    monkeypatch.setattr(connection_service, "utcnow", lambda: clocks.now)
    monkeypatch.setattr(connection_store, "_utcnow", lambda: clocks.now)
    # The service and the v2 route pass their clocks to the core's
    # future-balance check; both are pinned, so the expected file does not
    # depend on the real date.
    monkeypatch.setattr(v2_connectors, "utcnow", lambda: clocks.now)
    attempts: list[str] = []
    answered: list[str] = []

    def refuse(request: httpx.Request) -> httpx.Response:
        auth = request.headers.get("authorization", "")
        user = base64.b64decode(auth.split()[-1]).decode().split(":")[0] if auth.startswith("Basic ") else None
        if request.url.host == REFUSED_HOST and request.url.path.endswith("/accounts") and user == REFUSED_USER:
            answered.append(request.url.path)
            return httpx.Response(401, json={})
        attempts.append(request.url.host)
        raise AssertionError("the parity scenario must not reach a network")

    db = Database(str(tmp_path / "parity.db"))
    _seed(db)
    app.dependency_overrides[get_db] = lambda: db
    app.dependency_overrides[transport_factory] = lambda: (lambda _pid: httpx.MockTransport(refuse))
    recorder = Recorder()
    recorder.install(monkeypatch)
    client = TestClient(app, raise_server_exceptions=False)
    norm = Normalizer()
    aliases: dict[str, str] = {}
    saved: dict[str, Any] = {}
    results: list[dict[str, Any]] = []
    v2: dict[str, Any] = {"status": None, "calls": {}}
    try:
        status = client.get("/api/v2/connectors/status")
        assert status.status_code == 200
        v2["status"] = status.json()
        for step in SCENARIO["steps"]:
            clocks.tick()
            if "clock" in step:
                clocks.set(step["clock"])
                results.append({"name": step["name"], "ok": "done"})
                continue
            if "db" in step:
                _db_op(db, step, clocks.now)
                results.append({"name": step["name"], "ok": "done"})
                continue
            if "probe" in step:
                results.append({"name": step["name"], "ok": norm(_probe(db, step["probe"]))})
                continue
            if "apply_sync" in step:
                method, path = "POST", "/api/smart-import/apply"
                body: Any = apply_body(step["apply_sync"], saved, aliases)
            else:
                method = step["method"]
                path = re.sub(r"\{(\w+)\}", lambda m: aliases[m.group(1)], step["path"])
                body = step.get("body")
            recorder.step_body = body
            resp = client.request(method, path, json=body) if body is not None else client.request(method, path)
            answer = resp.json()
            calls = recorder.take()
            if calls:
                v2["calls"][step["name"]] = [_replay_v2(client, call, answer) for call in calls]
            if resp.status_code >= 400:
                results.append({
                    "name": step["name"], "error": resp.status_code,
                    "error_type": answer.get("error_type"), "detail": answer.get("detail"),
                })
                continue
            for alias, dotted in step.get("save", {}).items():
                aliases[alias] = _pick(answer, dotted)
            if "save_body" in step:
                saved[step["save_body"]] = answer
            results.append({"name": step["name"], "ok": norm(answer)})
    finally:
        app.dependency_overrides.pop(get_db, None)
        app.dependency_overrides.pop(transport_factory, None)
    assert attempts == []
    # The pasted reconnect once, then its replay through the v2 route.
    assert len(answered) == 2, answered
    return results, v2


def _replay_v2(client: TestClient, call: dict[str, Any], route_answer: Any) -> dict[str, Any]:
    """Send the call to the real v2 route; a sync answer must equal the
    connections route's answer, which the browser gets from v2."""
    resp = client.post(f"/api/v2/connectors/{call['path']}", json=call["body"])
    if call["event"] == "claim":
        # Only refused claims happen here (a good one would need a network).
        assert resp.status_code >= 400 and resp.json()["error_type"] == route_answer["error_type"]
    elif call["event"] == "accounts" and route_answer.get("accounts_error"):
        # A pasted credential the provider refused: the route reports the v2 error.
        assert resp.status_code >= 400 and resp.json()["error_type"] == route_answer["accounts_error"]
    else:
        assert resp.status_code == 200, (call["path"], resp.json())
    if call["event"] == "sync":
        assert resp.json() == route_answer, "the service's sync differs from the v2 sync"
    return {
        "path": call["path"], "request": v2_request(call["body"]), "status": resp.status_code, "response": resp.json(),
    }


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


def _dump(value: Any) -> str:
    return json.dumps(value, indent=1, sort_keys=True, ensure_ascii=True) + "\n"


def test_server_path_matches_expected(tmp_path, monkeypatch):
    results, v2 = run_scenario(tmp_path, monkeypatch)
    if WRITE:
        EXPECTED_PATH.write_text(_dump(results))
        V2_PATH.write_text(_dump(v2))
    expected = json.loads(EXPECTED_PATH.read_text())
    assert [r["name"] for r in results] == [e["name"] for e in expected]
    for actual, want in zip(results, expected):
        assert_matches(actual, want, want["name"])
    # The browser replays this file, so it must be what the server run records.
    assert json.loads(_dump(v2)) == json.loads(V2_PATH.read_text())


def _load_builder(name: str) -> Any:
    spec = importlib.util.spec_from_file_location(name, FIXTURES / f"{name}.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_scenario_file_is_what_the_builder_writes():
    assert _load_builder("build_connections_scenario").render() == SCENARIO_PATH.read_text()


def test_every_step_name_is_unique():
    names = [step["name"] for step in SCENARIO["steps"]]
    assert len(names) == len(set(names))


def test_minted_ids_are_normalized_and_stored_ones_kept():
    norm = Normalizer()
    minted = "9f8e7d6c-5b4a-4398-8776-655443322110"
    stored = next(iter(_fixed_ids() - {r["id"] for r in SCENARIO["setup"]["categories"]}))
    assert norm({"connection_id": minted, "id": minted, "ids": [minted, stored]}) == {
        "connection_id": "<id-1>", "id": "<id-1>", "ids": ["<id-1>", stored],
    }
    assert norm({"last_synced_at": "2026-10-04T09:00:00Z", "quota_resets_at": None}) == {
        "last_synced_at": "<ts>", "quota_resets_at": None,
    }


def test_v2_requests_leave_out_only_rule_ids():
    body = {"credentials": {}, "context": {"rules": [{"id": "r1", "merchant_key": "m", "kind": None}],
                                           "categories": [{"id": "c", "name": "C"}]}}
    assert v2_request(body) == {"credentials": {}, "context": {"rules": [{"merchant_key": "m", "kind": None}],
                                                               "categories": [{"id": "c", "name": "C"}]}}


DIVERGENCES = SCENARIO["divergences"]
# The smart import codes the connection routes and Apply raise.
SHARED_SMART_IMPORT_CODES = {"bad_request", "liability_not_found", "import_not_found", "save_failed"}


def test_every_connection_error_code_is_reached_or_explained():
    """No code is skipped silently: each one a step reaches, or a named reason."""
    codes = DIVERGENCES["error_codes"]
    server_codes = set(CONNECTOR_ERRORS) | SHARED_SMART_IMPORT_CODES
    assert {c for c, e in codes.items() if e["paths"] != "browser-only"} == server_codes
    reached = {r["error_type"] for r in json.loads(EXPECTED_PATH.read_text()) if "error" in r}
    assert reached <= set(codes), reached - set(codes)
    for name, entry in codes.items():
        assert entry["paths"] in {"both", "both-via-v2", "server-only", "browser-only"}, name
        assert entry["reached"] == (name in reached), name
        if not entry["reached"]:
            assert entry["why_not_reached"] and entry["covered_by"], name
        if entry["paths"] == "browser-only":
            assert name not in CONNECTOR_ERRORS and name not in ERROR_CATALOG, name
        else:
            assert (entry["status"], entry["detail"]) == (CONNECTOR_ERRORS.get(name) or ERROR_CATALOG[name]), name


def test_divergences_are_named_and_justified():
    allow = DIVERGENCES["allowlist"]
    assert [a["id"] for a in allow] == ["minted-ids", "wall-clock-stamps", "rule-ids", "v2-status-call"]
    for entry in allow + DIVERGENCES["known"]:
        assert entry["id"] and entry["handling"], entry
    known = [k["id"] for k in DIVERGENCES["known"]]
    assert len(known) == len(set(known))
    # The allowlisted stamp keys are exactly the ones normalized here.
    assert all(key in allow[1]["what"] for key in TIMESTAMP_KEYS)
