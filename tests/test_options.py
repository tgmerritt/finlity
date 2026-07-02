"""Tests for options contract support: detection, market value ×100, and totals."""

import os
import sys
import pytest
from pathlib import Path
from datetime import datetime
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).parent.parent))


# ---------------------------------------------------------------------------
# position_types helpers
# ---------------------------------------------------------------------------

def test_option_position_type_enum():
    from src.models.position_types import PositionType
    assert PositionType.OPTION.value == "option"


def test_parse_occ_ticker_call():
    from src.models.position_types import parse_occ_ticker
    result = parse_occ_ticker("GOOG 06/17/2027 305.00 C")
    assert result is not None
    assert result["underlying"] == "GOOG"
    assert result["exp"] == "06/17/2027"
    assert result["strike"] == "305.00"
    assert result["opt_type"] == "C"


def test_parse_occ_ticker_put():
    from src.models.position_types import parse_occ_ticker
    result = parse_occ_ticker("AAPL 01/21/2028 200.00 P")
    assert result is not None
    assert result["underlying"] == "AAPL"
    assert result["opt_type"] == "P"


def test_parse_occ_ticker_plain_equity():
    from src.models.position_types import parse_occ_ticker
    assert parse_occ_ticker("AAPL") is None
    assert parse_occ_ticker("BRK/B") is None
    assert parse_occ_ticker("SPY") is None


def test_is_option():
    from src.models.position_types import is_option
    assert is_option("option") is True
    assert is_option("equity") is False
    assert is_option(None) is False


def test_position_market_value_equity():
    from src.models.position_types import position_market_value

    class FakePos:
        shares = 10.0
        current_price = 100.0
        contract_multiplier = None

    assert position_market_value(FakePos()) == 1000.0


def test_position_market_value_option():
    from src.models.position_types import position_market_value

    class FakeOptPos:
        shares = 2.0          # 2 contracts
        current_price = 99.9  # $99.90 per share premium
        contract_multiplier = 100.0

    assert position_market_value(FakeOptPos()) == pytest.approx(2 * 100 * 99.9)


def test_position_market_value_missing_price():
    from src.models.position_types import position_market_value

    class NoPricePos:
        shares = 5.0
        current_price = None
        contract_multiplier = 100.0

    assert position_market_value(NoPricePos()) == 0.0


def test_non_updatable_options():
    from src.models.position_types import NON_UPDATABLE_POSITION_TYPES
    assert "option" in NON_UPDATABLE_POSITION_TYPES


# ---------------------------------------------------------------------------
# SQLAlchemy Position.market_value
# ---------------------------------------------------------------------------

def test_sqlalchemy_position_market_value_option():
    from src.database.models import Position

    pos = Position()
    pos.shares = 1.0
    pos.current_price = 99.9
    pos.contract_multiplier = 100.0

    assert pos.market_value == pytest.approx(9990.0)


def test_sqlalchemy_position_gain_loss_option():
    from src.database.models import Position

    pos = Position()
    pos.shares = 1.0
    pos.current_price = 99.9
    pos.contract_multiplier = 100.0
    pos.cost_basis = 11051.0  # total cost: 100 * $110.51

    assert pos.market_value == pytest.approx(9990.0)
    assert pos.gain_loss == pytest.approx(-1061.0)


def test_sqlalchemy_position_market_value_equity():
    from src.database.models import Position

    pos = Position()
    pos.shares = 100.0
    pos.current_price = 50.0
    pos.contract_multiplier = None

    assert pos.market_value == pytest.approx(5000.0)


# ---------------------------------------------------------------------------
# OCC ticker detection in folder_scanner._extract_position
# ---------------------------------------------------------------------------

def test_folder_scanner_detects_option(tmp_path):
    """_extract_position should detect an OCC ticker and return option_fields."""
    import pandas as pd
    from src.database import Database
    from src.importers.folder_scanner import FolderScanner

    db_path = tmp_path / "test.db"
    os.environ["PORTFOLIO_DATA_DIR"] = str(tmp_path)
    os.environ["PORTFOLIO_DEMO_MODE"] = "true"
    os.environ["PORTFOLIO_TEST_MODE"] = "true"

    db = Database(str(db_path))
    scanner = FolderScanner(db)

    row = pd.Series({
        "Symbol": "GOOG 06/17/2027 305.00 C",
        "Description": "CALL ALPHABET INC $305 EXP 06/17/27",
        "Qty (Quantity)": 1,
        "Price": "$99.90",
        "Cost/Share": "$110.51",
        "Mkt Val (Market Value)": "$9,990.00",
        "Security Type": "Option",
    })
    col_map = {
        "ticker": "Symbol",
        "name": "Description",
        "shares": "Qty (Quantity)",
        "price": "Price",
        "cost_per_share": "Cost/Share",
        "market_value": "Mkt Val (Market Value)",
        "security_type": "Security Type",
    }

    result = scanner._extract_position(row, col_map)
    assert result is not None
    ticker, shares, name, price, cost_basis, is_fund, option_fields = result

    assert ticker == "GOOG 06/17/2027 305.00 C"
    assert shares == 1.0
    assert price == pytest.approx(99.90)
    assert option_fields["position_type"] == "option"
    assert option_fields["contract_multiplier"] == 100.0
    assert option_fields["option_underlying"] == "GOOG"
    assert option_fields["option_type"] == "C"
    assert option_fields["option_strike"] == pytest.approx(305.0)
    # cost_basis should be multiplied by 100
    assert cost_basis == pytest.approx(110.51 * 100)


def test_folder_scanner_option_mv_fallback_no_double_count(tmp_path):
    """When Price='--' and Market Value is the full contract value, price must be
    divided by 100 so market_value property doesn't double-apply ×100."""
    import pandas as pd
    from src.database import Database
    from src.importers.folder_scanner import FolderScanner

    db_path = tmp_path / "test3.db"
    os.environ["PORTFOLIO_DATA_DIR"] = str(tmp_path)
    os.environ["PORTFOLIO_DEMO_MODE"] = "true"
    os.environ["PORTFOLIO_TEST_MODE"] = "true"

    db = Database(str(db_path))
    scanner = FolderScanner(db)

    # Price column is blank; Market Value = $9,990 (full per-contract value)
    row = pd.Series({
        "Symbol": "GOOG 06/17/2027 305.00 C",
        "Description": "CALL ALPHABET INC $305 EXP 06/17/27",
        "Qty (Quantity)": 1,
        "Price": "--",
        "Mkt Val (Market Value)": "$9,990.00",
    })
    col_map = {
        "ticker": "Symbol",
        "name": "Description",
        "shares": "Qty (Quantity)",
        "price": "Price",
        "market_value": "Mkt Val (Market Value)",
    }

    result = scanner._extract_position(row, col_map)
    assert result is not None
    _ticker, _shares, _name, price, _cost_basis, _is_fund, option_fields = result

    assert option_fields["position_type"] == "option"
    # Price must be per-share (9990 / 100 = 99.90)
    assert price == pytest.approx(99.90)
    # Simulated market_value with multiplier = 1 * 100 * 99.90 = 9990
    assert _shares * option_fields["contract_multiplier"] * price == pytest.approx(9990.0)


def test_folder_scanner_equity_unchanged(tmp_path):
    """_extract_position returns empty option_fields for plain equities."""
    import pandas as pd
    from src.database import Database
    from src.importers.folder_scanner import FolderScanner

    db_path = tmp_path / "test2.db"
    os.environ["PORTFOLIO_DATA_DIR"] = str(tmp_path)
    os.environ["PORTFOLIO_DEMO_MODE"] = "true"
    os.environ["PORTFOLIO_TEST_MODE"] = "true"

    db = Database(str(db_path))
    scanner = FolderScanner(db)

    row = pd.Series({
        "Symbol": "AAPL",
        "Description": "APPLE INC",
        "Qty (Quantity)": 10,
        "Price": "$150.00",
        "Mkt Val (Market Value)": "$1,500.00",
    })
    col_map = {
        "ticker": "Symbol",
        "name": "Description",
        "shares": "Qty (Quantity)",
        "price": "Price",
        "market_value": "Mkt Val (Market Value)",
    }

    result = scanner._extract_position(row, col_map)
    assert result is not None
    ticker, shares, name, price, cost_basis, is_fund, option_fields = result

    assert ticker == "AAPL"
    assert option_fields == {}

# ---------------------------------------------------------------------------
# Downstream valuation paths: analysis dicts, widgets, commentary
# (regression: these paths silently valued options at ×1 because the
# position dicts never carried contract_multiplier)
# ---------------------------------------------------------------------------

def _occ_option_namespace():
    return SimpleNamespace(
        ticker="GOOG 06/17/2027 305.00 C",
        name="CALL ALPHABET INC $305 EXP 06/17/27",
        shares=1.0,
        current_price=99.9,
        cost_basis=11051.0,
        is_fund=False,
        sector=None,
        asset_class="equity",
        position_type="option",
        contract_multiplier=100.0,
        purchase_date=None,
        lots=[],
    )


def test_analysis_dict_carries_option_fields():
    """_position_to_analysis_dict must pass contract_multiplier through,
    otherwise analyzers (tax-loss harvester, dividend tracker) fall back
    to ×1 and under-count options 100×."""
    from src.api.analysis import _position_to_analysis_dict

    db_account = SimpleNamespace(id="a1", name="IRA", account_type="traditional_ira")
    d = _position_to_analysis_dict(_occ_option_namespace(), db_account)

    assert d["position_type"] == "option"
    assert d["contract_multiplier"] == 100.0
    assert d["market_value"] == pytest.approx(9990.0)


def _load_widget(folder: str, class_name: str):
    """Instantiate a builtin widget directly (hyphenated folders need importlib)."""
    import importlib.util
    from src.plugins.base import PluginManifest, PluginType

    here = Path(__file__).resolve().parents[1]
    src = here / "src" / "plugins" / "builtin" / folder / "widget.py"
    spec = importlib.util.spec_from_file_location(f"{class_name}_under_test", src)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    manifest = PluginManifest(
        name=folder,
        version="1.0.0",
        description="test",
        author="test",
        license="MIT",
        plugin_type=PluginType.WIDGET,
        main="widget.py",
        entry_class=class_name,
    )
    return getattr(mod, class_name)(manifest, {})


def _widget_positions():
    """One equity and one option; daily_change_pct set to avoid price fetches."""
    return [
        {
            "ticker": "AAPL",
            "name": "APPLE INC",
            "shares": 10.0,
            "current_price": 100.0,
            "sector": "Technology",
            "position_type": "equity",
            "contract_multiplier": None,
            "daily_change_pct": 0.0,
        },
        {
            "ticker": "MSFT",
            "name": "MICROSOFT CORP",
            "shares": 5.0,
            "current_price": 200.0,
            "sector": "Technology",
            "position_type": "equity",
            "contract_multiplier": None,
            "daily_change_pct": 0.0,
        },
        {
            "ticker": "GOOG 06/17/2027 305.00 C",
            "name": "CALL ALPHABET INC $305 EXP 06/17/27",
            "shares": 1.0,
            "current_price": 99.9,
            "sector": "Technology",
            "position_type": "option",
            "contract_multiplier": 100.0,
            "daily_change_pct": 0.0,
        },
    ]


def test_sector_treemap_counts_option_at_full_value():
    widget = _load_widget("sector-treemap", "SectorTreemapWidget")
    content = widget.render(_widget_positions(), [])
    # 10×$100 + 5×$200 + 1 contract × 100 × $99.90
    assert content.data["total_value"] == pytest.approx(1000.0 + 1000.0 + 9990.0)


def test_correlation_heatmap_excludes_option_rows():
    """Options have no quotable price history; they must not appear as
    matrix rows (previously rendered with 0.5 filler correlations)."""
    widget = _load_widget("correlation-heatmap", "CorrelationHeatmapWidget")
    # Force the sector fallback so the test never touches the network.
    widget._calculate_price_correlations = lambda tickers: None
    content = widget.render(_widget_positions(), [])

    assert "GOOG 06/17/2027 305.00 C" not in content.data["tickers"]
    assert set(content.data["tickers"]) == {"AAPL", "MSFT"}


def test_commentary_portfolio_summary_counts_option():
    from unittest.mock import MagicMock
    from src.database.models import Position
    from src.services.commentary_service import CommentaryService

    opt = Position()
    opt.shares = 1.0
    opt.current_price = 99.9
    opt.contract_multiplier = 100.0
    opt.cost_basis = 11051.0

    eq = Position()
    eq.shares = 10.0
    eq.current_price = 100.0
    eq.contract_multiplier = None
    eq.cost_basis = 500.0

    account = SimpleNamespace(
        id="a1", name="IRA", account_type="traditional_ira", is_retirement=True
    )
    db = MagicMock()
    db.get_all_accounts.return_value = [account]
    db.get_positions_by_account.return_value = [opt, eq]

    summary = CommentaryService(db)._get_portfolio_summary()
    assert summary["total_value"] == pytest.approx(9990.0 + 1000.0)
    assert summary["retirement_value"] == pytest.approx(9990.0 + 1000.0)


def test_commentary_tax_projection_counts_option():
    from unittest.mock import MagicMock
    from src.database.models import Position
    from src.services.commentary_service import CommentaryService

    opt = Position()
    opt.shares = 1.0
    opt.current_price = 99.9
    opt.contract_multiplier = 100.0

    account = SimpleNamespace(
        id="a1", name="IRA", account_type="traditional_ira", is_retirement=True
    )
    db = MagicMock()
    db.get_all_accounts.return_value = [account]
    db.get_positions_by_account.return_value = [opt]

    service = CommentaryService(db)
    service._get_user_context = lambda: {"user_age": 44, "retirement_age": 60}
    data = service._get_tax_projection_data()
    assert data["traditional_balance"] == pytest.approx(9990.0)
