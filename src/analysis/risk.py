"""Risk analysis including volatility, Sharpe ratio, and max drawdown."""

from dataclasses import dataclass
from typing import Optional

import numpy as np
import yaml

from src.data import PriceHistory, PriceService
from src.models import Portfolio


@dataclass
class RiskMetrics:
    """Risk metrics for a portfolio or position."""

    ticker: str
    volatility: float  # Annualized standard deviation of returns
    sharpe_ratio: float  # Risk-adjusted return
    sortino_ratio: float  # Downside risk-adjusted return
    max_drawdown: float  # Maximum peak-to-trough decline
    beta: Optional[float]  # Sensitivity to market movements
    var_95: float  # Value at Risk (95% confidence)
    cvar_95: float  # Conditional VaR (Expected Shortfall)


@dataclass
class PortfolioRisk:
    """Aggregate risk metrics for the portfolio."""

    volatility: float
    sharpe_ratio: float
    sortino_ratio: float
    max_drawdown: float
    beta: float
    var_95: float
    cvar_95: float
    diversification_ratio: float


class RiskAnalyzer:
    """Analyzer for portfolio and position risk metrics."""

    def __init__(
        self,
        price_service: Optional[PriceService] = None,
        config_path: str = "config.yaml",
    ):
        self.price_service = price_service or PriceService()

        # Load risk-free rate from config
        try:
            with open(config_path) as f:
                config = yaml.safe_load(f)
            self.risk_free_rate = config.get("market", {}).get("risk_free_rate", 0.04)
        except Exception:
            self.risk_free_rate = 0.04

    def calculate_volatility(self, returns: list[float]) -> float:
        """Calculate annualized volatility from daily returns."""
        if len(returns) < 2:
            return 0.0
        # Remove any zero returns at the start
        returns = [r for r in returns if r != 0]
        if not returns:
            return 0.0
        return np.std(returns) * np.sqrt(252)

    def calculate_sharpe_ratio(
        self,
        returns: list[float],
        risk_free_rate: Optional[float] = None,
    ) -> float:
        """Calculate Sharpe ratio (risk-adjusted return)."""
        if len(returns) < 2:
            return 0.0

        rf = risk_free_rate if risk_free_rate is not None else self.risk_free_rate
        daily_rf = rf / 252

        excess_returns = [r - daily_rf for r in returns if r != 0]
        if not excess_returns:
            return 0.0

        mean_excess = np.mean(excess_returns)
        std_excess = np.std(excess_returns)

        if std_excess == 0:
            return 0.0

        # Annualize
        return (mean_excess / std_excess) * np.sqrt(252)

    def calculate_sortino_ratio(
        self,
        returns: list[float],
        risk_free_rate: Optional[float] = None,
    ) -> float:
        """Calculate Sortino ratio (downside risk-adjusted return)."""
        if len(returns) < 2:
            return 0.0

        rf = risk_free_rate if risk_free_rate is not None else self.risk_free_rate
        daily_rf = rf / 252

        returns = [r for r in returns if r != 0]
        if not returns:
            return 0.0

        excess_returns = [r - daily_rf for r in returns]

        # Only consider negative returns for downside deviation
        downside_returns = [r for r in excess_returns if r < 0]

        if not downside_returns:
            return float("inf")  # No downside risk

        downside_std = np.std(downside_returns)
        if downside_std == 0:
            return 0.0

        mean_excess = np.mean(excess_returns)

        # Annualize
        return (mean_excess / downside_std) * np.sqrt(252)

    def calculate_max_drawdown(self, prices: list[float]) -> float:
        """Calculate maximum drawdown (largest peak-to-trough decline)."""
        if len(prices) < 2:
            return 0.0

        max_drawdown = 0.0
        peak = prices[0]

        for price in prices[1:]:
            if price > peak:
                peak = price
            else:
                drawdown = (peak - price) / peak
                max_drawdown = max(max_drawdown, drawdown)

        return max_drawdown

    def calculate_var(
        self,
        returns: list[float],
        confidence: float = 0.95,
    ) -> float:
        """Calculate Value at Risk at specified confidence level."""
        if not returns:
            return 0.0
        returns = [r for r in returns if r != 0]
        if not returns:
            return 0.0
        return -np.percentile(returns, (1 - confidence) * 100)

    def calculate_cvar(
        self,
        returns: list[float],
        confidence: float = 0.95,
    ) -> float:
        """Calculate Conditional VaR (Expected Shortfall)."""
        if not returns:
            return 0.0
        returns = [r for r in returns if r != 0]
        if not returns:
            return 0.0

        var = self.calculate_var(returns, confidence)
        tail_returns = [r for r in returns if r <= -var]

        if not tail_returns:
            return var

        return -np.mean(tail_returns)

    def get_position_risk(self, ticker: str, benchmark: str = "SPY") -> Optional[RiskMetrics]:
        """Get risk metrics for a single position."""
        history = self.price_service.get_price_history(ticker, period="1y")
        if not history or len(history.prices) < 20:
            return None

        returns = history.returns[1:]  # Skip first zero
        prices = history.prices

        volatility = self.calculate_volatility(returns)
        sharpe = self.calculate_sharpe_ratio(returns)
        sortino = self.calculate_sortino_ratio(returns)
        max_dd = self.calculate_max_drawdown(prices)
        var_95 = self.calculate_var(returns)
        cvar_95 = self.calculate_cvar(returns)

        # Calculate beta
        beta = self.price_service.calculate_beta(ticker, benchmark)

        return RiskMetrics(
            ticker=ticker,
            volatility=volatility * 100,  # Convert to percentage
            sharpe_ratio=sharpe,
            sortino_ratio=sortino,
            max_drawdown=max_dd * 100,  # Convert to percentage
            beta=beta,
            var_95=var_95 * 100,
            cvar_95=cvar_95 * 100,
        )

    def get_portfolio_risk(
        self,
        portfolio: Portfolio,
        benchmark: str = "SPY",
    ) -> PortfolioRisk:
        """Get aggregate risk metrics for the portfolio."""
        if not portfolio.all_positions:
            return PortfolioRisk(
                volatility=0,
                sharpe_ratio=0,
                sortino_ratio=0,
                max_drawdown=0,
                beta=0,
                var_95=0,
                cvar_95=0,
                diversification_ratio=1.0,
            )

        # Get returns for each position
        position_returns: dict[str, list[float]] = {}
        position_weights: dict[str, float] = {}

        for position in portfolio.all_positions:
            weight = position.market_value / portfolio.total_value if portfolio.total_value > 0 else 0
            if weight < 0.001:  # Skip tiny positions
                continue

            history = self.price_service.get_price_history(position.ticker, period="1y")
            if history and len(history.returns) > 1:
                position_returns[position.ticker] = history.returns[1:]
                position_weights[position.ticker] = weight

        if not position_returns:
            return PortfolioRisk(
                volatility=0,
                sharpe_ratio=0,
                sortino_ratio=0,
                max_drawdown=0,
                beta=0,
                var_95=0,
                cvar_95=0,
                diversification_ratio=1.0,
            )

        # Calculate portfolio returns (weighted sum)
        # Need to align returns by date
        min_len = min(len(r) for r in position_returns.values())
        portfolio_returns = np.zeros(min_len)

        for ticker, returns in position_returns.items():
            weight = position_weights[ticker]
            portfolio_returns += np.array(returns[-min_len:]) * weight

        # Calculate metrics
        volatility = self.calculate_volatility(portfolio_returns.tolist())
        sharpe = self.calculate_sharpe_ratio(portfolio_returns.tolist())
        sortino = self.calculate_sortino_ratio(portfolio_returns.tolist())
        var_95 = self.calculate_var(portfolio_returns.tolist())
        cvar_95 = self.calculate_cvar(portfolio_returns.tolist())

        # Calculate max drawdown from cumulative returns
        cumulative = np.cumprod(1 + portfolio_returns)
        max_dd = self.calculate_max_drawdown(cumulative.tolist())

        # Calculate weighted beta
        total_beta = 0.0
        for ticker, weight in position_weights.items():
            beta = self.price_service.calculate_beta(ticker, benchmark)
            if beta is not None:
                total_beta += weight * beta

        # Calculate diversification ratio
        # Ratio of weighted average volatility to portfolio volatility
        weighted_avg_vol = 0.0
        for ticker, returns in position_returns.items():
            weight = position_weights[ticker]
            pos_vol = self.calculate_volatility(returns)
            weighted_avg_vol += weight * pos_vol

        diversification_ratio = weighted_avg_vol / volatility if volatility > 0 else 1.0

        return PortfolioRisk(
            volatility=volatility * 100,
            sharpe_ratio=sharpe,
            sortino_ratio=sortino,
            max_drawdown=max_dd * 100,
            beta=total_beta,
            var_95=var_95 * 100,
            cvar_95=cvar_95 * 100,
            diversification_ratio=diversification_ratio,
        )
