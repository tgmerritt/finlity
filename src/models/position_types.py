"""Position type classifications for the portfolio system."""

import re
from enum import Enum
from typing import Any, Optional


class PositionType(str, Enum):
    """Types of positions that can be held in an account."""

    EQUITY = "equity"           # Individual stocks
    FUND = "fund"               # ETFs, mutual funds
    CASH = "cash"               # Uninvested cash
    CD = "cd"                   # Certificate of Deposit
    BOND = "bond"               # Individual bonds
    TREASURY = "treasury"       # T-bills, I-bonds, etc.
    REAL_ESTATE = "real_estate" # Property (home, rental, land)
    OPTION = "option"           # Options contracts (calls/puts)


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
    PositionType.REAL_ESTATE: AssetClass.ALTERNATIVE,
    PositionType.OPTION: AssetClass.EQUITY,  # Options provide equity exposure
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


def is_real_estate(position_type: str) -> bool:
    """Check if a position type is real estate."""
    return position_type == PositionType.REAL_ESTATE.value


# Position types whose price is user-managed (manually entered) and which
# never need an external API lookup.
NON_UPDATABLE_POSITION_TYPES = frozenset({
    PositionType.CASH.value,
    PositionType.CD.value,
    PositionType.REAL_ESTATE.value,
    PositionType.OPTION.value,  # Option symbols don't resolve via equity price providers
})

# Sentinel ticker values used internally for non-market positions
# (set by the Add Cash / Add CD / Add Real Estate API endpoints) plus the
# Schwab CSV placeholder for pending positions.
_PLACEHOLDER_TICKERS = frozenset({"", "CASH", "CD", "RE", "NO NUMBER", "PENDING"})


# OCC standard options ticker: e.g. "GOOG 06/17/2027 305.00 C"
_OCC_PATTERN = re.compile(
    r'^(?P<underlying>[A-Z][A-Z0-9./]*)(?:\s+(?P<exp>\d{2}/\d{2}/\d{4})\s+(?P<strike>[\d.]+)\s+(?P<opt_type>[CP]))?$'
)


def parse_occ_ticker(ticker: str) -> Optional[dict[str, str]]:
    """Parse an OCC options ticker string.

    Returns a dict with keys underlying, exp, strike, opt_type if the ticker
    matches the options format, or None for plain equity tickers.
    """
    m = _OCC_PATTERN.match(ticker.strip().upper())
    if m and m.group('exp'):
        return {
            'underlying': m.group('underlying'),
            'exp': m.group('exp'),
            'strike': m.group('strike'),
            'opt_type': m.group('opt_type'),
        }
    return None


def is_option(position_type: Optional[str]) -> bool:
    """Return True if the position type is an options contract."""
    return position_type == PositionType.OPTION.value


def position_market_value(pos: Any) -> float:
    """Compute the market value of a position.

    For options, applies contract_multiplier (100) so that
    market_value = contracts × 100 × premium_per_share.
    For all other types, market_value = shares × current_price.
    """
    price = getattr(pos, 'current_price', None)
    shares = getattr(pos, 'shares', None)
    if not price or not shares:
        return 0.0
    multiplier = float(getattr(pos, 'contract_multiplier', None) or 1)
    return float(shares * price * multiplier)


def is_updatable_position(position_type: Optional[str], ticker: Optional[str]) -> bool:
    """Whether a position should participate in price-refresh / stale-count flows.

    A position is "updatable" iff it represents a market-tradeable holding
    whose price can be fetched from an external data provider. Cash, CDs, and
    real estate are user-managed; their prices must not be counted as stale.

    Excludes:
      - position_type in {cash, cd, real_estate}
      - ticker matching internal sentinels (CASH, CD, RE)
      - empty / placeholder tickers (Schwab "NO NUMBER", "PENDING")
      - tickers prefixed "CD-" — defensive workaround for CDs imported via
        CSV with the wrong position_type (e.g. "CD-MARCUS-1" tagged as equity).
    """
    if position_type and position_type in NON_UPDATABLE_POSITION_TYPES:
        return False
    if not ticker:
        return False
    normalized = ticker.strip().upper()
    if normalized in _PLACEHOLDER_TICKERS:
        return False
    if normalized.startswith("CD-"):
        return False
    return True
