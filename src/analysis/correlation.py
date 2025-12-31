"""Correlation analysis for portfolio diversification."""

from dataclasses import dataclass
from typing import Optional

import numpy as np
import pandas as pd

from src.data import PriceService
from src.models import Portfolio


@dataclass
class CorrelationMatrix:
    """Correlation matrix between portfolio positions."""

    tickers: list[str]
    matrix: list[list[float]]
    avg_correlation: float
    max_correlation: tuple[str, str, float]
    min_correlation: tuple[str, str, float]


@dataclass
class DiversificationScore:
    """Diversification quality score."""

    score: float  # 0-100, higher is better
    grade: str  # A, B, C, D, F
    description: str
    top_concentrated: list[tuple[str, str, float]]  # Highly correlated pairs
    well_diversified: list[tuple[str, str, float]]  # Negatively/lowly correlated pairs


class CorrelationAnalyzer:
    """Analyzer for portfolio correlations and diversification."""

    def __init__(self, price_service: Optional[PriceService] = None):
        self.price_service = price_service or PriceService()

    def calculate_correlation_matrix(
        self,
        portfolio: Portfolio,
        period: str = "1y",
        min_weight: float = 0.02,
    ) -> Optional[CorrelationMatrix]:
        """Calculate correlation matrix between positions."""
        # Get positions with significant weight
        positions = [
            p for p in portfolio.all_positions
            if (p.market_value / portfolio.total_value) >= min_weight
        ]

        if len(positions) < 2:
            return None

        # Get returns for each position
        returns_data = {}
        for position in positions:
            history = self.price_service.get_price_history(position.ticker, period)
            if history and len(history.returns) > 20:
                returns_data[position.ticker] = history.returns[1:]  # Skip first zero

        if len(returns_data) < 2:
            return None

        # Create DataFrame with aligned returns
        tickers = list(returns_data.keys())
        min_len = min(len(r) for r in returns_data.values())

        df = pd.DataFrame({
            ticker: returns[-min_len:]
            for ticker, returns in returns_data.items()
        })

        # Calculate correlation matrix
        corr_matrix = df.corr()

        # Convert to list of lists
        matrix = corr_matrix.values.tolist()

        # Find average, max, and min correlations (excluding diagonal)
        correlations = []
        max_corr = (-float("inf"), "", "")
        min_corr = (float("inf"), "", "")

        for i, ticker1 in enumerate(tickers):
            for j, ticker2 in enumerate(tickers):
                if i < j:  # Upper triangle only
                    corr = matrix[i][j]
                    correlations.append(corr)

                    if corr > max_corr[0]:
                        max_corr = (corr, ticker1, ticker2)
                    if corr < min_corr[0]:
                        min_corr = (corr, ticker1, ticker2)

        avg_corr = np.mean(correlations) if correlations else 0.0

        return CorrelationMatrix(
            tickers=tickers,
            matrix=matrix,
            avg_correlation=avg_corr,
            max_correlation=(max_corr[1], max_corr[2], max_corr[0]),
            min_correlation=(min_corr[1], min_corr[2], min_corr[0]),
        )

    def calculate_diversification_score(
        self,
        portfolio: Portfolio,
        period: str = "1y",
    ) -> DiversificationScore:
        """Calculate a diversification quality score."""
        corr_matrix = self.calculate_correlation_matrix(portfolio, period)

        if not corr_matrix:
            return DiversificationScore(
                score=0,
                grade="N/A",
                description="Not enough positions to calculate diversification",
                top_concentrated=[],
                well_diversified=[],
            )

        # Collect all correlation pairs
        pairs = []
        for i, ticker1 in enumerate(corr_matrix.tickers):
            for j, ticker2 in enumerate(corr_matrix.tickers):
                if i < j:
                    pairs.append((ticker1, ticker2, corr_matrix.matrix[i][j]))

        # Sort by correlation
        pairs_sorted = sorted(pairs, key=lambda x: x[2], reverse=True)

        # Identify concentrated (high correlation) and diversified (low/negative correlation)
        top_concentrated = [p for p in pairs_sorted[:5] if p[2] > 0.7]
        well_diversified = [p for p in pairs_sorted[-5:] if p[2] < 0.3]

        # Calculate score based on average correlation
        # Lower average correlation = higher score
        avg_corr = corr_matrix.avg_correlation

        # Score formula: 100 - (avg_corr * 100)
        # avg_corr of 0 = 100, avg_corr of 1 = 0, avg_corr of -1 = 200 (capped)
        raw_score = 100 - (avg_corr * 100)
        score = max(0, min(100, raw_score))

        # Grade based on score
        if score >= 80:
            grade = "A"
            description = "Excellent diversification - positions have low correlation"
        elif score >= 65:
            grade = "B"
            description = "Good diversification - moderate correlation between positions"
        elif score >= 50:
            grade = "C"
            description = "Average diversification - some highly correlated positions"
        elif score >= 35:
            grade = "D"
            description = "Poor diversification - many highly correlated positions"
        else:
            grade = "F"
            description = "Very poor diversification - positions move together"

        return DiversificationScore(
            score=score,
            grade=grade,
            description=description,
            top_concentrated=top_concentrated,
            well_diversified=well_diversified,
        )

    def get_sector_correlations(
        self,
        sectors: Optional[list[str]] = None,
        period: str = "1y",
    ) -> dict[str, dict[str, float]]:
        """Get correlations between sector ETFs."""
        if sectors is None:
            # Default sector ETFs
            sectors = {
                "Technology": "XLK",
                "Healthcare": "XLV",
                "Financials": "XLF",
                "Consumer Discretionary": "XLY",
                "Consumer Staples": "XLP",
                "Industrials": "XLI",
                "Energy": "XLE",
                "Materials": "XLB",
                "Real Estate": "XLRE",
                "Utilities": "XLU",
                "Communication": "XLC",
            }

        # Get returns for each sector
        returns_data = {}
        for name, ticker in sectors.items():
            history = self.price_service.get_price_history(ticker, period)
            if history and len(history.returns) > 20:
                returns_data[name] = history.returns[1:]

        if len(returns_data) < 2:
            return {}

        # Create DataFrame
        min_len = min(len(r) for r in returns_data.values())
        df = pd.DataFrame({
            name: returns[-min_len:]
            for name, returns in returns_data.items()
        })

        # Calculate correlations
        corr_matrix = df.corr()

        return corr_matrix.to_dict()
