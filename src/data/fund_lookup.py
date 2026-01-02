"""Fund composition lookup service."""

from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel


class FundComposition(BaseModel):
    """Composition breakdown for a fund."""

    ticker: str
    name: str

    # Asset allocation
    us_stock_pct: float = 0.0
    foreign_stock_pct: float = 0.0
    bonds_pct: float = 0.0
    cash_pct: float = 0.0
    other_pct: float = 0.0

    # Cap size breakdown (as % of stock allocation)
    giant_pct: float = 0.0
    large_pct: float = 0.0
    medium_pct: float = 0.0
    small_pct: float = 0.0
    micro_pct: float = 0.0

    # Sector breakdown (as % of stock allocation)
    technology_pct: float = 0.0
    healthcare_pct: float = 0.0
    financial_pct: float = 0.0
    consumer_cyclical_pct: float = 0.0
    consumer_defensive_pct: float = 0.0
    industrials_pct: float = 0.0
    energy_pct: float = 0.0
    materials_pct: float = 0.0
    real_estate_pct: float = 0.0
    utilities_pct: float = 0.0
    communication_pct: float = 0.0

    # Geography (as % of stock allocation)
    us_pct: float = 0.0
    developed_ex_us_pct: float = 0.0
    emerging_markets_pct: float = 0.0

    @property
    def total_stock_pct(self) -> float:
        return self.us_stock_pct + self.foreign_stock_pct

    @property
    def consumer_pct(self) -> float:
        return self.consumer_cyclical_pct + self.consumer_defensive_pct

    @property
    def energy_materials_pct(self) -> float:
        return self.energy_pct + self.materials_pct


class FundLookupService:
    """Service for looking up fund composition data."""

    def __init__(self, funds_path: str = "funds.yaml"):
        self.funds_path = Path(funds_path)
        self.funds: dict[str, FundComposition] = {}
        self._load_funds()

    def _load_funds(self) -> None:
        """Load fund data from YAML file."""
        if not self.funds_path.exists():
            # Create default funds file if it doesn't exist
            self._create_default_funds_file()

        try:
            with open(self.funds_path) as f:
                data = yaml.safe_load(f)

            for ticker, fund_data in data.get("funds", {}).items():
                self.funds[ticker.upper()] = FundComposition(
                    ticker=ticker.upper(),
                    **fund_data,
                )
        except Exception:
            pass

    def _create_default_funds_file(self) -> None:
        """Create default funds.yaml with common fund compositions."""
        default_funds = {
            "funds": {
                # Vanguard ETFs
                "VTI": {
                    "name": "Vanguard Total Stock Market ETF",
                    "us_stock_pct": 99.5,
                    "foreign_stock_pct": 0.5,
                    "giant_pct": 46.0,
                    "large_pct": 26.0,
                    "medium_pct": 17.0,
                    "small_pct": 8.5,
                    "micro_pct": 2.5,
                    "technology_pct": 31.0,
                    "healthcare_pct": 12.0,
                    "financial_pct": 13.0,
                    "consumer_cyclical_pct": 10.0,
                    "consumer_defensive_pct": 5.0,
                    "industrials_pct": 10.0,
                    "energy_pct": 4.0,
                    "materials_pct": 2.0,
                    "real_estate_pct": 3.0,
                    "utilities_pct": 3.0,
                    "communication_pct": 8.0,
                    "us_pct": 99.5,
                    "developed_ex_us_pct": 0.5,
                    "emerging_markets_pct": 0.0,
                },
                "VOO": {
                    "name": "Vanguard S&P 500 ETF",
                    "us_stock_pct": 100.0,
                    "giant_pct": 54.0,
                    "large_pct": 35.0,
                    "medium_pct": 11.0,
                    "technology_pct": 32.0,
                    "healthcare_pct": 12.0,
                    "financial_pct": 13.0,
                    "consumer_cyclical_pct": 10.0,
                    "consumer_defensive_pct": 6.0,
                    "industrials_pct": 9.0,
                    "energy_pct": 4.0,
                    "materials_pct": 2.0,
                    "real_estate_pct": 2.0,
                    "utilities_pct": 2.0,
                    "communication_pct": 8.0,
                    "us_pct": 100.0,
                },
                "VXUS": {
                    "name": "Vanguard Total International Stock ETF",
                    "foreign_stock_pct": 100.0,
                    "giant_pct": 44.0,
                    "large_pct": 30.0,
                    "medium_pct": 18.0,
                    "small_pct": 7.0,
                    "micro_pct": 1.0,
                    "technology_pct": 15.0,
                    "healthcare_pct": 10.0,
                    "financial_pct": 20.0,
                    "consumer_cyclical_pct": 12.0,
                    "consumer_defensive_pct": 8.0,
                    "industrials_pct": 14.0,
                    "energy_pct": 5.0,
                    "materials_pct": 7.0,
                    "real_estate_pct": 2.0,
                    "utilities_pct": 3.0,
                    "communication_pct": 5.0,
                    "developed_ex_us_pct": 77.0,
                    "emerging_markets_pct": 23.0,
                },
                "VWO": {
                    "name": "Vanguard Emerging Markets ETF",
                    "foreign_stock_pct": 100.0,
                    "giant_pct": 30.0,
                    "large_pct": 35.0,
                    "medium_pct": 25.0,
                    "small_pct": 8.0,
                    "micro_pct": 2.0,
                    "technology_pct": 25.0,
                    "healthcare_pct": 4.0,
                    "financial_pct": 22.0,
                    "consumer_cyclical_pct": 14.0,
                    "consumer_defensive_pct": 6.0,
                    "industrials_pct": 6.0,
                    "energy_pct": 6.0,
                    "materials_pct": 7.0,
                    "real_estate_pct": 2.0,
                    "utilities_pct": 3.0,
                    "communication_pct": 5.0,
                    "emerging_markets_pct": 100.0,
                },
                "BND": {
                    "name": "Vanguard Total Bond Market ETF",
                    "bonds_pct": 100.0,
                },
                "VNQ": {
                    "name": "Vanguard Real Estate ETF",
                    "us_stock_pct": 100.0,
                    "real_estate_pct": 100.0,
                    "us_pct": 100.0,
                },
                # Fidelity funds
                "FXAIX": {
                    "name": "Fidelity 500 Index Fund",
                    "us_stock_pct": 100.0,
                    "giant_pct": 54.0,
                    "large_pct": 35.0,
                    "medium_pct": 11.0,
                    "technology_pct": 32.0,
                    "healthcare_pct": 12.0,
                    "financial_pct": 13.0,
                    "consumer_cyclical_pct": 10.0,
                    "consumer_defensive_pct": 6.0,
                    "industrials_pct": 9.0,
                    "energy_pct": 4.0,
                    "materials_pct": 2.0,
                    "real_estate_pct": 2.0,
                    "utilities_pct": 2.0,
                    "communication_pct": 8.0,
                    "us_pct": 100.0,
                },
                "FSKAX": {
                    "name": "Fidelity Total Market Index Fund",
                    "us_stock_pct": 99.5,
                    "foreign_stock_pct": 0.5,
                    "giant_pct": 46.0,
                    "large_pct": 26.0,
                    "medium_pct": 17.0,
                    "small_pct": 8.5,
                    "micro_pct": 2.5,
                    "technology_pct": 31.0,
                    "healthcare_pct": 12.0,
                    "financial_pct": 13.0,
                    "consumer_cyclical_pct": 10.0,
                    "consumer_defensive_pct": 5.0,
                    "industrials_pct": 10.0,
                    "energy_pct": 4.0,
                    "materials_pct": 2.0,
                    "real_estate_pct": 3.0,
                    "utilities_pct": 3.0,
                    "communication_pct": 8.0,
                    "us_pct": 99.5,
                    "developed_ex_us_pct": 0.5,
                },
                "FTIHX": {
                    "name": "Fidelity Total International Index Fund",
                    "foreign_stock_pct": 100.0,
                    "giant_pct": 44.0,
                    "large_pct": 30.0,
                    "medium_pct": 18.0,
                    "small_pct": 7.0,
                    "micro_pct": 1.0,
                    "technology_pct": 15.0,
                    "healthcare_pct": 10.0,
                    "financial_pct": 20.0,
                    "consumer_cyclical_pct": 12.0,
                    "consumer_defensive_pct": 8.0,
                    "industrials_pct": 14.0,
                    "energy_pct": 5.0,
                    "materials_pct": 7.0,
                    "real_estate_pct": 2.0,
                    "utilities_pct": 3.0,
                    "communication_pct": 5.0,
                    "developed_ex_us_pct": 77.0,
                    "emerging_markets_pct": 23.0,
                },
                # Schwab funds
                "SWPPX": {
                    "name": "Schwab S&P 500 Index Fund",
                    "us_stock_pct": 100.0,
                    "giant_pct": 54.0,
                    "large_pct": 35.0,
                    "medium_pct": 11.0,
                    "technology_pct": 32.0,
                    "healthcare_pct": 12.0,
                    "financial_pct": 13.0,
                    "consumer_cyclical_pct": 10.0,
                    "consumer_defensive_pct": 6.0,
                    "industrials_pct": 9.0,
                    "energy_pct": 4.0,
                    "materials_pct": 2.0,
                    "real_estate_pct": 2.0,
                    "utilities_pct": 2.0,
                    "communication_pct": 8.0,
                    "us_pct": 100.0,
                },
                "SWTSX": {
                    "name": "Schwab Total Stock Market Index Fund",
                    "us_stock_pct": 99.5,
                    "foreign_stock_pct": 0.5,
                    "giant_pct": 46.0,
                    "large_pct": 26.0,
                    "medium_pct": 17.0,
                    "small_pct": 8.5,
                    "micro_pct": 2.5,
                    "technology_pct": 31.0,
                    "healthcare_pct": 12.0,
                    "financial_pct": 13.0,
                    "consumer_cyclical_pct": 10.0,
                    "consumer_defensive_pct": 5.0,
                    "industrials_pct": 10.0,
                    "energy_pct": 4.0,
                    "materials_pct": 2.0,
                    "real_estate_pct": 3.0,
                    "utilities_pct": 3.0,
                    "communication_pct": 8.0,
                    "us_pct": 99.5,
                    "developed_ex_us_pct": 0.5,
                },
                # QQQ / Tech focused
                "QQQ": {
                    "name": "Invesco QQQ Trust",
                    "us_stock_pct": 100.0,
                    "giant_pct": 60.0,
                    "large_pct": 30.0,
                    "medium_pct": 10.0,
                    "technology_pct": 58.0,
                    "healthcare_pct": 6.0,
                    "financial_pct": 1.0,
                    "consumer_cyclical_pct": 14.0,
                    "consumer_defensive_pct": 5.0,
                    "industrials_pct": 5.0,
                    "energy_pct": 1.0,
                    "utilities_pct": 1.0,
                    "communication_pct": 9.0,
                    "us_pct": 100.0,
                },
                # SPY
                "SPY": {
                    "name": "SPDR S&P 500 ETF Trust",
                    "us_stock_pct": 100.0,
                    "giant_pct": 54.0,
                    "large_pct": 35.0,
                    "medium_pct": 11.0,
                    "technology_pct": 32.0,
                    "healthcare_pct": 12.0,
                    "financial_pct": 13.0,
                    "consumer_cyclical_pct": 10.0,
                    "consumer_defensive_pct": 6.0,
                    "industrials_pct": 9.0,
                    "energy_pct": 4.0,
                    "materials_pct": 2.0,
                    "real_estate_pct": 2.0,
                    "utilities_pct": 2.0,
                    "communication_pct": 8.0,
                    "us_pct": 100.0,
                },
            }
        }

        with open(self.funds_path, "w") as f:
            yaml.dump(default_funds, f, default_flow_style=False, sort_keys=False)

        # Also load the data
        for ticker, fund_data in default_funds["funds"].items():
            self.funds[ticker.upper()] = FundComposition(
                ticker=ticker.upper(),
                **fund_data,
            )

    def get_fund(self, ticker: str) -> Optional[FundComposition]:
        """Get fund composition by ticker."""
        return self.funds.get(ticker.upper())

    def add_fund(self, composition: FundComposition) -> None:
        """Add or update a fund composition."""
        self.funds[composition.ticker.upper()] = composition
        self._save_funds()

    def _save_funds(self) -> None:
        """Save funds to YAML file."""
        data = {"funds": {}}
        for ticker, fund in self.funds.items():
            fund_dict = fund.model_dump()
            del fund_dict["ticker"]  # Don't duplicate ticker in the data
            data["funds"][ticker] = fund_dict

        with open(self.funds_path, "w") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)

    def calculate_lookthrough(
        self,
        ticker: str,
        value: float,
    ) -> dict[str, float]:
        """
        Calculate look-through allocation for a fund.
        Returns dollar amounts by category.
        """
        fund = self.get_fund(ticker)
        if not fund:
            return {"unknown": value}

        return {
            "us_stock": value * fund.us_stock_pct / 100,
            "foreign_stock": value * fund.foreign_stock_pct / 100,
            "bonds": value * fund.bonds_pct / 100,
            "cash": value * fund.cash_pct / 100,
            "other": value * fund.other_pct / 100,
            # Sector breakdown (of total stock allocation)
            "technology": value * fund.total_stock_pct / 100 * fund.technology_pct / 100,
            "healthcare": value * fund.total_stock_pct / 100 * fund.healthcare_pct / 100,
            "financial": value * fund.total_stock_pct / 100 * fund.financial_pct / 100,
            "consumer": value * fund.total_stock_pct / 100 * fund.consumer_pct / 100,
            "industrials": value * fund.total_stock_pct / 100 * fund.industrials_pct / 100,
            "energy_materials": value * fund.total_stock_pct / 100 * fund.energy_materials_pct / 100,
            "real_estate": value * fund.total_stock_pct / 100 * fund.real_estate_pct / 100,
            "utilities": value * fund.total_stock_pct / 100 * fund.utilities_pct / 100,
            "communication": value * fund.total_stock_pct / 100 * fund.communication_pct / 100,
            # Geography breakdown
            "us": value * fund.total_stock_pct / 100 * fund.us_pct / 100,
            "developed_ex_us": value * fund.total_stock_pct / 100 * fund.developed_ex_us_pct / 100,
            "emerging": value * fund.total_stock_pct / 100 * fund.emerging_markets_pct / 100,
            # Cap size breakdown
            "giant": value * fund.total_stock_pct / 100 * fund.giant_pct / 100,
            "large": value * fund.total_stock_pct / 100 * fund.large_pct / 100,
            "medium": value * fund.total_stock_pct / 100 * fund.medium_pct / 100,
            "small": value * fund.total_stock_pct / 100 * fund.small_pct / 100,
            "micro": value * fund.total_stock_pct / 100 * fund.micro_pct / 100,
        }
