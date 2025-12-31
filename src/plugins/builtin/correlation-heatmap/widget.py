"""
Correlation Heatmap Widget Plugin.

Displays an interactive correlation matrix showing relationships
between portfolio holdings based on asset class and sector.
"""

from typing import Any

from src.plugins.base import WidgetPlugin, WidgetContent, PluginManifest


# Known correlations between asset classes (approximate historical values)
ASSET_CLASS_CORRELATIONS = {
    ("stocks", "stocks"): 1.0,
    ("stocks", "bonds"): 0.2,
    ("stocks", "real_estate"): 0.65,
    ("stocks", "commodities"): 0.4,
    ("stocks", "cash"): 0.0,
    ("stocks", "crypto"): 0.5,
    ("bonds", "bonds"): 1.0,
    ("bonds", "real_estate"): 0.3,
    ("bonds", "commodities"): 0.1,
    ("bonds", "cash"): 0.1,
    ("bonds", "crypto"): 0.1,
    ("real_estate", "real_estate"): 1.0,
    ("real_estate", "commodities"): 0.35,
    ("real_estate", "cash"): 0.0,
    ("real_estate", "crypto"): 0.3,
    ("commodities", "commodities"): 1.0,
    ("commodities", "cash"): 0.0,
    ("commodities", "crypto"): 0.4,
    ("cash", "cash"): 1.0,
    ("cash", "crypto"): 0.0,
    ("crypto", "crypto"): 1.0,
}

# Known correlations between sectors (approximate)
SECTOR_CORRELATIONS = {
    ("technology", "technology"): 1.0,
    ("technology", "healthcare"): 0.5,
    ("technology", "financials"): 0.6,
    ("technology", "consumer"): 0.65,
    ("technology", "industrials"): 0.55,
    ("technology", "energy"): 0.3,
    ("technology", "utilities"): 0.2,
    ("technology", "real_estate"): 0.4,
    ("healthcare", "healthcare"): 1.0,
    ("healthcare", "financials"): 0.5,
    ("healthcare", "consumer"): 0.55,
    ("healthcare", "industrials"): 0.5,
    ("healthcare", "energy"): 0.3,
    ("healthcare", "utilities"): 0.35,
    ("healthcare", "real_estate"): 0.4,
    ("financials", "financials"): 1.0,
    ("financials", "consumer"): 0.6,
    ("financials", "industrials"): 0.65,
    ("financials", "energy"): 0.5,
    ("financials", "utilities"): 0.4,
    ("financials", "real_estate"): 0.55,
    ("consumer", "consumer"): 1.0,
    ("consumer", "industrials"): 0.6,
    ("consumer", "energy"): 0.4,
    ("consumer", "utilities"): 0.35,
    ("consumer", "real_estate"): 0.5,
    ("industrials", "industrials"): 1.0,
    ("industrials", "energy"): 0.55,
    ("industrials", "utilities"): 0.45,
    ("industrials", "real_estate"): 0.5,
    ("energy", "energy"): 1.0,
    ("energy", "utilities"): 0.5,
    ("energy", "real_estate"): 0.35,
    ("utilities", "utilities"): 1.0,
    ("utilities", "real_estate"): 0.4,
    ("real_estate", "real_estate"): 1.0,
}


def get_correlation(asset1: str, asset2: str, correlation_map: dict) -> float:
    """Get correlation between two assets from correlation map."""
    key1 = (asset1.lower(), asset2.lower())
    key2 = (asset2.lower(), asset1.lower())
    return correlation_map.get(key1, correlation_map.get(key2, 0.5))


class CorrelationHeatmapWidget(WidgetPlugin):
    """Widget showing correlation heatmap of portfolio holdings."""

    def render(self, positions: list[dict], accounts: list[dict]) -> WidgetContent:
        """Render the correlation heatmap widget."""
        min_positions = self.get_setting("min_positions", 2)
        show_values = self.get_setting("show_values", True)

        # Filter to positions with values
        valid_positions = [
            p for p in positions
            if p.get("current_price") and p.get("shares")
        ]

        if len(valid_positions) < min_positions:
            return WidgetContent(
                html=f"""
                <div class="widget-empty">
                    <p>Need at least {min_positions} positions with prices to show correlation.</p>
                </div>
                """,
                data={"positions_count": len(valid_positions)},
            )

        # Build correlation data
        tickers = []
        sectors = {}
        asset_classes = {}

        for pos in valid_positions:
            ticker = pos.get("ticker", "Unknown")
            if ticker not in tickers:
                tickers.append(ticker)
                sectors[ticker] = pos.get("sector", "other").lower()
                asset_classes[ticker] = self._get_asset_class(pos)

        # Calculate correlation matrix
        n = len(tickers)
        matrix = []

        for i, ticker1 in enumerate(tickers):
            row = []
            for j, ticker2 in enumerate(tickers):
                if i == j:
                    correlation = 1.0
                else:
                    # Use sector correlation if same asset class
                    if asset_classes[ticker1] == asset_classes[ticker2]:
                        sector1 = sectors[ticker1]
                        sector2 = sectors[ticker2]
                        correlation = get_correlation(
                            sector1, sector2, SECTOR_CORRELATIONS
                        )
                    else:
                        # Use asset class correlation
                        correlation = get_correlation(
                            asset_classes[ticker1],
                            asset_classes[ticker2],
                            ASSET_CLASS_CORRELATIONS,
                        )
                row.append(round(correlation, 2))
            matrix.append(row)

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

    def _get_asset_class(self, position: dict) -> str:
        """Determine asset class for a position."""
        asset_class = position.get("asset_class", "").lower()
        if asset_class:
            return asset_class

        ticker = position.get("ticker", "").upper()
        is_fund = position.get("is_fund", False)

        # Cash and CDs
        if position.get("position_type") in ("cash", "cd"):
            return "cash"

        # Bonds
        if "BOND" in ticker or ticker in ("BND", "AGG", "TLT", "IEF", "LQD", "HYG"):
            return "bonds"

        # Real estate
        if ticker in ("VNQ", "SCHH", "IYR", "XLRE") or "REIT" in ticker:
            return "real_estate"

        # Commodities
        if ticker in ("GLD", "IAU", "SLV", "USO", "DBC"):
            return "commodities"

        # Default to stocks
        return "stocks"

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
                <span class="legend-label">Low</span>
                <div class="legend-gradient"></div>
                <span class="legend-label">High</span>
            </div>
        </div>
        """
        return html

    def _get_cell_color(self, correlation: float) -> str:
        """Get background color for correlation value."""
        # Green (low) to Yellow (medium) to Red (high)
        if correlation <= 0.5:
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
            "description": "Shows correlation between portfolio holdings",
        }
