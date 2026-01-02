"""
Dividend Tracker Analysis Plugin

Tracks dividend income and yield across the portfolio.
"""

import logging

from src.plugins.base import AnalysisPlugin, AnalysisResult

logger = logging.getLogger(__name__)

# Known dividend yields for common ETFs and funds (approximate, as of late 2024)
# These are fallback values when actual dividend data isn't available
KNOWN_DIVIDEND_YIELDS = {
    # Broad Market ETFs
    "VTI": 1.3,    # Vanguard Total Stock Market
    "VOO": 1.3,    # Vanguard S&P 500
    "SPY": 1.2,    # SPDR S&P 500
    "IVV": 1.3,    # iShares Core S&P 500
    "VT": 1.8,     # Vanguard Total World Stock
    "ITOT": 1.3,   # iShares Core S&P Total US Stock Market

    # International ETFs
    "VXUS": 2.9,   # Vanguard Total International Stock
    "VEA": 2.9,    # Vanguard FTSE Developed Markets
    "VWO": 3.2,    # Vanguard FTSE Emerging Markets
    "IEFA": 2.5,   # iShares Core MSCI EAFE
    "EFA": 2.5,    # iShares MSCI EAFE

    # Bond ETFs
    "BND": 3.8,    # Vanguard Total Bond Market
    "AGG": 3.6,    # iShares Core US Aggregate Bond
    "BNDX": 3.5,   # Vanguard Total International Bond
    "VGIT": 3.5,   # Vanguard Intermediate-Term Treasury

    # Dividend-Focused ETFs
    "SCHD": 3.4,   # Schwab US Dividend Equity
    "VIG": 1.7,    # Vanguard Dividend Appreciation
    "VYM": 2.8,    # Vanguard High Dividend Yield
    "DVY": 3.5,    # iShares Select Dividend
    "HDV": 3.5,    # iShares Core High Dividend

    # REIT ETFs
    "VNQ": 4.0,    # Vanguard Real Estate
    "SCHH": 3.8,   # Schwab US REIT

    # Money Market / Treasury
    "SGOV": 5.0,   # iShares 0-3 Month Treasury Bond
    "BIL": 5.0,    # SPDR Bloomberg 1-3 Month T-Bill
    "SHV": 5.0,    # iShares Short Treasury Bond

    # Popular Individual Stocks (dividend payers)
    "AAPL": 0.5,
    "MSFT": 0.7,
    "JNJ": 2.9,
    "PG": 2.4,
    "KO": 3.0,
    "PEP": 2.8,
    "VZ": 6.5,
    "T": 6.5,
    "XOM": 3.4,
    "CVX": 4.0,
    "JPM": 2.3,
    "BAC": 2.5,
}


class DividendTracker(AnalysisPlugin):
    """
    Tracks dividend income and yield across the portfolio.

    Uses known dividend yields for common ETFs/funds and
    calculates estimated annual dividend income.
    """

    def analyze(self, positions: list[dict], accounts: list[dict]) -> AnalysisResult:
        """
        Analyze portfolio dividend characteristics.

        Args:
            positions: List of position dictionaries
            accounts: List of account dictionaries

        Returns:
            AnalysisResult with dividend metrics and insights
        """
        try:
            include_etfs = self.get_setting("include_etf_dividends", True)

            total_portfolio_value = 0.0
            total_weighted_yield = 0.0
            total_annual_income = 0.0
            dividend_positions = []

            for pos in positions:
                ticker = pos.get("ticker", "").upper()
                shares = pos.get("shares", 0)
                current_price = pos.get("current_price") or 0
                is_fund = pos.get("is_fund", False)

                if not ticker or shares <= 0 or current_price <= 0:
                    continue

                position_value = shares * current_price
                total_portfolio_value += position_value

                # Skip ETFs if setting is disabled
                if not include_etfs and is_fund:
                    continue

                # Get dividend yield
                dividend_yield = self._get_dividend_yield(pos)

                if dividend_yield > 0:
                    annual_income = position_value * (dividend_yield / 100)
                    total_annual_income += annual_income
                    total_weighted_yield += dividend_yield * position_value

                    dividend_positions.append({
                        "ticker": ticker,
                        "name": pos.get("name", ticker),
                        "value": position_value,
                        "dividend_yield": dividend_yield,
                        "annual_income": annual_income,
                        "shares": shares,
                        "is_fund": is_fund,
                    })

            # Calculate portfolio yield
            portfolio_yield = 0.0
            if total_portfolio_value > 0:
                portfolio_yield = total_weighted_yield / total_portfolio_value

            # Sort by annual income (highest first)
            dividend_positions.sort(key=lambda x: -x["annual_income"])

            # Find highest yield position
            highest_yield_ticker = ""
            highest_yield_value = 0.0
            if dividend_positions:
                by_yield = sorted(dividend_positions, key=lambda x: -x["dividend_yield"])
                highest_yield_ticker = by_yield[0]["ticker"]
                highest_yield_value = by_yield[0]["dividend_yield"]

            # Generate insights
            insights = self._generate_insights(
                dividend_positions,
                total_annual_income,
                portfolio_yield,
                total_portfolio_value,
            )

            # Build metrics
            metrics = {
                "estimated_annual_income": total_annual_income,
                "portfolio_yield": portfolio_yield,
                "dividend_positions": len(dividend_positions),
                "highest_yield_position": highest_yield_ticker,
                # Additional detail metrics
                "top_income_positions": dividend_positions[:10],
                "highest_yield_value": highest_yield_value,
                "total_portfolio_value": total_portfolio_value,
                "monthly_income_estimate": total_annual_income / 12,
            }

            return AnalysisResult(
                success=True,
                metrics=metrics,
                insights=insights,
            )

        except Exception as e:
            logger.exception(f"Error in dividend tracking analysis: {e}")
            return AnalysisResult(
                success=False,
                errors=[str(e)],
            )

    def _get_dividend_yield(self, position: dict) -> float:
        """
        Get dividend yield for a position.

        Checks position data first, then falls back to known yields.
        """
        # Check if position has dividend yield data
        if "dividend_yield" in position and position["dividend_yield"]:
            return float(position["dividend_yield"])

        # Fall back to known yields
        ticker = position.get("ticker", "").upper()
        return KNOWN_DIVIDEND_YIELDS.get(ticker, 0.0)

    def _generate_insights(
        self,
        dividend_positions: list[dict],
        total_income: float,
        portfolio_yield: float,
        total_value: float,
    ) -> list[str]:
        """Generate dividend-related insights."""
        insights = []

        if not dividend_positions:
            insights.append(
                "No dividend-paying positions found in your portfolio. "
                "Consider adding dividend-paying stocks or ETFs for passive income."
            )
            return insights

        # Income summary
        monthly = total_income / 12
        insights.append(
            f"Your portfolio generates an estimated ${total_income:,.2f} in annual "
            f"dividend income (${monthly:,.2f}/month) with a {portfolio_yield:.2f}% yield."
        )

        # Top income generators
        if len(dividend_positions) >= 3:
            top3 = dividend_positions[:3]
            tickers = [p["ticker"] for p in top3]
            top3_income = sum(p["annual_income"] for p in top3)
            pct = (top3_income / total_income * 100) if total_income > 0 else 0
            insights.append(
                f"Top income generators: {', '.join(tickers)} contribute "
                f"${top3_income:,.2f} ({pct:.0f}% of dividend income)."
            )

        # Yield comparison
        if portfolio_yield < 1.5:
            insights.append(
                "Your portfolio yield is below average. Consider dividend-focused "
                "ETFs like SCHD, VYM, or VIG for higher income."
            )
        elif portfolio_yield > 4.0:
            insights.append(
                "Your portfolio has a high dividend yield. Be aware that very high "
                "yields can sometimes indicate elevated risk."
            )

        # Fund vs stock breakdown
        fund_income = sum(p["annual_income"] for p in dividend_positions if p.get("is_fund"))
        stock_income = total_income - fund_income
        if fund_income > 0 and stock_income > 0:
            insights.append(
                f"Dividend sources: ${fund_income:,.2f} from funds/ETFs, "
                f"${stock_income:,.2f} from individual stocks."
            )

        return insights

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "analysis",
            "description": "Track dividend income and portfolio yield",
            "metrics": ["estimated_annual_income", "portfolio_yield", "dividend_positions"],
        }
