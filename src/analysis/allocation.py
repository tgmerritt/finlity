"""Allocation analysis comparing actual vs target allocations."""

from dataclasses import dataclass
from typing import Optional

from src.data import FundLookupService
from src.models import AllocationTargets, Portfolio, RebalancingSuggestion


@dataclass
class AllocationBreakdown:
    """Breakdown of current allocation by category."""

    # Asset class
    equities: float = 0.0
    bonds: float = 0.0
    alternatives: float = 0.0
    cash: float = 0.0

    # Sector (as % of equities)
    technology: float = 0.0
    healthcare: float = 0.0
    consumer: float = 0.0
    industrials: float = 0.0
    financials: float = 0.0
    energy_materials: float = 0.0
    real_estate: float = 0.0
    utilities: float = 0.0
    communication: float = 0.0
    other_sector: float = 0.0

    # Geography (as % of equities)
    us_large: float = 0.0
    us_mid_small: float = 0.0
    foreign_developed: float = 0.0
    foreign_mid_small: float = 0.0
    emerging: float = 0.0


@dataclass
class AllocationDeviation:
    """Deviation between actual and target allocations."""

    category: str
    subcategory: str
    current_pct: float
    target_pct: float
    deviation_pct: float
    deviation_dollars: float
    action: str  # "BUY" or "SELL" or "HOLD"


class AllocationAnalyzer:
    """Analyzer for portfolio allocation vs targets."""

    def __init__(
        self,
        targets: Optional[AllocationTargets] = None,
        fund_service: Optional[FundLookupService] = None,
    ):
        self.targets = targets or AllocationTargets.from_config()
        self.fund_service = fund_service or FundLookupService()

    def calculate_allocation(self, portfolio: Portfolio) -> AllocationBreakdown:
        """Calculate current allocation breakdown."""
        if portfolio.total_value == 0:
            return AllocationBreakdown()

        # Initialize totals
        totals = {
            "us_stock": 0.0,
            "foreign_stock": 0.0,
            "bonds": 0.0,
            "cash": 0.0,
            "other": 0.0,
            "technology": 0.0,
            "healthcare": 0.0,
            "consumer": 0.0,
            "industrials": 0.0,
            "financial": 0.0,
            "energy_materials": 0.0,
            "real_estate": 0.0,
            "utilities": 0.0,
            "communication": 0.0,
            "us": 0.0,
            "developed_ex_us": 0.0,
            "emerging": 0.0,
            "giant": 0.0,
            "large": 0.0,
            "medium": 0.0,
            "small": 0.0,
            "micro": 0.0,
        }

        for position in portfolio.all_positions:
            value = position.market_value

            if position.is_fund:
                # Use fund lookup for decomposition
                lookthrough = self.fund_service.calculate_lookthrough(position.ticker, value)
                for key, amount in lookthrough.items():
                    if key in totals:
                        totals[key] += amount
            else:
                # Individual stock - classify by sector
                totals["us_stock"] += value
                totals["us"] += value

                # Use position's sector if available
                sector = (position.sector or "").lower()
                if "tech" in sector:
                    totals["technology"] += value
                elif "health" in sector:
                    totals["healthcare"] += value
                elif "consumer" in sector:
                    totals["consumer"] += value
                elif "industrial" in sector:
                    totals["industrials"] += value
                elif "financ" in sector:
                    totals["financial"] += value
                elif "energy" in sector or "material" in sector:
                    totals["energy_materials"] += value
                elif "real" in sector:
                    totals["real_estate"] += value
                elif "util" in sector:
                    totals["utilities"] += value
                elif "comm" in sector:
                    totals["communication"] += value

                # Assume large cap for individual stocks
                totals["giant"] += value * 0.3
                totals["large"] += value * 0.7

        # Calculate percentages
        total = portfolio.total_value
        equities_value = totals["us_stock"] + totals["foreign_stock"]

        breakdown = AllocationBreakdown(
            equities=(equities_value / total * 100) if total > 0 else 0,
            bonds=(totals["bonds"] / total * 100) if total > 0 else 0,
            alternatives=(totals["other"] / total * 100) if total > 0 else 0,
            cash=(totals["cash"] / total * 100) if total > 0 else 0,
        )

        # Sector percentages (of equities)
        if equities_value > 0:
            breakdown.technology = totals["technology"] / equities_value * 100
            breakdown.healthcare = totals["healthcare"] / equities_value * 100
            breakdown.consumer = totals["consumer"] / equities_value * 100
            breakdown.industrials = totals["industrials"] / equities_value * 100
            breakdown.financials = totals["financial"] / equities_value * 100
            breakdown.energy_materials = totals["energy_materials"] / equities_value * 100
            breakdown.real_estate = totals["real_estate"] / equities_value * 100
            breakdown.utilities = totals["utilities"] / equities_value * 100
            breakdown.communication = totals["communication"] / equities_value * 100

            # Geography percentages
            us_total = totals["us"]
            foreign_developed = totals["developed_ex_us"]
            emerging = totals["emerging"]

            # Estimate large vs mid/small based on cap size breakdown
            large_pct = (totals["giant"] + totals["large"]) / equities_value if equities_value > 0 else 0.7
            mid_small_pct = (totals["medium"] + totals["small"] + totals["micro"]) / equities_value if equities_value > 0 else 0.3

            # Split US by cap size
            breakdown.us_large = (us_total * large_pct / equities_value * 100)
            breakdown.us_mid_small = (us_total * mid_small_pct / equities_value * 100)

            # Split foreign by cap size
            breakdown.foreign_developed = (foreign_developed * large_pct / equities_value * 100)
            breakdown.foreign_mid_small = (foreign_developed * mid_small_pct / equities_value * 100)

            breakdown.emerging = (emerging / equities_value * 100)

        return breakdown

    def calculate_deviations(
        self,
        portfolio: Portfolio,
    ) -> list[AllocationDeviation]:
        """Calculate deviations from target allocations."""
        current = self.calculate_allocation(portfolio)
        age_adjusted = self.targets.get_age_adjusted_targets()

        deviations = []

        # Asset class deviations
        deviations.append(
            self._create_deviation(
                "Asset Class",
                "Equities",
                current.equities,
                age_adjusted.equities * 100,
                portfolio.total_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Asset Class",
                "Bonds",
                current.bonds,
                age_adjusted.bonds * 100,
                portfolio.total_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Asset Class",
                "Alternatives",
                current.alternatives,
                age_adjusted.alternatives * 100,
                portfolio.total_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Asset Class",
                "Cash",
                current.cash,
                age_adjusted.cash * 100,
                portfolio.total_value,
            )
        )

        # Sector deviations (% of equities)
        equity_value = portfolio.total_value * current.equities / 100

        deviations.append(
            self._create_deviation(
                "Sector",
                "Technology",
                current.technology,
                self.targets.sector.technology * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Sector",
                "Healthcare",
                current.healthcare,
                self.targets.sector.healthcare * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Sector",
                "Consumer",
                current.consumer,
                self.targets.sector.consumer * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Sector",
                "Industrials",
                current.industrials,
                self.targets.sector.industrials * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Sector",
                "Financials",
                current.financials,
                self.targets.sector.financials * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Sector",
                "Energy/Materials",
                current.energy_materials,
                self.targets.sector.energy_materials * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Sector",
                "Real Estate",
                current.real_estate,
                self.targets.sector.real_estate * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Sector",
                "Utilities",
                current.utilities,
                self.targets.sector.utilities * 100,
                equity_value,
            )
        )

        # Geography deviations
        deviations.append(
            self._create_deviation(
                "Geography",
                "US Large Cap",
                current.us_large,
                self.targets.geography.us_large_cap * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Geography",
                "US Mid/Small Cap",
                current.us_mid_small,
                self.targets.geography.us_mid_small_cap * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Geography",
                "Foreign Large",
                current.foreign_developed,
                self.targets.geography.foreign_large * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Geography",
                "Foreign Mid/Small",
                current.foreign_mid_small,
                self.targets.geography.foreign_mid_small * 100,
                equity_value,
            )
        )
        deviations.append(
            self._create_deviation(
                "Geography",
                "Emerging Markets",
                current.emerging,
                self.targets.geography.emerging_markets * 100,
                equity_value,
            )
        )

        return deviations

    def _create_deviation(
        self,
        category: str,
        subcategory: str,
        current_pct: float,
        target_pct: float,
        base_value: float,
    ) -> AllocationDeviation:
        """Create an allocation deviation object."""
        deviation_pct = current_pct - target_pct
        deviation_dollars = base_value * deviation_pct / 100

        if abs(deviation_pct) < 1.0:
            action = "HOLD"
        elif deviation_pct > 0:
            action = "SELL"
        else:
            action = "BUY"

        return AllocationDeviation(
            category=category,
            subcategory=subcategory,
            current_pct=current_pct,
            target_pct=target_pct,
            deviation_pct=deviation_pct,
            deviation_dollars=deviation_dollars,
            action=action,
        )

    def get_rebalancing_suggestions(
        self,
        portfolio: Portfolio,
        threshold_pct: float = 2.0,
    ) -> list[RebalancingSuggestion]:
        """Get suggestions for rebalancing the portfolio."""
        deviations = self.calculate_deviations(portfolio)

        suggestions = []
        for dev in deviations:
            if abs(dev.deviation_pct) >= threshold_pct:
                suggestions.append(
                    RebalancingSuggestion(
                        category=dev.category,
                        subcategory=dev.subcategory,
                        current_pct=dev.current_pct,
                        target_pct=dev.target_pct,
                        deviation_pct=dev.deviation_pct,
                        deviation_dollars=dev.deviation_dollars,
                        action=dev.action,
                    )
                )

        # Sort by absolute deviation (largest first)
        suggestions.sort(key=lambda x: abs(x.deviation_pct), reverse=True)

        return suggestions
