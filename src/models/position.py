"""Data models for portfolio positions and accounts."""

# mypy: disable-error-code="prop-decorator"
# Pydantic's @computed_field stacked on @property is the documented pattern;
# mypy 1.x flags this combination but the pydantic mypy plugin (or runtime
# behavior) is correct. Re-enable when mypy supports stacked decorators on
# properties (tracked in python/mypy#1362).

from datetime import date, datetime
from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field, computed_field


class Brokerage(str, Enum):
    SCHWAB = "schwab"
    FIDELITY = "fidelity"
    VANGUARD = "vanguard"
    OTHER = "other"


class AccountType(str, Enum):
    TAXABLE = "taxable"
    TRADITIONAL_401K = "traditional_401k"
    ROTH_401K = "roth_401k"
    TRADITIONAL_IRA = "traditional_ira"
    ROTH_IRA = "roth_ira"
    HSA = "hsa"
    PENSION = "pension"


class AssetClass(str, Enum):
    EQUITY = "equity"
    FIXED_INCOME = "fixed_income"
    ALTERNATIVE = "alternative"
    CASH = "cash"


class Position(BaseModel):
    """A single holding in an account."""

    ticker: str
    name: str
    shares: float
    current_price: float
    cost_basis: Optional[float] = None
    account_name: str
    brokerage: Brokerage
    asset_class: AssetClass = AssetClass.EQUITY
    sector: Optional[str] = None
    is_fund: bool = False

    @computed_field
    @property
    def market_value(self) -> float:
        return self.shares * self.current_price

    @computed_field
    @property
    def gain_loss(self) -> Optional[float]:
        if self.cost_basis is None:
            return None
        return self.market_value - self.cost_basis

    @computed_field
    @property
    def gain_loss_pct(self) -> Optional[float]:
        if self.cost_basis is None or self.cost_basis == 0:
            return None
        return (self.gain_loss / self.cost_basis) * 100


class Account(BaseModel):
    """A brokerage account containing positions."""

    name: str
    account_type: AccountType
    brokerage: Brokerage
    positions: list[Position] = Field(default_factory=list)
    last_updated: Optional[datetime] = None

    @computed_field
    @property
    def total_value(self) -> float:
        return sum(p.market_value for p in self.positions)

    @computed_field
    @property
    def total_cost_basis(self) -> Optional[float]:
        costs = [p.cost_basis for p in self.positions if p.cost_basis is not None]
        return sum(costs) if costs else None

    @computed_field
    @property
    def is_retirement(self) -> bool:
        return self.account_type in {
            AccountType.TRADITIONAL_401K,
            AccountType.ROTH_401K,
            AccountType.TRADITIONAL_IRA,
            AccountType.ROTH_IRA,
            AccountType.HSA,
            AccountType.PENSION,
        }


class Portfolio(BaseModel):
    """Complete portfolio across all accounts."""

    accounts: list[Account] = Field(default_factory=list)
    snapshot_date: date = Field(default_factory=date.today)

    @computed_field
    @property
    def total_value(self) -> float:
        return sum(a.total_value for a in self.accounts)

    @computed_field
    @property
    def retirement_value(self) -> float:
        return sum(a.total_value for a in self.accounts if a.is_retirement)

    @computed_field
    @property
    def taxable_value(self) -> float:
        return sum(a.total_value for a in self.accounts if not a.is_retirement)

    @computed_field
    @property
    def all_positions(self) -> list[Position]:
        positions = []
        for account in self.accounts:
            positions.extend(account.positions)
        return positions

    def get_positions_by_ticker(self, ticker: str) -> list[Position]:
        return [p for p in self.all_positions if p.ticker.upper() == ticker.upper()]

    def get_total_shares(self, ticker: str) -> float:
        return sum(p.shares for p in self.get_positions_by_ticker(ticker))

    def get_total_value_by_ticker(self, ticker: str) -> float:
        return sum(p.market_value for p in self.get_positions_by_ticker(ticker))

    def get_allocation_by_asset_class(self) -> dict[AssetClass, float]:
        """Get allocation percentages by asset class."""
        if self.total_value == 0:
            return {}

        allocations: dict[AssetClass, float] = {}
        for position in self.all_positions:
            asset_class = position.asset_class
            allocations[asset_class] = allocations.get(asset_class, 0) + position.market_value

        return {k: v / self.total_value for k, v in allocations.items()}

    def get_allocation_by_sector(self) -> dict[str, float]:
        """Get allocation percentages by sector."""
        if self.total_value == 0:
            return {}

        allocations: dict[str, float] = {}
        for position in self.all_positions:
            sector = position.sector or "Unknown"
            allocations[sector] = allocations.get(sector, 0) + position.market_value

        return {k: v / self.total_value for k, v in allocations.items()}

    def get_allocation_by_brokerage(self) -> dict[Brokerage, float]:
        """Get allocation percentages by brokerage."""
        if self.total_value == 0:
            return {}

        allocations: dict[Brokerage, float] = {}
        for account in self.accounts:
            allocations[account.brokerage] = allocations.get(account.brokerage, 0) + account.total_value

        return {k: v / self.total_value for k, v in allocations.items()}
