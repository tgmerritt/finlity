"""
Sector Treemap Widget Plugin.

Displays an interactive treemap visualization showing portfolio allocation
by sector with individual holdings.
"""


from src.plugins.base import WidgetPlugin, WidgetContent


# Sector colors (darker shades for better dark mode compatibility)
SECTOR_COLORS = {
    "technology": "#4A90D9",
    "healthcare": "#50C878",
    "financials": "#D4A017",  # Darker gold
    "consumer": "#FF6B6B",
    "industrials": "#9B59B6",
    "energy": "#E67E22",
    "utilities": "#1ABC9C",
    "real_estate": "#5D6D7E",  # Darker slate
    "materials": "#7F8C8D",   # Darker gray
    "communication": "#3498DB",
    "other": "#566573",       # Dark slate gray for better dark mode visibility
}


class SectorTreemapWidget(WidgetPlugin):
    """Widget showing treemap of sector allocation."""

    def render(self, positions: list[dict], accounts: list[dict]) -> WidgetContent:
        """Render the sector treemap widget."""
        min_percent = self.get_setting("min_percent", 1)
        show_tickers = self.get_setting("show_tickers", True)

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

        # Group by sector
        sectors = {}
        for pos in positions:
            price = pos.get("current_price") or 0
            shares = pos.get("shares") or 0
            value = price * shares
            if value == 0:
                continue

            sector = (pos.get("sector") or "Other").title()
            ticker = pos.get("ticker", "Unknown")
            name = pos.get("name", ticker)

            if sector not in sectors:
                sectors[sector] = {"value": 0, "positions": []}

            sectors[sector]["value"] += value
            sectors[sector]["positions"].append({
                "ticker": ticker,
                "name": name,
                "value": value,
                "percent": (value / total_value) * 100,
            })

        # Calculate sector percentages
        sector_data = []
        other_value = 0

        for sector, data in sectors.items():
            percent = (data["value"] / total_value) * 100
            if percent < min_percent:
                other_value += data["value"]
            else:
                # Sort positions by value
                data["positions"].sort(key=lambda x: x["value"], reverse=True)
                sector_data.append({
                    "sector": sector,
                    "value": data["value"],
                    "percent": percent,
                    "positions": data["positions"][:5] if show_tickers else [],  # Top 5
                    "color": SECTOR_COLORS.get(sector.lower(), SECTOR_COLORS["other"]),
                })

        # Add Other if significant
        if other_value > 0:
            other_percent = (other_value / total_value) * 100
            sector_data.append({
                "sector": "Other",
                "value": other_value,
                "percent": other_percent,
                "positions": [],
                "color": SECTOR_COLORS["other"],
            })

        # Sort by value descending
        sector_data.sort(key=lambda x: x["value"], reverse=True)

        # Generate HTML
        html = self._generate_html(sector_data, total_value, show_tickers)

        return WidgetContent(
            html=html,
            data={
                "sectors": sector_data,
                "total_value": total_value,
            },
            scripts=[],
            styles=[],
        )

    def _generate_html(
        self, sector_data: list[dict], total_value: float, show_tickers: bool
    ) -> str:
        """Generate HTML for the treemap."""
        # Build sector blocks
        blocks = []
        for sector in sector_data:
            # Calculate flex basis based on percentage
            flex_basis = max(sector["percent"], 10)  # Minimum 10% for visibility

            # Build position list if showing tickers
            position_html = ""
            if show_tickers and sector["positions"]:
                pos_items = []
                for pos in sector["positions"][:3]:  # Top 3 per sector
                    pos_items.append(
                        f'<div class="treemap-position">'
                        f'{pos["ticker"]}: {pos["percent"]:.1f}%</div>'
                    )
                position_html = f'<div class="treemap-positions">{"".join(pos_items)}</div>'

            blocks.append(f"""
                <div class="treemap-block" style="flex-basis: {flex_basis}%; background-color: {sector["color"]};">
                    <div class="treemap-label">{sector["sector"]}</div>
                    <div class="treemap-value">{sector["percent"]:.1f}%</div>
                    <div class="treemap-amount">${sector["value"]:,.0f}</div>
                    {position_html}
                </div>
            """)

        # Build summary stats
        top_sector = sector_data[0] if sector_data else {"sector": "N/A", "percent": 0}
        sector_count = len([s for s in sector_data if s["sector"] != "Other"])

        html = f"""
        <div class="treemap-widget">
            <div class="treemap-summary">
                <div class="summary-item">
                    <span class="label">Total Value:</span>
                    <span class="value">${total_value:,.0f}</span>
                </div>
                <div class="summary-item">
                    <span class="label">Top Sector:</span>
                    <span class="value">{top_sector["sector"]} ({top_sector["percent"]:.1f}%)</span>
                </div>
                <div class="summary-item">
                    <span class="label">Sectors:</span>
                    <span class="value">{sector_count}</span>
                </div>
            </div>
            <div class="treemap-container">
                {"".join(blocks)}
            </div>
        </div>
        """
        return html

    def get_info(self) -> dict:
        """Return plugin information."""
        config = self.get_config()
        return {
            "name": self.name,
            "version": self.version,
            "type": "widget",
            "title": config.title if config else "Sector Treemap",
            "description": "Interactive treemap showing sector allocation",
        }
