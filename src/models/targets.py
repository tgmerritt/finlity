"""Allocation target models with age-based adjustments."""

from datetime import date
from typing import Optional

import yaml
from pydantic import BaseModel, Field


class AssetClassTargets(BaseModel):
    """Target allocations by asset class."""

    equities: float = 0.90
    bonds: float = 0.025
    alternatives: float = 0.05
    cash: float = 0.025


class SectorTargets(BaseModel):
    """Target allocations by sector (as % of equities)."""

    technology: float = 0.41
    healthcare: float = 0.15
    consumer: float = 0.11
    industrials: float = 0.10
    financials: float = 0.09
    energy_materials: float = 0.05
    real_estate: float = 0.05
    utilities: float = 0.04


class GeographyTargets(BaseModel):
    """Target allocations by geography/cap (as % of equities)."""

    us_large_cap: float = 0.42
    us_mid_small_cap: float = 0.15
    foreign_large: float = 0.23
    foreign_mid_small: float = 0.10
    emerging_markets: float = 0.10


class StyleTargets(BaseModel):
    """Target allocations by style (as % of each geography bucket)."""

    growth: float = 0.65
    value: float = 0.35


class AllocationTargets(BaseModel):
    """Complete allocation targets with age-based adjustments."""

    dob: date
    retirement_age: int = 65
    asset_class: AssetClassTargets = Field(default_factory=AssetClassTargets)
    sector: SectorTargets = Field(default_factory=SectorTargets)
    geography: GeographyTargets = Field(default_factory=GeographyTargets)
    style: StyleTargets = Field(default_factory=StyleTargets)

    @property
    def current_age(self) -> int:
        today = date.today()
        age = today.year - self.dob.year
        if (today.month, today.day) < (self.dob.month, self.dob.day):
            age -= 1
        return age

    @property
    def years_to_retirement(self) -> int:
        return max(0, self.retirement_age - self.current_age)

    def get_age_adjusted_equity_target(self) -> float:
        """
        Adjust equity allocation based on age.
        Before 60: use base target
        After 60: shift 1% per year toward bonds
        """
        base_equity = self.asset_class.equities

        if self.current_age <= 60:
            return base_equity

        # After 60, reduce by 1% per year, minimum 50%
        reduction = (self.current_age - 60) * 0.01
        return max(0.50, base_equity - reduction)

    def get_age_adjusted_bond_target(self) -> float:
        """Get age-adjusted bond allocation (inverse of equity adjustment)."""
        base_bonds = self.asset_class.bonds
        equity_reduction = self.asset_class.equities - self.get_age_adjusted_equity_target()
        return base_bonds + equity_reduction

    def get_age_adjusted_targets(self) -> AssetClassTargets:
        """Get all asset class targets adjusted for age."""
        equity_target = self.get_age_adjusted_equity_target()
        bond_target = self.get_age_adjusted_bond_target()

        return AssetClassTargets(
            equities=equity_target,
            bonds=bond_target,
            alternatives=self.asset_class.alternatives,
            cash=self.asset_class.cash,
        )

    @classmethod
    def from_config(cls, config_path: str = "config.yaml") -> "AllocationTargets":
        """Load targets from config file."""
        with open(config_path) as f:
            config = yaml.safe_load(f)

        dob = date.fromisoformat(config["personal"]["dob"])
        retirement_age = config["personal"]["retirement_age"]

        targets_config = config.get("targets", {})

        return cls(
            dob=dob,
            retirement_age=retirement_age,
            asset_class=AssetClassTargets(**targets_config.get("asset_class", {})),
            sector=SectorTargets(**targets_config.get("sector", {})),
            geography=GeographyTargets(**targets_config.get("geography", {})),
            style=StyleTargets(**targets_config.get("style", {})),
        )


class RebalancingSuggestion(BaseModel):
    """A suggestion for rebalancing the portfolio."""

    category: str
    subcategory: str
    current_pct: float
    target_pct: float
    deviation_pct: float
    deviation_dollars: float
    action: str  # "BUY" or "SELL"

    @property
    def is_significant(self) -> bool:
        """Is this deviation significant enough to act on?"""
        return abs(self.deviation_pct) >= 2.0  # 2% threshold
