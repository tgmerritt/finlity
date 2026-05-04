"""
Sprint 8 wire-up tests: importer + persistence layer creates PositionLot rows.

The three CSV importers (Schwab, Fidelity, Vanguard) return position dicts
to the persistence layer (``Database.add_position``), which now creates a
``PositionLot`` row for each imported position when sufficient data is
available. This test file exercises the end-to-end path so the tax-loss
harvester sees real lots and not the synthetic fallback.

The importer plugins themselves don't write to the DB, but their position
dicts may carry an optional ``lots`` key (Vanguard does this when
trade_date + cost_basis are both present in the export). Schwab and
Fidelity rarely have a parseable purchase date, so they rely on the
single-lot persistence-layer fallback (anchored at the import timestamp).
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

from src.database.operations import Database
from src.database.models import PositionLot
from src.plugins.base import (
    DatabaseAccess,
    FileFormat,
    PluginManifest,
    PluginPermissions,
    PluginType,
)


# ---------------------------------------------------------------------------
# Plugin loading helpers (the plugin directories use hyphens, so we cannot
# `import` them; we mirror what the registry does and load by file path).
# ---------------------------------------------------------------------------

ROOT = Path(__file__).resolve().parent.parent


def _load_importer_module(plugin_dir: Path, mod_name: str):
    spec = importlib.util.spec_from_file_location(mod_name, plugin_dir / "importer.py")
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _load_schwab():
    plugin_dir = ROOT / "src" / "plugins" / "builtin" / "schwab-csv"
    mod = _load_importer_module(plugin_dir, "schwab_csv_importer_under_test")
    manifest = PluginManifest(
        name="Schwab CSV Importer",
        version="1.0.0",
        description="Test instance",
        author="Tests",
        license="MIT",
        plugin_type=PluginType.IMPORTER,
        main="importer.py",
        entry_class="SchwabCSVImporter",
        permissions=PluginPermissions(
            file_read=True, file_write=False, network=False,
            database=DatabaseAccess.READ_ONLY,
        ),
        supported_formats=[FileFormat(extension=".csv", mime_type="text/csv", description="Schwab CSV")],
        plugin_id="schwab-csv",
        plugin_path=plugin_dir,
        is_builtin=True,
    )
    return mod.SchwabCSVImporter(manifest, {})


def _load_fidelity():
    plugin_dir = ROOT / "src" / "plugins" / "builtin" / "fidelity-csv"
    mod = _load_importer_module(plugin_dir, "fidelity_csv_importer_under_test")
    manifest = PluginManifest(
        name="Fidelity CSV Importer",
        version="1.0.0",
        description="Test instance",
        author="Tests",
        license="MIT",
        plugin_type=PluginType.IMPORTER,
        main="importer.py",
        entry_class="FidelityCSVImporter",
        permissions=PluginPermissions(
            file_read=True, file_write=False, network=False,
            database=DatabaseAccess.READ_ONLY,
        ),
        supported_formats=[FileFormat(extension=".csv", mime_type="text/csv", description="Fidelity CSV")],
        plugin_id="fidelity-csv",
        plugin_path=plugin_dir,
        is_builtin=True,
    )
    return mod.FidelityCSVImporter(manifest, {})


def _load_vanguard():
    plugin_dir = ROOT / "src" / "plugins" / "builtin" / "vanguard-csv"
    mod = _load_importer_module(plugin_dir, "vanguard_csv_importer_under_test_lots")
    manifest = PluginManifest(
        name="Vanguard CSV Importer",
        version="1.0.0",
        description="Test instance",
        author="Tests",
        license="MIT",
        plugin_type=PluginType.IMPORTER,
        main="importer.py",
        entry_class="VanguardCSVImporter",
        permissions=PluginPermissions(
            file_read=True, file_write=False, network=False,
            database=DatabaseAccess.READ_ONLY,
        ),
        supported_formats=[FileFormat(extension=".csv", mime_type="text/csv", description="Vanguard CSV")],
        plugin_id="vanguard-csv",
        plugin_path=plugin_dir,
        is_builtin=True,
    )
    return mod.VanguardCSVImporter(manifest, {})


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def db(tmp_path) -> Database:
    """A throwaway SQLite database for each test."""
    return Database(db_path=str(tmp_path / "lot_test.db"))


def _persist_positions(
    db: Database,
    plugin_result,
    *,
    account_name: str,
    account_type: str,
    brokerage: str,
    content_hash: str | None = None,
):
    """Helper that mimics the FolderScanner._import_with_plugin glue.

    Creates the account, records the import, and replays each position dict
    through ``db.add_position`` so the persistence-layer lot logic runs.
    Returns the (account, file_import) pair.
    """
    import uuid

    account = db.get_or_create_account(
        name=account_name, account_type=account_type, brokerage=brokerage,
    )
    file_import = db.record_import(
        file_name="synthetic.csv",
        file_path="synthetic.csv",
        content_hash=content_hash or f"hash-{brokerage}-{account_name}-{uuid.uuid4()}",
        account_type=account_type,
        row_count=len(plugin_result.positions),
        status="pending",
    )
    db.clear_account_positions(account.id)
    for pos in plugin_result.positions:
        db.add_position(
            account_id=account.id,
            ticker=pos["ticker"],
            shares=pos["shares"],
            name=pos.get("name"),
            cost_basis=pos.get("cost_basis"),
            current_price=(pos.get("price") if pos.get("price") and pos["price"] > 0 else None),
            is_fund=pos.get("is_fund", False),
            import_id=file_import.id,
            lots=pos.get("lots"),
            brokerage=brokerage,
        )
    return account, file_import


def _all_lots(db: Database) -> list[PositionLot]:
    with db.get_session() as session:
        return session.query(PositionLot).all()


def _lots_for_ticker(db: Database, ticker: str) -> list[PositionLot]:
    with db.get_session() as session:
        from src.database.models import Position
        return (
            session.query(PositionLot)
            .join(Position)
            .filter(Position.ticker == ticker)
            .all()
        )


# ---------------------------------------------------------------------------
# Schwab — no purchase_date column; relies on single-lot fallback
# ---------------------------------------------------------------------------


SCHWAB_CSV = (
    '"Positions for account 1234-5678 as of 12:00 PM ET, 2024-01-01"\n'
    "\n"
    "Symbol,Description,Quantity,Price,Market Value,Cost Basis\n"
    "AAPL,Apple Inc,10,200.00,2000.00,1500.00\n"
    "MSFT,Microsoft Corp,5,400.00,2000.00,\n"  # no cost basis -> no lot
    '"Total","",,,4000.00,1500.00\n'
)


def test_schwab_imported_position_with_cost_basis_creates_one_lot(tmp_path, db):
    importer = _load_schwab()
    csv_path = tmp_path / "schwab.csv"
    csv_path.write_text(SCHWAB_CSV, encoding="utf-8")
    result = importer.import_file(csv_path, "taxable")
    assert result.success

    _persist_positions(
        db, result, account_name="Schwab Taxable",
        account_type="taxable", brokerage="schwab",
    )

    aapl_lots = _lots_for_ticker(db, "AAPL")
    msft_lots = _lots_for_ticker(db, "MSFT")

    # AAPL has cost_basis -> exactly one fallback lot.
    assert len(aapl_lots) == 1
    assert aapl_lots[0].cost_basis == 1500.0
    assert aapl_lots[0].shares == 10.0
    assert aapl_lots[0].purchase_date is not None  # import-timestamp fallback
    assert "schwab" in (aapl_lots[0].notes or "").lower()

    # MSFT has no cost_basis -> NO lot. Synthetic-fallback path covers it.
    assert msft_lots == []


def test_schwab_reimport_replaces_lots(tmp_path, db):
    importer = _load_schwab()
    csv_path = tmp_path / "schwab.csv"
    csv_path.write_text(SCHWAB_CSV, encoding="utf-8")
    result = importer.import_file(csv_path, "taxable")
    _persist_positions(
        db, result, account_name="Schwab Taxable",
        account_type="taxable", brokerage="schwab",
    )
    first_count = len(_all_lots(db))
    assert first_count == 1

    # Re-import the same data: clear_account_positions wipes positions, and
    # cascade="all, delete-orphan" wipes the lots with them.
    result2 = importer.import_file(csv_path, "taxable")
    _persist_positions(
        db, result2, account_name="Schwab Taxable",
        account_type="taxable", brokerage="schwab",
    )
    assert len(_all_lots(db)) == 1, "re-import should replace, not duplicate, lots"


# ---------------------------------------------------------------------------
# Fidelity — also no purchase_date in standard "Positions" export
# ---------------------------------------------------------------------------


FIDELITY_CSV = (
    "Account Name,Symbol,Description,Quantity,Last Price,Current Value,Cost Basis Total\n"
    "Brokerage 1234,GOOG,Alphabet Inc,8,150.00,1200.00,800.00\n"
    "Brokerage 1234,TSLA,Tesla Inc,3,250.00,750.00,\n"  # no cost basis
)


def test_fidelity_imported_position_with_cost_basis_creates_one_lot(tmp_path, db):
    importer = _load_fidelity()
    csv_path = tmp_path / "fidelity.csv"
    csv_path.write_text(FIDELITY_CSV, encoding="utf-8")
    result = importer.import_file(csv_path, "taxable")
    assert result.success

    _persist_positions(
        db, result, account_name="Fidelity Taxable",
        account_type="taxable", brokerage="fidelity",
    )

    goog_lots = _lots_for_ticker(db, "GOOG")
    tsla_lots = _lots_for_ticker(db, "TSLA")

    assert len(goog_lots) == 1
    assert goog_lots[0].cost_basis == 800.0
    assert goog_lots[0].shares == 8.0
    assert "fidelity" in (goog_lots[0].notes or "").lower()

    assert tsla_lots == []  # no cost basis -> no lot


# ---------------------------------------------------------------------------
# Vanguard — when trade_date + cost_basis are both present, the importer
# emits a `lots` key with the real purchase_date.
# ---------------------------------------------------------------------------


def test_vanguard_imported_position_uses_trade_date_when_available(tmp_path, db):
    importer = _load_vanguard()
    csv_text = (
        "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,"
        "Cost Basis,Trade Date,Holding Type\n"
        "12345678,Vanguard Total Stock Market ETF,VTI,100,220.55,22055.00,"
        "20000.00,03/15/2023,ETF\n"
        # Position with no trade_date or cost_basis -> still gets a fallback
        # lot if cost_basis is present elsewhere; here it's absent so no lot.
        "12345678,Vanguard S&P 500 ETF,VOO,50,440.00,22000.00,,,ETF\n"
    )
    csv_path = tmp_path / "vanguard.csv"
    csv_path.write_text(csv_text, encoding="utf-8")
    result = importer.import_file(csv_path, "taxable")
    assert result.success

    # Vanguard importer should have surfaced an explicit `lots` list for VTI.
    vti_dict = next(p for p in result.positions if p["ticker"] == "VTI")
    assert "lots" in vti_dict, "Vanguard should emit explicit lots when trade_date + cost_basis present"
    assert vti_dict["lots"][0]["purchase_date"].startswith("2023-03-15")

    _persist_positions(
        db, result, account_name="Vanguard Taxable",
        account_type="taxable", brokerage="vanguard",
    )

    vti_lots = _lots_for_ticker(db, "VTI")
    voo_lots = _lots_for_ticker(db, "VOO")

    # VTI has explicit lots -> one lot, with the real trade_date.
    assert len(vti_lots) == 1
    assert vti_lots[0].cost_basis == 20000.0
    assert vti_lots[0].purchase_date.year == 2023
    assert vti_lots[0].purchase_date.month == 3
    assert vti_lots[0].purchase_date.day == 15
    assert "vanguard" in (vti_lots[0].notes or "").lower()

    # VOO has no cost_basis -> no lot.
    assert voo_lots == []


def test_vanguard_no_cost_basis_creates_no_lot(tmp_path, db):
    """The standard Vanguard brokerage export is the common case: no cost
    basis column. Confirm we don't fabricate lot data."""
    importer = _load_vanguard()
    csv_text = (
        "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,Holding Type\n"
        "12345678,Vanguard Total Stock Market ETF,VTI,100,220.55,22055.00,ETF\n"
        "12345678,Vanguard S&P 500 ETF,VOO,50,440.00,22000.00,ETF\n"
    )
    csv_path = tmp_path / "vanguard_no_cost.csv"
    csv_path.write_text(csv_text, encoding="utf-8")
    result = importer.import_file(csv_path, "taxable")
    assert result.success

    _persist_positions(
        db, result, account_name="Vanguard Taxable",
        account_type="taxable", brokerage="vanguard",
    )
    assert _all_lots(db) == []


# ---------------------------------------------------------------------------
# End-to-end: importer -> persistence -> analyzer sees real lot ids
# ---------------------------------------------------------------------------


def test_tax_loss_harvester_picks_real_lot_id_after_import(tmp_path, db):
    """Sprint 8 end-to-end proof: a Vanguard import that creates real
    PositionLot rows is consumed by the tax-loss harvester via the same
    dict shape the API surfaces, and the analyzer's recommendation
    references the real lot id (not 'synthetic')."""
    # Set the trade_date far enough in the past that the position is at a
    # loss versus a current price the test pretends came from yfinance.
    importer = _load_vanguard()
    csv_text = (
        "Account Number,Investment Name,Symbol,Shares,Share Price,Total Value,"
        "Cost Basis,Trade Date,Holding Type\n"
        # current_value 100 * 100 = 10000, cost 15000 -> -5000 LT loss.
        "12345678,Test Stock,XYZW,100,100.00,10000.00,15000.00,01/15/2022,Stock\n"
    )
    csv_path = tmp_path / "vanguard_tlh.csv"
    csv_path.write_text(csv_text, encoding="utf-8")
    result = importer.import_file(csv_path, "taxable")
    assert result.success

    account, _ = _persist_positions(
        db, result, account_name="Vanguard Taxable",
        account_type="taxable", brokerage="vanguard",
    )

    # Build the analyzer-input dict the same way the API does.
    from src.api.analysis import _position_to_analysis_dict

    db_account = db.get_account_by_id(account.id)
    db_positions = db.get_positions_by_account(account.id)
    positions = [_position_to_analysis_dict(p, db_account) for p in db_positions]
    accounts = [{
        "id": db_account.id,
        "name": db_account.name,
        "account_type": db_account.account_type,
        "is_retirement": False,
    }]

    # The analyzer-input position should carry a real lot list (not empty
    # — that's the synthetic fallback path).
    assert positions[0]["lots"], "expected real PositionLot rows in payload"
    real_lot_id = positions[0]["lots"][0]["id"]
    assert real_lot_id != "synthetic"

    # Now run the tax-loss harvester.
    from tests.test_tax_loss_harvester import _make_analyzer
    analyzer = _make_analyzer({"min_loss_threshold": 50})
    analysis = analyzer.analyze(positions, accounts)
    assert analysis.success
    recs = analysis.metrics["recommendations"]
    assert len(recs) == 1, "expected exactly one harvest recommendation"
    rec = recs[0]

    # The crucial Sprint 8 assertion: the recommendation references the
    # actual PositionLot.id from the database, NOT 'synthetic'.
    assert rec["lot_id"] == real_lot_id
    assert rec["lot_id"] != "synthetic"
    assert rec["unrealized_gain_loss"] == pytest.approx(-5000.0)
    assert rec["is_short_term"] is False  # 2022-01-15 is far enough back to be LT
