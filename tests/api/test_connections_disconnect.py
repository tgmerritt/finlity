"""Disconnect, with or without the imported data (design 8.6; plan B4, server path).

``DELETE /api/connections/{id}`` removes the connection's metadata entry and
its secret row in one transaction. Imports keep their ``connection_id`` (a
soft reference) and each can still be undone.

``?remove_data=true`` also undoes, in that same transaction and newest first,
every import whose ``smart_import_meta.connection_id`` is the id, through the
smart import undo itself (``undo_in_session``), so its keep rules hold. Any
failure rolls everything back: the connection, its secret and every import
stay, and the request can simply be repeated.
"""

from __future__ import annotations

import json
import logging
import socket
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

import pytest
from cryptography.fernet import Fernet
from fastapi import HTTPException

from src.connectors import service, store
from src.connectors.types import SimpleFinCredentials
from src.database.models import (
    AppSettings,
    BudgetExpense,
    ImportTransaction,
    Liability,
    LiabilityBalanceSnapshot,
    MerchantRule,
    SmartImportLedger,
    SmartImportMeta,
)
from src.smart_import import service as import_service
from tests.api.si_support import (  # noqa: F401  (fixtures)
    CONN_ID,
    add_connections,
    add_liability,
    apply_body,
    candidate,
    client,
    connection_entry,
    db,
    do_apply,
    statement,
    table_hashes,
    txn,
)

BASE = "/api/connections"
NOW = datetime(2026, 10, 4, 12, 0, 0, tzinfo=timezone.utc)
OTHER_ID = "11111111-2222-4333-8444-555555555555"
H = {name: ch * 64 for name, ch in (("s1", "1"), ("s2", "2"), ("s3", "3"), ("f1", "4"), ("o1", "5"))}

PLANT_USER = "zqdiscuser"
PLANT_PASS = "Zq9DiscPassw0rdPlanted"
ACCESS_BASE = "https://beta-bridge.simplefin.org/simplefin"
PLANT_NAME = "ZQ Disc Everyday"
PLANT_MERCHANT = "ZQXDISC WIDGETS"
PLANT_AMOUNT = "6543.21"
PLANTED = (PLANT_USER, PLANT_PASS, PLANT_NAME, PLANT_MERCHANT, PLANT_AMOUNT)


def _no_network(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("a disconnect test tried to use the network")


@pytest.fixture(autouse=True)
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> pytest.MonkeyPatch:
    monkeypatch.setattr(socket, "getaddrinfo", _no_network)
    monkeypatch.setattr(socket, "create_connection", _no_network)
    for name in ("DYNO", "MULTI_USER_MODE", "PROTECT_DEMO_DATA", "CONNECTORS_ENABLED"):
        monkeypatch.delenv(name, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    monkeypatch.setenv("SECRET_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(service, "utcnow", lambda: NOW)
    return monkeypatch


# --- helpers ------------------------------------------------------------------------


def _store(db: Any, *ids: str, secrets: bool = True) -> None:
    add_connections(db, {cid: connection_entry("simplefin") for cid in ids})
    if secrets:
        for cid in ids:
            store.save_secret(
                db,
                cid,
                SimpleFinCredentials(base_url=ACCESS_BASE, username=PLANT_USER, password=PLANT_PASS),
            )


def _secret_rows(db: Any) -> set[str]:
    with db.get_session() as s:
        return {
            k for (k,) in s.query(AppSettings.key).filter(AppSettings.key.like("connection_secret:%"))
        }


def _ids(db: Any) -> set[str]:
    return set(store.read_connections(db, now=NOW)["items"])


def _synced(file_hash: str, txns: list[dict[str, Any]], *, cid: str = CONN_ID, **kw: Any) -> dict[str, Any]:
    body = statement(file_hash, txns, origin="connector", connection_id=cid, **kw)
    body.update(format="connector", parser="connector:simplefin", file_name="Sync")
    return body


def _apply(client: Any, *statements: dict[str, Any], **kw: Any) -> list[str]:
    resp = do_apply(client, apply_body(list(statements), **kw))
    assert resp.status_code == 200, resp.text
    return [i["import_id"] for i in resp.json()["imports"]]


def _metas(db: Any) -> dict[str, str | None]:
    with db.get_session() as s:
        return {m.import_id: m.connection_id for m in s.query(SmartImportMeta)}


def _disconnect(client: Any, cid: str, remove_data: str | None = None) -> Any:
    path = f"{BASE}/{cid}" + (f"?remove_data={remove_data}" if remove_data is not None else "")
    return client.delete(path)


def _fixed(resp: Any, status: int, error_type: str) -> None:
    assert resp.status_code == status, resp.text
    body = resp.json()
    assert set(body) == {"error_type", "detail"}
    assert body["error_type"] == error_type
    for planted in PLANTED:
        assert planted not in resp.text


CHK = "acct:one"
CARD = "acct:card"


def _chk(posted: str, amount: float, merchant: str = "NETFLIX") -> dict[str, Any]:
    return txn(posted, amount, merchant, dedupe=f"{CHK}|{merchant}|{posted}|{amount}")


def _card(posted: str, amount: float, merchant: str = "BISTRO") -> dict[str, Any]:
    return txn(posted, amount, merchant, dedupe=f"{CARD}|{merchant}|{posted}|{amount}")


# --- plain disconnect ---------------------------------------------------------------


def test_disconnect_removes_the_secret_and_metadata_and_keeps_the_imports(client, db):
    _store(db, CONN_ID, OTHER_ID)
    first = _apply(client, _synced(H["s1"], [_chk("2026-09-03", -15.49)]))
    second = _apply(client, _synced(H["s2"], [_chk("2026-09-20", -20.0, "GROCER")]))
    before = table_hashes(db)

    resp = _disconnect(client, CONN_ID)
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "connection_id": CONN_ID,
        "remove_data": False,
        "imports_undone": 0,
        "imports_kept": 2,
        "deleted": {"transactions": 0, "recurring_candidates": 0, "expenses": 0, "snapshots": 0},
        "reassigned": {"transactions": 0},
        "kept": [],
    }
    assert _ids(db) == {OTHER_ID}
    assert _secret_rows(db) == {f"connection_secret:{OTHER_ID}"}
    # The other connection is untouched, its secret still decrypts.
    assert store.load_secret(db, OTHER_ID).username == PLANT_USER
    # Imports are untouched and keep the soft reference.
    assert table_hashes(db) == before
    assert _metas(db) == {first[0]: CONN_ID, second[0]: CONN_ID}
    listed = client.get("/api/smart-import/imports").json()
    assert {row["connection_id"] for row in listed} == {CONN_ID}
    # Each import can still be undone afterwards.
    for iid in first + second:
        resp = client.delete(f"/api/smart-import/imports/{iid}")
        assert resp.status_code == 200, resp.text
    assert _metas(db) == {}


def test_disconnect_explicit_false_is_the_plain_disconnect(client, db):
    _store(db, CONN_ID)
    _apply(client, _synced(H["s1"], [_chk("2026-09-03", -15.49)]))
    resp = _disconnect(client, CONN_ID, "false")
    assert resp.status_code == 200, resp.text
    assert resp.json()["imports_kept"] == 1
    assert len(_metas(db)) == 1
    assert _ids(db) == set()


def test_a_connection_without_a_secret_row_disconnects(client, db):
    _store(db, CONN_ID, secrets=False)  # the demo provider stores no secret
    resp = _disconnect(client, CONN_ID, "true")
    assert resp.status_code == 200, resp.text
    assert resp.json()["imports_undone"] == 0
    assert _ids(db) == set()


def test_disconnecting_twice_is_404_the_second_time(client, db):
    _store(db, CONN_ID)
    assert _disconnect(client, CONN_ID).status_code == 200
    _fixed(_disconnect(client, CONN_ID), 404, "connection_not_found")
    _fixed(_disconnect(client, CONN_ID, "true"), 404, "connection_not_found")


@pytest.mark.parametrize("cid", [OTHER_ID, CONN_ID.upper(), "connections", "not-a-uuid"])
def test_an_unknown_id_is_404_and_changes_nothing(client, db, cid):
    _store(db, CONN_ID)
    before = (_ids(db), _secret_rows(db), table_hashes(db))
    _fixed(_disconnect(client, cid), 404, "connection_not_found")
    _fixed(_disconnect(client, cid, "true"), 404, "connection_not_found")
    assert (_ids(db), _secret_rows(db), table_hashes(db)) == before


@pytest.mark.parametrize("value", ["maybe", "1", "yes", "True", ""])
def test_remove_data_accepts_only_true_or_false(client, db, value):
    _store(db, CONN_ID)
    _fixed(_disconnect(client, CONN_ID, value), 422, "bad_request")
    assert _ids(db) == {CONN_ID}


# --- remove imported data ------------------------------------------------------------


def test_remove_data_undoes_every_import_and_keeps_what_the_rules_keep(client, db):
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    _store(db, CONN_ID, OTHER_ID)
    # Older sync: checking, creates a Spotify expense that is then edited.
    older = _apply(
        client,
        _synced(H["s1"], [_chk("2026-09-03", -15.49), _chk("2026-09-15", -10.99, "SPOTIFY")]),
        rules=[{"merchant_key": "SPOTIFY", "category_id": "cat-Other", "kind": "expense", "source": "connector"}],
        recurring=[candidate("create", "SPOTIFY", file_hash=H["s1"], name="Spotify", amount=10.99,
                             category="cat-Other")],
    )[0]
    # Newer sync: card with a balance on the debt, creates an expense a debt then links to.
    newer = _apply(
        client,
        _synced(
            H["s2"],
            [_card("2026-09-14", -42.0), _card("2026-09-25", -12.0, "LOANFEE")],
            key=CARD,
            kind="credit_card",
            closing={"amount": 640.0, "as_of": "2026-09-25"},
            liability_id="L1",
        ),
        recurring=[candidate("create", "LOANFEE", file_hash=H["s2"], name="Loan fee", amount=12.0,
                             category="cat-Other")],
        batch="batch-2",
    )[0]
    # A file import that overlaps the older sync claims its NETFLIX row.
    file_id = _apply(client, statement(H["f1"], [_chk("2026-09-03", -15.49)]), batch="batch-3")[0]
    # Another connection's import is never touched.
    other = _apply(client, _synced(H["o1"], [_chk("2026-09-21", -7.0, "KIOSK")], cid=OTHER_ID),
                   batch="batch-4")[0]
    with db.get_session() as s:
        spotify = s.query(BudgetExpense).filter_by(name="Spotify").one()
        spotify.amount = 11.99
        loan_fee = s.query(BudgetExpense).filter_by(name="Loan fee").one()
        s.get(Liability, "L1").expense_id = loan_fee.id
        spotify_id, loan_fee_id = spotify.id, loan_fee.id
        s.commit()
    with db.get_session() as s:
        assert s.get(Liability, "L1").current_balance == 640.0
        rules_before = sorted(r.merchant_key for r in s.query(MerchantRule))

    resp = _disconnect(client, CONN_ID, "true")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["connection_id"] == CONN_ID
    assert body["remove_data"] is True
    assert body["imports_undone"] == 2
    assert body["imports_kept"] == 0
    assert body["deleted"] == {"transactions": 3, "recurring_candidates": 2, "expenses": 0, "snapshots": 1}
    assert body["reassigned"] == {"transactions": 1}
    # Newest first: the card sync's linked expense, then the checking sync's edited one.
    assert body["kept"] == [
        {"table": "budget_expenses", "id": loan_fee_id, "reason": "linked_to_debt"},
        {"table": "budget_expenses", "id": spotify_id, "reason": "edited"},
    ]

    assert _ids(db) == {OTHER_ID}
    assert _secret_rows(db) == {f"connection_secret:{OTHER_ID}"}
    assert _metas(db) == {file_id: None, other: OTHER_ID}
    with db.get_session() as s:
        # The claimed row was handed to the file import, not deleted.
        rows = {(t.import_id, t.merchant_key) for t in s.query(ImportTransaction)}
        assert rows == {(file_id, "NETFLIX"), (other, "KIOSK")}
        assert s.query(SmartImportLedger).filter(SmartImportLedger.import_id.in_([older, newer])).count() == 0
        # The debt balance is recomputed from what remains (the manual snapshot).
        debt = s.get(Liability, "L1")
        assert (debt.current_balance, debt.balance_as_of) == (500.0, date(2026, 9, 1))
        assert [x.source for x in s.query(LiabilityBalanceSnapshot).filter_by(liability_id="L1")] == ["manual"]
        # Kept expenses are still there; remembered merchants stay.
        assert {e.name for e in s.query(BudgetExpense)} == {"Spotify", "Loan fee"}
        assert sorted(r.merchant_key for r in s.query(MerchantRule)) == rules_before


def test_remove_data_undoes_newest_first(client, db, env):
    _store(db, CONN_ID)
    first = _apply(client, _synced(H["s1"], [_chk("2026-09-03", -15.49)]))[0]
    # A later sync of the same account overlaps: it claims the first sync's row.
    second = _apply(
        client,
        _synced(H["s2"], [_chk("2026-09-03", -15.49), _chk("2026-09-20", -20.0, "GROCER")]),
        batch="batch-2",
    )[0]
    # Two statements of one batch share created_at: insertion order decides.
    third, fourth = _apply(
        client,
        _synced(H["s3"], [_chk("2026-09-25", -3.0, "KIOSK")]),
        _synced(H["f1"], [_chk("2026-09-26", -4.0, "KIOSK")]),
        batch="batch-3",
    )
    seen: list[str] = []
    real = import_service.undo_in_session

    def spy(session: Any, import_id: str, now: datetime) -> dict[str, Any]:
        seen.append(import_id)
        return real(session, import_id, now)

    env.setattr(import_service, "undo_in_session", spy)
    resp = _disconnect(client, CONN_ID, "true")
    assert resp.status_code == 200, resp.text
    assert seen == [fourth, third, second, first]
    # The claim died with the newer sync, so nothing was handed over and nothing is left.
    assert resp.json()["reassigned"] == {"transactions": 0}
    assert resp.json()["deleted"]["transactions"] == 4
    with db.get_session() as s:
        assert s.query(ImportTransaction).count() == 0
    assert _metas(db) == {}


def test_a_failure_in_the_third_undo_rolls_back_the_first_two(client, db, env):
    _store(db, CONN_ID)
    ids = [
        _apply(client, _synced(h, [_chk(f"2026-09-0{i + 1}", -1.0 - i)]), batch=f"b{i}")[0]
        for i, h in enumerate((H["s1"], H["s2"], H["s3"]))
    ]
    before = (table_hashes(db), _ids(db), _secret_rows(db))
    calls: list[str] = []
    real = import_service.undo_in_session

    def third_fails(session: Any, import_id: str, now: datetime) -> dict[str, Any]:
        calls.append(import_id)
        if len(calls) == 3:
            raise RuntimeError(f"boom {PLANT_MERCHANT}")
        return real(session, import_id, now)

    env.setattr(import_service, "undo_in_session", third_fails)
    _fixed(_disconnect(client, CONN_ID, "true"), 500, "save_failed")
    assert calls == list(reversed(ids))
    # Nothing changed: the connection, its secret and all three imports stay.
    assert (table_hashes(db), _ids(db), _secret_rows(db)) == before
    assert store.load_secret(db, CONN_ID).password == PLANT_PASS

    # Retryable: once the cause is gone the same request succeeds.
    env.setattr(import_service, "undo_in_session", real)
    resp = _disconnect(client, CONN_ID, "true")
    assert resp.status_code == 200, resp.text
    assert resp.json()["imports_undone"] == 3
    assert _metas(db) == {} and _ids(db) == set() and _secret_rows(db) == set()


def test_a_corrupt_ledger_row_fails_the_whole_removal(client, db):
    """No mocking: an unreadable ledger row in the oldest import (undone last)."""
    add_liability(db, "L1", balance=500.0, as_of=date(2026, 9, 1))
    _store(db, CONN_ID)
    oldest = _apply(
        client,
        _synced(H["s1"], [_card("2026-09-14", -42.0)], key=CARD, kind="credit_card",
                closing={"amount": 640.0, "as_of": "2026-09-25"}, liability_id="L1"),
    )[0]
    _apply(client, _synced(H["s2"], [_chk("2026-09-20", -20.0, "GROCER")]), batch="b2")
    _apply(client, _synced(H["s3"], [_chk("2026-09-21", -21.0, "GROCER")]), batch="b3")
    with db.get_session() as s:
        row = s.query(SmartImportLedger).filter_by(import_id=oldest, action="snapshot").one()
        row.after_json = "{not json"
        s.commit()
    before = (table_hashes(db), _ids(db), _secret_rows(db))
    _fixed(_disconnect(client, CONN_ID, "true"), 500, "save_failed")
    assert (table_hashes(db), _ids(db), _secret_rows(db)) == before
    assert len(_metas(db)) == 3


# --- gating ----------------------------------------------------------------------------


@pytest.mark.parametrize("flag, value", [("DYNO", "web.1"), ("MULTI_USER_MODE", "true"),
                                         ("PROTECT_DEMO_DATA", "true")])
def test_a_shared_deployment_is_refused(client, db, env, flag, value):
    _store(db, CONN_ID, secrets=False)
    env.setenv(flag, value)
    _fixed(_disconnect(client, CONN_ID), 403, "connections_unavailable")
    _fixed(_disconnect(client, CONN_ID, "true"), 403, "connections_unavailable")
    env.delenv(flag)
    assert _ids(db) == {CONN_ID}


def test_demo_protection_is_checked_first(client, db, env):
    _store(db, CONN_ID)
    _apply(client, _synced(H["s1"], [_chk("2026-09-03", -15.49)]))
    before = (table_hashes(db), _ids(db), _secret_rows(db))
    calls: list[int] = []

    def protected() -> None:
        calls.append(1)
        raise HTTPException(status_code=403, detail="Demo data is protected.")

    env.setattr("src.services.demo_mode.check_demo_data_protection", protected)
    for flag in (None, "true", "false"):
        assert _disconnect(client, CONN_ID, flag).status_code == 403
    assert len(calls) == 3
    assert (table_hashes(db), _ids(db), _secret_rows(db)) == before


# --- privacy ----------------------------------------------------------------------------


def test_nothing_planted_reaches_the_logs_or_the_responses(client, db, env, caplog):
    for name in ("", "src", "httpx", "httpcore"):
        caplog.set_level(logging.DEBUG, logger=name)
    add_connections(db, {
        cid: connection_entry("simplefin", label="Mine", accounts={
            "ACT-1": {
                "name": PLANT_NAME, "institution": "ZQ Disc Bank", "currency": "USD", "kind": "checking",
                "role": "cash_flow", "label": PLANT_NAME, "account_key": "acct:" + "a" * 64,
                "liability_id": None, "flip_balance": False, "same_as_key": None,
            },
        })
        for cid in (CONN_ID, OTHER_ID)
    })
    for cid in (CONN_ID, OTHER_ID):
        store.save_secret(db, cid, SimpleFinCredentials(
            base_url=ACCESS_BASE, username=PLANT_USER, password=PLANT_PASS))
    _apply(client, _synced(H["s1"], [_chk("2026-09-03", -6543.21, PLANT_MERCHANT)]))
    _apply(client, _synced(H["o1"], [_chk("2026-09-04", -6543.21, PLANT_MERCHANT)], cid=OTHER_ID), batch="b2")
    caplog.clear()

    responses = [_disconnect(client, CONN_ID), _disconnect(client, OTHER_ID, "true")]
    assert [r.status_code for r in responses] == [200, 200]
    text = caplog.text + "".join(r.text for r in responses)
    for planted in PLANTED:
        assert planted not in text
    assert "connection_disconnected" in caplog.text
    assert all(record.exc_info is None for record in caplog.records)


def test_the_response_shape_is_plain_json(client, db):
    _store(db, CONN_ID)
    body = _disconnect(client, CONN_ID, "true").json()
    assert json.loads(json.dumps(body)) == body
    assert set(body) == {
        "connection_id", "remove_data", "imports_undone", "imports_kept", "deleted", "reassigned", "kept",
    }
