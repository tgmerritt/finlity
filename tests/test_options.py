"""Tests for options contract support: detection, market value ×100, and totals."""

import os
import sys
import pytest
from pathlib import Path
from datetime import datetime

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
