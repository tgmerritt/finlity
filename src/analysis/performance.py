"""Performance analysis for portfolio returns."""

from dataclasses import dataclass
from datetime import date
from typing import Optional


from src.data import PriceService
from src.models import Portfolio
from src.models.position_types import is_updatable_position


@dataclass
class PerformanceMetrics:
    """Performance metrics for a portfolio or position."""

    ticker: str
    daily_return: float
    weekly_return: float
    monthly_return: float
    ytd_return: float
    one_year_return: float
    three_year_cagr: Optional[float]
    five_year_cagr: Optional[float]


@dataclass
class PortfolioPerformance:
    """Aggregate performance for the entire portfolio."""

    total_value: float
    total_cost_basis: Optional[float]
    total_gain_loss: Optional[float]
    total_gain_loss_pct: Optional[float]
    ytd_return: float
    one_year_return: float
    benchmark_ytd: float
    benchmark_one_year: float
    alpha_ytd: float
    alpha_one_year: float


class PerformanceAnalyzer:
    """Analyzer for portfolio and position performance."""

    def __init__(self, price_service: Optional[PriceService] = None):
        self.price_service = price_service or PriceService()

    def calculate_returns(self, prices: list[float]) -> list[float]:
        """Calculate returns from a price series."""
        if len(prices) < 2:
            return [0.0]

        returns = [0.0]
        for i in range(1, len(prices)):
            if prices[i - 1] != 0:
                returns.append((prices[i] - prices[i - 1]) / prices[i - 1])
            else:
                returns.append(0.0)
        return returns

    def calculate_total_return(self, start_price: float, end_price: float) -> float:
        """Calculate total return between two prices."""
        if start_price == 0:
            return 0.0
        return (end_price - start_price) / start_price

    def calculate_cagr(self, start_value: float, end_value: float, years: float) -> float:
        """Calculate Compound Annual Growth Rate."""
        if start_value <= 0 or years <= 0:
            return 0.0
        return (end_value / start_value) ** (1 / years) - 1

    def get_position_performance(self, ticker: str) -> Optional[PerformanceMetrics]:
        """Get performance metrics for a single position."""
        history = self.price_service.get_price_history(ticker, period="5y")
        if not history or len(history.prices) < 2:
            return None

        prices = history.prices
        dates = history.dates

        # Calculate various returns
        daily_return = self.calculate_total_return(prices[-2], prices[-1]) if len(prices) >= 2 else 0.0

        # Weekly (5 trading days)
        weekly_return = self.calculate_total_return(prices[-6], prices[-1]) if len(prices) >= 6 else 0.0

        # Monthly (21 trading days)
        monthly_return = self.calculate_total_return(prices[-22], prices[-1]) if len(prices) >= 22 else 0.0

        # YTD
        current_year = date.today().year
        ytd_start_idx = next(
            (i for i, d in enumerate(dates) if d.year == current_year),
            0,
        )
        ytd_return = self.calculate_total_return(prices[ytd_start_idx], prices[-1])

        # 1 year (252 trading days)
        one_year_return = self.calculate_total_return(prices[-253], prices[-1]) if len(prices) >= 253 else 0.0

        # 3 year CAGR
        three_year_cagr = None
        if len(prices) >= 756:  # ~3 years of trading days
            three_year_cagr = self.calculate_cagr(prices[-756], prices[-1], 3)

        # 5 year CAGR
        five_year_cagr = None
        if len(prices) >= 1260:  # ~5 years of trading days
            five_year_cagr = self.calculate_cagr(prices[-1260], prices[-1], 5)

        return PerformanceMetrics(
            ticker=ticker,
            daily_return=daily_return * 100,
            weekly_return=weekly_return * 100,
            monthly_return=monthly_return * 100,
            ytd_return=ytd_return * 100,
            one_year_return=one_year_return * 100,
            three_year_cagr=three_year_cagr * 100 if three_year_cagr else None,
            five_year_cagr=five_year_cagr * 100 if five_year_cagr else None,
        )

    def get_portfolio_performance(
        self,
        portfolio: Portfolio,
        benchmark: str = "SPY",
    ) -> PortfolioPerformance:
        """Get aggregate performance for the portfolio."""
        # Calculate total gain/loss
        total_cost_basis = portfolio.total_value  # We don't have historical cost basis
        if portfolio.accounts:
            total_cost_basis = sum(
                a.total_cost_basis for a in portfolio.accounts if a.total_cost_basis
            ) or None

        total_gain_loss = None
        total_gain_loss_pct = None
        if total_cost_basis:
            total_gain_loss = portfolio.total_value - total_cost_basis
            total_gain_loss_pct = (total_gain_loss / total_cost_basis) * 100

        # Get benchmark performance
        bench_perf = self.get_position_performance(benchmark)
        bench_ytd = bench_perf.ytd_return if bench_perf else 0.0
        bench_one_year = bench_perf.one_year_return if bench_perf else 0.0

        # Calculate weighted portfolio returns
        # This is a simplified calculation - assumes current weights
        ytd_return = 0.0
        one_year_return = 0.0

        for position in portfolio.all_positions:
            if not is_updatable_position(None, position.ticker):
                continue  # cash/CD sentinels and option tickers have no quotable history
            weight = position.market_value / portfolio.total_value if portfolio.total_value > 0 else 0
            perf = self.get_position_performance(position.ticker)
            if perf:
                ytd_return += weight * perf.ytd_return
                one_year_return += weight * perf.one_year_return

        return PortfolioPerformance(
            total_value=portfolio.total_value,
            total_cost_basis=total_cost_basis,
            total_gain_loss=total_gain_loss,
            total_gain_loss_pct=total_gain_loss_pct,
            ytd_return=ytd_return,
            one_year_return=one_year_return,
            benchmark_ytd=bench_ytd,
            benchmark_one_year=bench_one_year,
            alpha_ytd=ytd_return - bench_ytd,
            alpha_one_year=one_year_return - bench_one_year,
        )

    def calculate_time_weighted_return(
        self,
        values: list[float],
        cash_flows: list[float],
    ) -> float:
        """
        Calculate time-weighted return, accounting for cash flows.
        This is the industry standard for measuring investment performance.
        """
        if len(values) < 2:
            return 0.0

        # Calculate sub-period returns
        sub_returns = []
        for i in range(1, len(values)):
            # Adjust for cash flow at beginning of period
            start_value = values[i - 1] + cash_flows[i] if i < len(cash_flows) else values[i - 1]
            if start_value != 0:
                sub_returns.append(values[i] / start_value)
            else:
                sub_returns.append(1.0)

        # Compound the sub-period returns
        twr = 1.0
        for r in sub_returns:
            twr *= r

        return twr - 1.0
