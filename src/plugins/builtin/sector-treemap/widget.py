"""
Sector Treemap Widget Plugin.

Displays an interactive Plotly.js treemap visualization showing portfolio allocation
by sector with individual holdings, colored by daily performance (red/green).
"""

import json
from src.plugins.base import WidgetPlugin, WidgetContent
from src.data import PriceService


class SectorTreemapWidget(WidgetPlugin):
    """Widget showing interactive treemap of sector allocation with performance coloring."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._price_service = None

    @property
    def price_service(self) -> PriceService:
        """Lazy-load price service."""
        if self._price_service is None:
            self._price_service = PriceService()
        return self._price_service

    def render(self, positions: list[dict], accounts: list[dict]) -> WidgetContent:
        """Render the sector treemap widget with Plotly.js."""
        min_percent = self.get_setting("min_percent", 1)

        # Calculate total portfolio value
        total_value = 0
        for pos in positions:
            price = pos.get("current_price") or 0
            shares = pos.get("shares") or 0
            total_value += price * shares

        if total_value == 0:
            return WidgetContent(
                html="""
                <div class="widget-empty">
                    <p>No positions with values to display.</p>
                </div>
                """,
                data={},
            )

        # Build treemap data structure
        # Labels: [Root, Sector1, Sector2, ..., Ticker1, Ticker2, ...]
        # Parents: ['', Root, Root, ..., Sector1, Sector1, ...]
        # Values: [total, sector_value, ..., ticker_value, ...]
        # Colors: [null, sector_avg_change, ..., ticker_change, ...]

        labels = ["Portfolio"]
        parents = [""]
        values = [total_value]  # Root value = total (required for branchvalues="total")
        colors = [None]  # Root has no color
        custom_data = [{}]  # For hover template

        # Group positions by sector
        sectors: dict[str, dict] = {}
        for pos in positions:
            price = pos.get("current_price") or 0
            shares = pos.get("shares") or 0
            value = price * shares
            if value == 0:
                continue

            sector = (pos.get("sector") or "Other").title()
            ticker = pos.get("ticker", "Unknown")
            name = pos.get("name", ticker)

            # Get daily change for this position
            daily_change_pct = pos.get("daily_change_pct")
            if daily_change_pct is None:
                # Try to fetch from price service
                price_data = self.price_service.get_current_price(ticker)
                if price_data:
                    daily_change_pct = price_data.daily_change_pct
                else:
                    daily_change_pct = None  # Will show as grey

            if sector not in sectors:
                sectors[sector] = {"value": 0, "positions": [], "changes": []}

            sectors[sector]["value"] += value
            sectors[sector]["positions"].append({
                "ticker": ticker,
                "name": name,
                "value": value,
                "percent": (value / total_value) * 100,
                "daily_change_pct": daily_change_pct,
            })
            if daily_change_pct is not None:
                sectors[sector]["changes"].append(daily_change_pct)

        # Filter small sectors into "Other"
        other_positions = []
        other_changes = []
        sectors_to_remove = []

        for sector, data in sectors.items():
            percent = (data["value"] / total_value) * 100
            if percent < min_percent:
                other_positions.extend(data["positions"])
                other_changes.extend(data["changes"])
                sectors_to_remove.append(sector)

        for sector in sectors_to_remove:
            del sectors[sector]

        if other_positions:
            other_value = sum(p["value"] for p in other_positions)
            sectors["Other"] = {
                "value": other_value,
                "positions": other_positions,
                "changes": other_changes,
            }

        # Build treemap arrays
        for sector, data in sorted(sectors.items(), key=lambda x: -x[1]["value"]):
            # Add sector node
            sector_percent = (data["value"] / total_value) * 100
            avg_change = (
                sum(data["changes"]) / len(data["changes"])
                if data["changes"]
                else None
            )

            labels.append(sector)
            parents.append("Portfolio")
            values.append(data["value"])
            colors.append(avg_change)
            custom_data.append({
                "type": "sector",
                "percent": sector_percent,
                "count": len(data["positions"]),
            })

            # Add individual positions within sector
            for pos in sorted(data["positions"], key=lambda x: -x["value"]):
                labels.append(pos["ticker"])
                parents.append(sector)
                values.append(pos["value"])
                colors.append(pos["daily_change_pct"])
                custom_data.append({
                    "type": "position",
                    "name": pos["name"],
                    "percent": pos["percent"],
                    "daily_change": pos["daily_change_pct"],
                })

        # Generate unique container ID
        container_id = "sector-treemap-chart"

        # Build Plotly config
        treemap_data = {
            "type": "treemap",
            "labels": labels,
            "parents": parents,
            "values": values,
            "branchvalues": "total",
            "marker": {
                "colors": colors,
                "colorscale": [
                    [0, "#c0392c"],      # Deep red for -3% or worse
                    [0.25, "#e74c3c"],   # Red for -1.5%
                    [0.5, "#95a5a6"],    # Grey for 0%
                    [0.75, "#27ae60"],   # Green for +1.5%
                    [1, "#1e8449"],      # Deep green for +3% or better
                ],
                "cmid": 0,
                "cmin": -3,
                "cmax": 3,
                "showscale": True,
                "colorbar": {
                    "title": {"text": "Daily %", "side": "right"},
                    "ticksuffix": "%",
                    "thickness": 15,
                    "len": 0.5,
                    "y": 0.5,
                },
            },
            "textinfo": "label+percent entry",
            "textfont": {"size": 12},
            "pathbar": {"visible": True},
            "customdata": custom_data,
            "hovertemplate": (
                "<b>%{label}</b><br>"
                "Value: $%{value:,.0f}<br>"
                "Daily: %{color:.2f}%<br>"
                "<extra></extra>"
            ),
        }

        layout = {
            "margin": {"t": 30, "l": 10, "r": 10, "b": 10},
            "paper_bgcolor": "rgba(0,0,0,0)",
            "plot_bgcolor": "rgba(0,0,0,0)",
        }

        config = {
            "responsive": True,
            "displayModeBar": False,
        }

        # Build summary stats
        sector_list = [s for s in sectors.keys() if s != "Other"]
        top_sector = max(sectors.items(), key=lambda x: x[1]["value"])[0] if sectors else "N/A"
        top_sector_pct = (sectors[top_sector]["value"] / total_value * 100) if top_sector in sectors else 0

        # Generate HTML with embedded script
        html = f"""
        <div class="treemap-widget plotly-treemap">
            <div class="treemap-summary">
                <div class="summary-item">
                    <span class="label">Total Value:</span>
                    <span class="value">${total_value:,.0f}</span>
                </div>
                <div class="summary-item">
                    <span class="label">Top Sector:</span>
                    <span class="value">{top_sector} ({top_sector_pct:.1f}%)</span>
                </div>
                <div class="summary-item">
                    <span class="label">Sectors:</span>
                    <span class="value">{len(sector_list)}</span>
                </div>
            </div>
            <div id="{container_id}" class="treemap-plotly-container"></div>
        </div>
        <script>
        (function() {{
            var data = [{json.dumps(treemap_data)}];
            var layout = {json.dumps(layout)};
            var config = {json.dumps(config)};

            // Adjust colors for dark mode
            var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
            if (isDark) {{
                layout.font = {{ color: '#e0e0e0' }};
                data[0].textfont = {{ color: '#ffffff' }};
                data[0].marker.colorbar.tickfont = {{ color: '#e0e0e0' }};
                data[0].marker.colorbar.title.font = {{ color: '#e0e0e0' }};
            }}

            Plotly.newPlot('{container_id}', data, layout, config);
        }})();
        </script>
        """

        return WidgetContent(
            html=html,
            data={
                "sectors": list(sectors.keys()),
                "total_value": total_value,
                "position_count": sum(len(s["positions"]) for s in sectors.values()),
            },
            scripts=[],
            styles=[],
        )

    def get_info(self) -> dict:
        """Return plugin information."""
        config = self.get_config()
        return {
            "name": self.name,
            "version": self.version,
            "type": "widget",
            "title": config.title if config else "Sector Allocation",
            "description": "Interactive treemap showing sector allocation with daily performance",
        }
