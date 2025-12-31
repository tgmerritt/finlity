"""Position type classifications for the portfolio system."""

from enum import Enum


class PositionType(str, Enum):
    """Types of positions that can be held in an account."""

    EQUITY = "equity"      # Individual stocks
    FUND = "fund"          # ETFs, mutual funds
    CASH = "cash"          # Uninvested cash
    CD = "cd"              # Certificate of Deposit
    BOND = "bond"          # Individual bonds
    TREASURY = "treasury"  # T-bills, I-bonds, etc.


class AssetClass(str, Enum):
    """Broader asset class categories."""

    EQUITY = "equity"
    FIXED_INCOME = "fixed_income"
    ALTERNATIVE = "alternative"
    CASH = "cash"


# Mapping from position type to asset class
POSITION_TYPE_TO_ASSET_CLASS = {
    PositionType.EQUITY: AssetClass.EQUITY,
    PositionType.FUND: AssetClass.EQUITY,  # Most funds, can be overridden
    PositionType.CASH: AssetClass.CASH,
    PositionType.CD: AssetClass.FIXED_INCOME,
    PositionType.BOND: AssetClass.FIXED_INCOME,
    PositionType.TREASURY: AssetClass.FIXED_INCOME,
}


def get_asset_class_for_position_type(position_type: str) -> str:
    """Get the default asset class for a position type."""
    try:
        pt = PositionType(position_type)
        return POSITION_TYPE_TO_ASSET_CLASS.get(pt, AssetClass.EQUITY).value
    except ValueError:
        return AssetClass.EQUITY.value


def is_cash_equivalent(position_type: str) -> bool:
    """Check if a position type is a cash equivalent."""
    return position_type in {PositionType.CASH.value, "cash"}


def is_fixed_income(position_type: str) -> bool:
    """Check if a position type is fixed income."""
    return position_type in {
        PositionType.CD.value,
        PositionType.BOND.value,
        PositionType.TREASURY.value,
    }
