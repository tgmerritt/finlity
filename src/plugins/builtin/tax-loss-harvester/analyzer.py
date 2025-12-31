"""
Tax-Loss Harvester Analysis Plugin

Identifies positions with unrealized losses that could be sold
to offset capital gains and reduce tax liability.
"""

import logging
from typing import Any, Optional

from src.plugins.base import AnalysisPlugin, AnalysisResult, PluginManifest

logger = logging.getLogger(__name__)


class TaxLossHarvester(AnalysisPlugin):
    """
    Analyzes portfolio for tax-loss harvesting opportunities.

    Tax-loss harvesting is the practice of selling investments at a loss
    to offset capital gains taxes. This plugin identifies positions with
    unrealized losses and estimates potential tax savings.
    """

    def analyze(self, positions: list[dict], accounts: list[dict]) -> AnalysisResult:
        """
        Analyze portfolio for tax-loss harvesting opportunities.

        Args:
            positions: List of position dictionaries with keys:
                - ticker, shares, current_price, cost_basis, account_id, etc.
            accounts: List of account dictionaries with keys:
                - id, name, account_type, is_retirement, etc.

        Returns:
            AnalysisResult with tax-loss metrics and insights
        """
        try:
            # Get settings
            tax_rate = self.get_setting("tax_rate", 25) / 100
            min_loss = self.get_setting("min_loss_threshold", 100)
            warn_wash_sales = self.get_setting("include_wash_sale_warning", True)

            # Build account lookup for retirement status
            retirement_accounts = set()
            for account in accounts:
                if account.get("is_retirement") or self._is_retirement_type(
                    account.get("account_type", "")
                ):
                    retirement_accounts.add(account.get("id"))

            # Analyze positions
            harvesting_candidates = []
            total_unrealized_losses = 0.0
            positions_by_ticker = {}  # For wash sale detection

            for pos in positions:
                # Skip retirement accounts (no tax benefit)
                if pos.get("account_id") in retirement_accounts:
                    continue

                ticker = pos.get("ticker", "")
                shares = pos.get("shares", 0)
                current_price = pos.get("current_price") or 0
                cost_basis = pos.get("cost_basis")

                if not ticker or shares <= 0 or current_price <= 0:
                    continue

                # Track positions by ticker for wash sale detection
                if ticker not in positions_by_ticker:
                    positions_by_ticker[ticker] = []
                positions_by_ticker[ticker].append(pos)

                # Calculate unrealized gain/loss
                current_value = shares * current_price

                if cost_basis is None or cost_basis <= 0:
                    # No cost basis available, skip
                    continue

                unrealized = current_value - cost_basis

                if unrealized < 0 and abs(unrealized) >= min_loss:
                    harvesting_candidates.append({
                        "ticker": ticker,
                        "name": pos.get("name", ticker),
                        "shares": shares,
                        "current_value": current_value,
                        "cost_basis": cost_basis,
                        "unrealized_loss": abs(unrealized),
                        "loss_percent": (unrealized / cost_basis) * 100,
                        "account_name": self._get_account_name(pos.get("account_id"), accounts),
                    })
                    total_unrealized_losses += abs(unrealized)

            # Sort by loss amount (largest first)
            harvesting_candidates.sort(key=lambda x: -x["unrealized_loss"])

            # Calculate estimated tax savings
            estimated_savings = total_unrealized_losses * tax_rate

            # Find largest loss position
            largest_loss_ticker = ""
            largest_loss_amount = 0
            if harvesting_candidates:
                largest = harvesting_candidates[0]
                largest_loss_ticker = largest["ticker"]
                largest_loss_amount = largest["unrealized_loss"]

            # Generate insights
            insights = self._generate_insights(
                harvesting_candidates,
                total_unrealized_losses,
                estimated_savings,
                tax_rate,
                positions_by_ticker,
                warn_wash_sales,
            )

            # Build detailed metrics
            metrics = {
                "total_unrealized_losses": total_unrealized_losses,
                "estimated_tax_savings": estimated_savings,
                "harvesting_opportunities": len(harvesting_candidates),
                "largest_loss_position": largest_loss_ticker,
                # Additional detail metrics
                "candidates": harvesting_candidates[:10],  # Top 10 candidates
                "largest_loss_amount": largest_loss_amount,
                "tax_rate_used": tax_rate * 100,
            }

            return AnalysisResult(
                success=True,
                metrics=metrics,
                insights=insights,
            )

        except Exception as e:
            logger.exception(f"Error in tax-loss harvesting analysis: {e}")
            return AnalysisResult(
                success=False,
                errors=[str(e)],
            )

    def _is_retirement_type(self, account_type: str) -> bool:
        """Check if account type is a retirement account."""
        retirement_types = {
            "traditional_401k", "roth_401k", "traditional_ira", "roth_ira",
            "hsa", "pension", "sep_ira", "simple_ira",
        }
        return account_type.lower() in retirement_types

    def _get_account_name(self, account_id: Optional[int], accounts: list[dict]) -> str:
        """Get account name from ID."""
        if account_id is None:
            return "Unknown"
        for account in accounts:
            if account.get("id") == account_id:
                return account.get("name", "Unknown")
        return "Unknown"

    def _generate_insights(
        self,
        candidates: list[dict],
        total_losses: float,
        estimated_savings: float,
        tax_rate: float,
        positions_by_ticker: dict,
        warn_wash_sales: bool,
    ) -> list[str]:
        """Generate actionable insights from analysis."""
        insights = []

        if not candidates:
            insights.append(
                "No tax-loss harvesting opportunities found. "
                "Your taxable positions are all in the green!"
            )
            return insights

        # Summary insight
        insights.append(
            f"Found {len(candidates)} positions with unrealized losses "
            f"totaling ${total_losses:,.2f}. Harvesting these could save "
            f"approximately ${estimated_savings:,.2f} in taxes "
            f"(at {tax_rate*100:.0f}% tax rate)."
        )

        # Top opportunities
        if len(candidates) >= 1:
            top = candidates[0]
            insights.append(
                f"Largest opportunity: {top['ticker']} has an unrealized loss of "
                f"${top['unrealized_loss']:,.2f} ({abs(top['loss_percent']):.1f}% down)."
            )

        # Wash sale warnings
        if warn_wash_sales:
            wash_sale_tickers = []
            for ticker, ticker_positions in positions_by_ticker.items():
                if len(ticker_positions) > 1:
                    # Check if any position is a loss candidate
                    has_loss = any(
                        c["ticker"] == ticker for c in candidates
                    )
                    if has_loss:
                        wash_sale_tickers.append(ticker)

            if wash_sale_tickers:
                insights.append(
                    f"Wash sale warning: You hold {', '.join(wash_sale_tickers[:3])} "
                    f"in multiple accounts. Selling at a loss while holding similar "
                    f"positions may trigger wash sale rules."
                )

        # Year-end reminder
        insights.append(
            "Remember: Tax-loss harvesting must be completed by December 31 "
            "to apply to the current tax year."
        )

        return insights

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "analysis",
            "description": "Identify tax-loss harvesting opportunities",
            "metrics": ["total_unrealized_losses", "estimated_tax_savings", "harvesting_opportunities"],
        }
