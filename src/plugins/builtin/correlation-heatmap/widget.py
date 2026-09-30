"""
Correlation Heatmap Widget Plugin.

Displays an interactive correlation matrix showing relationships
between portfolio holdings based on actual price history correlations.
"""

import logging
from typing import Any, Optional

from src.plugins.base import WidgetPlugin, WidgetContent, PluginManifest
from src.data import PriceService
from src.models.position_types import is_option, is_updatable_position, parse_occ_ticker

logger = logging.getLogger(__name__)


class CorrelationHeatmapWidget(WidgetPlugin):
    """Widget showing correlation heatmap of portfolio holdings."""

    def __init__(self, manifest: PluginManifest, settings: dict[str, Any] = None):
        super().__init__(manifest, settings)
        self._price_service = None

    @property
    def price_service(self) -> PriceService:
        """Lazy-load price service."""
        if self._price_service is None:
            self._price_service = PriceService()
        return self._price_service

    def render(self, positions: list[dict], accounts: list[dict]) -> WidgetContent:
        """Render the correlation heatmap widget."""
        min_positions = self.get_setting("min_positions", 2)
        show_values = self.get_setting("show_values", True)
        max_positions = self.get_setting("max_positions", 20)

        # Filter to positions with values and aggregate by ticker
        ticker_values = {}
        position_types: dict[str, Optional[str]] = {}
        for p in positions:
            if p.get("current_price") and p.get("shares"):
                ticker = p.get("ticker", "Unknown")
                # Options have no quotable price history; without this skip
                # they render as matrix rows of 0.5 filler correlations.
                if is_option(p.get("position_type")) or parse_occ_ticker(str(ticker)):
                    continue
                value = p.get("current_price", 0) * p.get("shares", 0)
                ticker_values[ticker] = ticker_values.get(ticker, 0) + value
                position_types.setdefault(ticker, p.get("position_type"))

        if len(ticker_values) < min_positions:
            return WidgetContent(
                html=f"""
                <div class="widget-empty">
                    <p>Need at least {min_positions} positions with prices to show correlation.</p>
                </div>
                """,
                data={"positions_count": len(ticker_values)},
            )

        # Sort by value and take top positions
        sorted_tickers = sorted(ticker_values.items(), key=lambda x: x[1], reverse=True)
        tickers = [t[0] for t in sorted_tickers[:max_positions]]

        # Calculate real correlation matrix from price history
        matrix = self._calculate_price_correlations(tickers, position_types)

        if matrix is None:
            # Fallback to sector-based if price data unavailable
            matrix = self._calculate_sector_correlations(tickers, positions)

        n = len(tickers)

        # Calculate portfolio-level metrics
        avg_correlation = 0
        count = 0
        for i in range(n):
            for j in range(i + 1, n):
                avg_correlation += matrix[i][j]
                count += 1

        if count > 0:
            avg_correlation = round(avg_correlation / count, 2)

        # Determine diversification quality
        if avg_correlation < 0.3:
            diversification = "Excellent"
            div_class = "excellent"
        elif avg_correlation < 0.5:
            diversification = "Good"
            div_class = "good"
        elif avg_correlation < 0.7:
            diversification = "Moderate"
            div_class = "moderate"
        else:
            diversification = "Poor"
            div_class = "poor"

        # Generate HTML
        html = self._generate_html(
            tickers, matrix, avg_correlation, diversification, div_class, show_values
        )

        return WidgetContent(
            html=html,
            data={
                "tickers": tickers,
                "matrix": matrix,
                "average_correlation": avg_correlation,
                "diversification": diversification,
            },
            scripts=[],
            styles=[],
        )

    def _calculate_price_correlations(
        self,
        tickers: list[str],
        position_types: Optional[dict[str, Optional[str]]] = None,
    ) -> Optional[list[list[float]]]:
        """Calculate actual correlations from price history using yfinance."""
        import pandas as pd

        # Only request history for tradeable tickers; cash, CDs and real
        # estate placeholders (RE) would otherwise be sent to Yahoo.
        types = position_types or {}
        tradeable_tickers = [
            t for t in tickers if is_updatable_position(types.get(t), t)
        ]

        if len(tradeable_tickers) < 2:
            return None

        try:
            import yfinance as yf

            # Fetch 1 year of daily data for all tickers at once
            # Normalize ticker symbols (e.g., BRK/B -> BRK-B)
            normalized = {t: t.replace("/", "-") for t in tradeable_tickers}
            symbols = list(normalized.values())

            data = yf.download(
                symbols,
                period="1y",
                interval="1d",
                progress=False,
                auto_adjust=True,
            )

            if data.empty:
                return None

            # Handle single ticker case
            if len(symbols) == 1:
                prices = data[["Close"]].copy()
                prices.columns = [symbols[0]]
            else:
                prices = data["Close"].copy()

            # Calculate daily returns (fill_method=None to avoid FutureWarning)
            returns = prices.pct_change(fill_method=None).dropna()

            if len(returns) < 20:
                return None

            # Calculate correlation matrix
            corr_df = returns.corr()

            # Build matrix for all requested tickers (including non-tradeable)
            matrix = []

            for i, ticker1 in enumerate(tickers):
                row = []
                norm1 = ticker1.replace("/", "-")
                for j, ticker2 in enumerate(tickers):
                    norm2 = ticker2.replace("/", "-")
                    if i == j:
                        row.append(1.0)
                    elif norm1 in corr_df.columns and norm2 in corr_df.columns:
                        corr = corr_df.loc[norm1, norm2]
                        if pd.isna(corr):
                            row.append(0.5)
                        else:
                            row.append(round(float(corr), 2))
                    else:
                        # Non-tradeable or missing - use moderate default
                        row.append(0.5)
                matrix.append(row)

            return matrix

        except ImportError:
            # yfinance not installed, fall back to PriceService
            pass
        except Exception as e:
            print(f"Error calculating correlations with yfinance: {e}")

        # Fall back to PriceService method
        returns_data = {}
        for ticker in tradeable_tickers:
            try:
                history = self.price_service.get_price_history(ticker, "1y")
                if history and len(history.returns) > 20:
                    returns_data[ticker] = history.returns[1:]
            except Exception:
                logger.debug("Failed to fetch price history for %s", ticker, exc_info=True)

        if len(returns_data) < 2:
            return None

        min_len = min(len(r) for r in returns_data.values())
        if min_len < 20:
            return None

        df = pd.DataFrame({
            ticker: returns[-min_len:]
            for ticker, returns in returns_data.items()
        })

        corr_df = df.corr()

        matrix = []

        for i, ticker1 in enumerate(tickers):
            row = []
            for j, ticker2 in enumerate(tickers):
                if i == j:
                    row.append(1.0)
                elif ticker1 in corr_df.columns and ticker2 in corr_df.columns:
                    corr = corr_df.loc[ticker1, ticker2]
                    if pd.isna(corr):
                        row.append(0.5)
                    else:
                        row.append(round(float(corr), 2))
                else:
                    row.append(0.5)
            matrix.append(row)

        return matrix

    def _calculate_sector_correlations(
        self, tickers: list[str], positions: list[dict]
    ) -> list[list[float]]:
        """Fallback: estimate correlations based on sector."""
        # Build sector lookup
        sector_map = {}
        for p in positions:
            ticker = p.get("ticker")
            sector = p.get("sector", "other").lower()
            if ticker and ticker not in sector_map:
                sector_map[ticker] = sector

        # Sector correlation estimates
        SECTOR_CORRELATIONS = {
            ("technology", "technology"): 1.0,
            ("technology", "healthcare"): 0.45,
            ("technology", "financials"): 0.55,
            ("technology", "consumer"): 0.60,
            ("technology", "industrials"): 0.50,
            ("technology", "energy"): 0.25,
            ("technology", "utilities"): 0.15,
            ("technology", "real_estate"): 0.35,
            ("healthcare", "healthcare"): 1.0,
            ("healthcare", "financials"): 0.45,
            ("healthcare", "consumer"): 0.50,
            ("healthcare", "industrials"): 0.45,
            ("healthcare", "energy"): 0.25,
            ("healthcare", "utilities"): 0.30,
            ("healthcare", "real_estate"): 0.35,
            ("financials", "financials"): 1.0,
            ("financials", "consumer"): 0.55,
            ("financials", "industrials"): 0.60,
            ("financials", "energy"): 0.45,
            ("financials", "utilities"): 0.35,
            ("financials", "real_estate"): 0.50,
            ("consumer", "consumer"): 1.0,
            ("consumer", "industrials"): 0.55,
            ("consumer", "energy"): 0.35,
            ("consumer", "utilities"): 0.30,
            ("consumer", "real_estate"): 0.45,
            ("industrials", "industrials"): 1.0,
            ("industrials", "energy"): 0.50,
            ("industrials", "utilities"): 0.40,
            ("industrials", "real_estate"): 0.45,
            ("energy", "energy"): 1.0,
            ("energy", "utilities"): 0.45,
            ("energy", "real_estate"): 0.30,
            ("utilities", "utilities"): 1.0,
            ("utilities", "real_estate"): 0.35,
            ("real_estate", "real_estate"): 1.0,
            # Other sector defaults
            ("other", "other"): 0.70,
        }

        def get_sector_corr(s1: str, s2: str) -> float:
            if s1 == s2:
                return 1.0 if s1 != "other" else 0.70
            key1 = (s1, s2)
            key2 = (s2, s1)
            # For "other" sector, use moderate correlation
            if s1 == "other" or s2 == "other":
                return 0.55
            return SECTOR_CORRELATIONS.get(key1, SECTOR_CORRELATIONS.get(key2, 0.55))

        matrix = []

        for i, ticker1 in enumerate(tickers):
            row = []
            sector1 = sector_map.get(ticker1, "other")
            for j, ticker2 in enumerate(tickers):
                if i == j:
                    row.append(1.0)
                else:
                    sector2 = sector_map.get(ticker2, "other")
                    row.append(round(get_sector_corr(sector1, sector2), 2))
            matrix.append(row)

        return matrix

    def _generate_html(
        self,
        tickers: list[str],
        matrix: list[list[float]],
        avg_correlation: float,
        diversification: str,
        div_class: str,
        show_values: bool,
    ) -> str:
        """Generate HTML for the heatmap."""
        n = len(tickers)

        # Build table rows
        rows = []
        for i, ticker in enumerate(tickers):
            cells = [f'<th class="row-header">{ticker}</th>']
            for j in range(n):
                corr = matrix[i][j]
                color = self._get_cell_color(corr)
                value_text = f"{corr:.2f}" if show_values else ""
                cells.append(
                    f'<td style="background-color: {color};" title="{ticker} vs {tickers[j]}: {corr:.2f}">'
                    f'{value_text}</td>'
                )
            rows.append(f'<tr>{"".join(cells)}</tr>')

        # Header row
        header_cells = ['<th></th>'] + [f'<th>{t}</th>' for t in tickers]
        header_row = f'<tr>{"".join(header_cells)}</tr>'

        html = f"""
        <div class="correlation-widget">
            <div class="correlation-summary">
                <div class="summary-item">
                    <span class="label">Avg Correlation:</span>
                    <span class="value">{avg_correlation:.2f}</span>
                </div>
                <div class="summary-item">
                    <span class="label">Diversification:</span>
                    <span class="value {div_class}">{diversification}</span>
                </div>
            </div>
            <div class="heatmap-container">
                <table class="correlation-matrix">
                    <thead>{header_row}</thead>
                    <tbody>{"".join(rows)}</tbody>
                </table>
            </div>
            <div class="correlation-legend">
                <span class="legend-label">Low (-1)</span>
                <div class="legend-gradient"></div>
                <span class="legend-label">High (+1)</span>
            </div>
        </div>
        """
        return html

    def _get_cell_color(self, correlation: float) -> str:
        """Get background color for correlation value."""
        # Handle negative correlations: blue
        # Low positive: green
        # High positive: red
        if correlation < 0:
            # Blue for negative correlation
            intensity = min(1.0, abs(correlation))
            r = int(100 * (1 - intensity))
            g = int(150 * (1 - intensity))
            b = int(200 + 55 * intensity)
            return f"rgba({r}, {g}, {b}, 0.7)"
        elif correlation <= 0.5:
            # Green to Yellow
            r = int(255 * (correlation * 2))
            g = 200
            b = 100
        else:
            # Yellow to Red
            r = 255
            g = int(200 * (1 - (correlation - 0.5) * 2))
            b = int(100 * (1 - (correlation - 0.5) * 2))

        return f"rgba({r}, {g}, {b}, 0.7)"

    def get_info(self) -> dict:
        """Return plugin information."""
        config = self.get_config()
        return {
            "name": self.name,
            "version": self.version,
            "type": "widget",
            "title": config.title if config else "Correlation Heatmap",
            "description": "Shows correlation between portfolio holdings based on price history",
        }
