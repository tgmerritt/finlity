"""Demo liabilities: the pure snapshot generator and the guarded builder script."""
import importlib.util
import os
import shutil
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

from src.database.models import Account, BudgetExpense, Liability, LiabilityBalanceSnapshot, Position
from src.database.operations import Database
from src.liabilities.amortization import balance_at
from src.services import demo_liabilities as dl

_REPO_ROOT = Path(__file__).parent.parent
_SCRIPT = _REPO_ROOT / "scripts" / "build_demo_liabilities.py"
_IDS = ("demo-mortgage", "demo-auto", "demo-card")


def _load_script():
    spec = importlib.util.spec_from_file_location("build_demo_liabilities", _SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.fixture
def demo_copy(tmp_path, monkeypatch):
    """A temp copy of the tracked demo.db that the demo manager treats as the demo database."""
    dst = tmp_path / "demo" / "demo.db"
    dst.parent.mkdir()
    shutil.copy2(_REPO_ROOT / "data" / "demo" / "demo.db", dst)
    from src.services.demo_mode import get_demo_manager

    monkeypatch.setattr(get_demo_manager(), "demo_db_path", dst)
    return dst


@pytest.fixture
def pristine_demo_copy(demo_copy):
    """The demo copy as it was before the builder: no demo liabilities, home, or mortgage split."""
    db = Database(str(demo_copy))
    with db.get_session() as session:
        session.query(LiabilityBalanceSnapshot).delete()
        session.query(Liability).delete()
        session.query(Position).filter_by(id="demo-home").delete()
        session.query(Account).filter_by(id="demo-property").delete()
        mortgage = session.query(BudgetExpense).filter_by(name="Mortgage").one()
        mortgage.is_mortgage = False
        mortgage.principal_portion = None
        mortgage.interest_portion = None
        mortgage.amount = 3200.0
        session.commit()
    db.engine.dispose()
    return demo_copy


def _dump(path: Path) -> dict:
    db = Database(str(path))
    out = {}
    with db.get_session() as session:
        for model in (Liability, LiabilityBalanceSnapshot, Account, Position, BudgetExpense):
            rows = session.query(model).order_by(model.id).all()
            out[model.__tablename__] = [
                {c.name: getattr(r, c.name) for c in model.__table__.columns if c.name not in ("created_at", "updated_at")}
                for r in rows
            ]
    db.engine.dispose()
    return out


# --- demo_liability_snapshots ------------------------------------------------


def test_snapshots_are_deterministic():
    assert dl.demo_liability_snapshots(date(2026, 10, 3)) == dl.demo_liability_snapshots(date(2026, 10, 3))


def test_twelve_month_end_rows_per_liability_ending_at_last_month_end():
    rows = dl.demo_liability_snapshots(date(2026, 10, 3))
    for lid in _IDS:
        dates = [r["snapshot_date"] for r in rows if r["liability_id"] == lid]
        assert len(dates) == 12
        assert dates[-1] == date(2026, 9, 30)
        assert dates[0] == date(2025, 10, 31)
        assert dates == sorted(dates)
    assert len(rows) == 36


def test_end_date_on_a_month_end_is_included():
    rows = dl.demo_liability_snapshots(date(2026, 10, 31))
    assert max(r["snapshot_date"] for r in rows) == date(2026, 10, 31)


def test_installment_balances_match_the_schedule():
    rows = dl.demo_liability_snapshots(date(2026, 10, 3))
    for spec in dl.DEMO_LIABILITIES:
        if not spec["is_amortizing"]:
            continue
        mine = [r for r in rows if r["liability_id"] == spec["id"]]
        liability = dict(spec)
        # Rolling only the first report forward by the payment schedule reproduces every later report.
        first = [{"snapshot_date": mine[0]["snapshot_date"], "balance": mine[0]["balance"]}]
        for r in mine:
            assert balance_at(liability, first, r["snapshot_date"]) == pytest.approx(r["balance"], abs=0.01)
        assert [r["balance"] for r in mine] == sorted((r["balance"] for r in mine), reverse=True)


def test_card_stays_in_range_and_varies():
    rows = [r for r in dl.demo_liability_snapshots(date(2026, 10, 3)) if r["liability_id"] == "demo-card"]
    balances = [r["balance"] for r in rows]
    assert all(1800 <= b <= 4600 for b in balances)
    assert len(set(balances)) > 6


def test_rows_are_tagged_demo():
    assert {r["source"] for r in dl.demo_liability_snapshots(date(2026, 10, 3))} == {"demo"}


# --- builder ------------------------------------------------------------------


def test_builder_creates_rows_and_links_expenses(pristine_demo_copy):
    script = _load_script()
    assert script.main(["--db", str(pristine_demo_copy)]) == 0
    db = Database(str(pristine_demo_copy))
    with db.get_session() as session:
        liabs = {row.id: row for row in session.query(Liability).all()}
        assert set(liabs) == set(_IDS)
        assert session.query(LiabilityBalanceSnapshot).count() == 36
        mortgage_expense = session.query(BudgetExpense).filter_by(name="Mortgage").one()
        car_expense = session.query(BudgetExpense).filter_by(name="Car Payment #1").one()
        assert liabs["demo-mortgage"].expense_id == mortgage_expense.id
        assert liabs["demo-auto"].expense_id == car_expense.id
        assert mortgage_expense.is_mortgage
        assert mortgage_expense.principal_portion and mortgage_expense.interest_portion
        assert liabs["demo-card"].expense_id is None
        assert liabs["demo-mortgage"].linked_position_id == "demo-home"
        assert liabs["demo-mortgage"].payment_amount == pytest.approx(3201.73)
        assert mortgage_expense.amount == pytest.approx(3201.73)
        assert liabs["demo-auto"].payment_amount == pytest.approx(450.0)


def test_builder_is_idempotent(pristine_demo_copy):
    script = _load_script()
    script.main(["--db", str(pristine_demo_copy)])
    first = _dump(pristine_demo_copy)
    script.main(["--db", str(pristine_demo_copy)])
    assert _dump(pristine_demo_copy) == first


def test_builder_refuses_a_non_demo_path(demo_copy, tmp_path):
    other = tmp_path / "other.db"
    shutil.copy2(demo_copy, other)
    before = other.read_bytes()
    assert _load_script().main(["--db", str(other)]) != 0
    assert other.read_bytes() == before


def test_builder_refuses_a_symlink_to_elsewhere(demo_copy, tmp_path):
    other = tmp_path / "elsewhere.db"
    shutil.copy2(demo_copy, other)
    link = tmp_path / "link.db"
    link.symlink_to(other)
    before = other.read_bytes()
    assert _load_script().main(["--db", str(link)]) != 0
    assert other.read_bytes() == before


def test_builder_refuses_when_the_demo_path_itself_is_a_symlink(tmp_path, monkeypatch):
    real = tmp_path / "real.db"
    shutil.copy2(_REPO_ROOT / "data" / "demo" / "demo.db", real)
    link = tmp_path / "demo.db"
    link.symlink_to(real)
    from src.services.demo_mode import get_demo_manager

    monkeypatch.setattr(get_demo_manager(), "demo_db_path", link)
    before = real.read_bytes()
    assert _load_script().main(["--db", str(link)]) != 0
    assert _load_script().main(["--db", str(real)]) != 0
    assert real.read_bytes() == before


def test_builder_refuses_a_missing_file(demo_copy, tmp_path):
    demo_copy.unlink()
    assert _load_script().main(["--db", str(demo_copy)]) != 0
    assert not demo_copy.exists()


def test_builder_fails_loudly_and_writes_nothing_when_an_expense_is_missing(pristine_demo_copy):
    db = Database(str(pristine_demo_copy))
    with db.get_session() as session:
        session.query(BudgetExpense).filter_by(name="Car Payment #1").delete()
        session.commit()
    db.engine.dispose()
    before = _dump(pristine_demo_copy)
    assert _load_script().main(["--db", str(pristine_demo_copy)]) != 0
    assert _dump(pristine_demo_copy) == before


def test_builder_cli_exit_code_for_a_non_demo_path(tmp_path):
    other = tmp_path / "x.db"
    shutil.copy2(_REPO_ROOT / "data" / "demo" / "demo.db", other)
    env = {**os.environ, "PORTFOLIO_DATA_DIR": str(tmp_path / "data")}
    proc = subprocess.run(
        [sys.executable, str(_SCRIPT), "--db", str(other)], cwd=_REPO_ROOT, env=env, capture_output=True, text=True
    )
    assert proc.returncode != 0
