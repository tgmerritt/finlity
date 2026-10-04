"""The shared connection-store cases (plan B5) match the server.

``tests/fixtures/connections_sanitize_cases.json`` and
``connections_plan_cases.json`` are generated from ``store.sanitize`` and
``service._detail`` by ``tests/fixtures/build_connections_cases.py`` and read
by the browser tests too (``connections-store.test.ts``,
``connections.test.ts``), so both paths answer the same cases.
"""

from __future__ import annotations

import importlib.util
import json
from datetime import date
from pathlib import Path
from typing import Any
from unittest import mock

import pytest

from src.connectors import service, store
from src.database import Database
from src.database.models import BankStatementImport, SmartImportMeta

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures"


def _builder() -> Any:
    spec = importlib.util.spec_from_file_location(
        "build_connections_cases", FIXTURES / "build_connections_cases.py"
    )
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BUILDER = _builder()
SANITIZE = json.loads((FIXTURES / "connections_sanitize_cases.json").read_text(encoding="utf-8"))
PLAN = json.loads((FIXTURES / "connections_plan_cases.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", SANITIZE["cases"], ids=[c["name"] for c in SANITIZE["cases"]])
def test_sanitize_case(case: dict[str, Any]) -> None:
    assert BUILDER.sanitized_for(case) == case["sanitized"]


@pytest.mark.parametrize("case", PLAN["cases"], ids=[c["name"] for c in PLAN["cases"]])
def test_plan_case(case: dict[str, Any]) -> None:
    assert BUILDER.detail_for(case) == case["detail"]


IMPORT_CASES = [c for c in PLAN["cases"] if "imports" in c]


def test_some_plan_cases_carry_imports() -> None:
    assert len(IMPORT_CASES) >= 2


@pytest.mark.parametrize("case", IMPORT_CASES, ids=[c["name"] for c in IMPORT_CASES])
def test_plan_case_imports_through_the_database(case: dict[str, Any], tmp_path: Path) -> None:
    """The real ``newest_import_ends`` query keeps only this connection's
    imports, and the detail read from a database equals the fixture."""
    db = Database(str(tmp_path / "plan.db"))
    with db.get_session() as s:
        for i, row in enumerate(case["imports"]):
            iid = f"imp-{i}"
            s.add(BankStatementImport(
                id=iid, file_name="x", content_hash=f"h{i}", row_count=0, status="applied"
            ))
            end = date.fromisoformat(row["period_end"])
            s.add(SmartImportMeta(
                import_id=iid, batch_id="b1", origin="connector", format="connector",
                parser="connector:demo", account_kind="checking",
                account_key=row["account_key"], period_start=end, period_end=end,
                connection_id=row["connection_id"],
            ))
        s.commit()
    keys = sorted({row["account_key"] for row in case["imports"]})
    ends = store.newest_import_ends(db, case["id"], keys)
    assert {k: v.isoformat() for k, v in ends.items()} == case["import_ends"]
    now = BUILDER.parse_now(case["now"])
    today = date.fromisoformat(case["today"])
    store.write_connections(db, {"version": 1, "items": {case["id"]: case["connection"]}}, now=now)
    with mock.patch.object(service, "utcnow", lambda: now), mock.patch.object(
        service.clock, "today", lambda: today
    ):
        assert service.get_connection(db, case["id"]) == case["detail"]


def test_fixtures_hold_every_built_case() -> None:
    """A case added to the builder but not regenerated fails here."""
    assert BUILDER.build_sanitize()["cases"] == SANITIZE["cases"]
    assert BUILDER.build_plan()["cases"] == PLAN["cases"]


def test_exists_cases_are_part_of_the_sanitize_cases() -> None:
    """Plan B3's existence cases live on inside the sanitize cases."""
    exists = json.loads((FIXTURES / "connections_exists_cases.json").read_text(encoding="utf-8"))
    by_name = {c["name"]: c for c in SANITIZE["cases"]}
    for case in exists["cases"]:
        full = by_name["exists: " + case["name"]]
        assert full["value"] == case["value"]
        assert list(full["sanitized"]["items"]) == case["ids"]


def test_fixtures_have_no_em_dash() -> None:
    for name in ("connections_sanitize_cases.json", "connections_plan_cases.json", "build_connections_cases.py"):
        text = (FIXTURES / name).read_text(encoding="utf-8")
        assert chr(0x2014) not in text
        assert "\\u2014" not in text
