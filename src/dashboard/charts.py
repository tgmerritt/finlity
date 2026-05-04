"""Chart generation using Plotly for the dashboard."""

from typing import Optional

import plotly.graph_objects as go
from plotly.subplots import make_subplots

from src.analysis import (
    AllocationBreakdown,
    AllocationDeviation,
    CorrelationMatrix,
    PortfolioRisk,
)
from src.models import Portfolio


def create_allocation_pie(breakdown: AllocationBreakdown) -> str:
    """Create a pie chart for asset allocation."""
    labels = ["Equities", "Bonds", "Alternatives", "Cash"]
    values = [breakdown.equities, breakdown.bonds, breakdown.alternatives, breakdown.cash]

    fig = go.Figure(
        data=[
            go.Pie(
                labels=labels,
                values=values,
                hole=0.4,
                marker_colors=["#4CAF50", "#2196F3", "#FF9800", "#9E9E9E"],
                textinfo="label+percent",
                textposition="outside",
            )
        ]
    )

    fig.update_layout(
        title="Asset Allocation",
        showlegend=True,
        legend=dict(orientation="h", yanchor="bottom", y=-0.2),
        margin=dict(t=50, b=50, l=20, r=20),
        height=350,
    )

    return str(fig.to_html(full_html=False, include_plotlyjs=False))


def create_sector_chart(breakdown: AllocationBreakdown) -> str:
    """Create a horizontal bar chart for sector allocation."""
    sectors = [
        "Technology",
        "Healthcare",
        "Consumer",
        "Industrials",
        "Financials",
        "Energy/Materials",
        "Real Estate",
        "Utilities",
        "Communication",
    ]
    values = [
        breakdown.technology,
        breakdown.healthcare,
        breakdown.consumer,
        breakdown.industrials,
        breakdown.financials,
        breakdown.energy_materials,
        breakdown.real_estate,
        breakdown.utilities,
        breakdown.communication,
    ]

    # Sort by value
    sorted_pairs = sorted(zip(sectors, values), key=lambda x: x[1], reverse=True)
    if sorted_pairs:
        sorted_sectors, sorted_values = zip(*sorted_pairs)
        sectors = list(sorted_sectors)
        values = list(sorted_values)
    else:
        sectors = []
        values = []

    fig = go.Figure(
        data=[
            go.Bar(
                x=values,
                y=sectors,
                orientation="h",
                marker_color="#4CAF50",
                text=[f"{v:.1f}%" for v in values],
                textposition="outside",
            )
        ]
    )

    fig.update_layout(
        title="Sector Allocation (% of Equities)",
        xaxis_title="Percentage",
        yaxis=dict(autorange="reversed"),
        margin=dict(t=50, b=50, l=120, r=50),
        height=350,
    )

    return str(fig.to_html(full_html=False, include_plotlyjs=False))


def create_geography_chart(breakdown: AllocationBreakdown) -> str:
    """Create a bar chart for geography allocation."""
    labels = ["US Large", "US Mid/Small", "Foreign Large", "Foreign Mid/Small", "Emerging"]
    values = [
        breakdown.us_large,
        breakdown.us_mid_small,
        breakdown.foreign_developed,
        breakdown.foreign_mid_small,
        breakdown.emerging,
    ]

    fig = go.Figure(
        data=[
            go.Bar(
                x=labels,
                y=values,
                marker_color=["#1976D2", "#42A5F5", "#66BB6A", "#81C784", "#FFA726"],
                text=[f"{v:.1f}%" for v in values],
                textposition="outside",
            )
        ]
    )

    fig.update_layout(
        title="Geography Allocation (% of Equities)",
        yaxis_title="Percentage",
        margin=dict(t=50, b=50, l=50, r=20),
        height=300,
    )

    return str(fig.to_html(full_html=False, include_plotlyjs=False))


def create_deviation_chart(deviations: list[AllocationDeviation]) -> str:
    """Create a chart showing allocation deviations from targets."""
    # Filter to significant deviations
    significant = [d for d in deviations if abs(d.deviation_pct) >= 1.0]

    if not significant:
        return "<p>No significant allocation deviations</p>"

    # Sort by deviation
    significant.sort(key=lambda x: x.deviation_pct)

    labels = [f"{d.subcategory}" for d in significant]
    values = [d.deviation_pct for d in significant]
    colors = ["#F44336" if v > 0 else "#4CAF50" for v in values]

    fig = go.Figure(
        data=[
            go.Bar(
                x=values,
                y=labels,
                orientation="h",
                marker_color=colors,
                text=[f"{v:+.1f}%" for v in values],
                textposition="outside",
            )
        ]
    )

    fig.update_layout(
        title="Allocation Deviations (Current - Target)",
        xaxis_title="Deviation %",
        yaxis=dict(autorange="reversed"),
        margin=dict(t=50, b=50, l=120, r=50),
        height=400,
        shapes=[
            dict(
                type="line",
                x0=0,
                x1=0,
                y0=-0.5,
                y1=len(labels) - 0.5,
                line=dict(color="black", width=1),
            )
        ],
    )

    return str(fig.to_html(full_html=False, include_plotlyjs=False))


def create_correlation_heatmap(corr_matrix: Optional[CorrelationMatrix]) -> str:
    """Create a correlation heatmap."""
    if not corr_matrix:
        return "<p>Not enough data for correlation analysis</p>"

    fig = go.Figure(
        data=go.Heatmap(
            z=corr_matrix.matrix,
            x=corr_matrix.tickers,
            y=corr_matrix.tickers,
            colorscale="RdBu_r",
            zmin=-1,
            zmax=1,
            text=[[f"{val:.2f}" for val in row] for row in corr_matrix.matrix],
            texttemplate="%{text}",
            textfont={"size": 10},
            hoverongaps=False,
        )
    )

    fig.update_layout(
        title="Position Correlation Matrix",
        margin=dict(t=50, b=50, l=80, r=20),
        height=400,
    )

    return str(fig.to_html(full_html=False, include_plotlyjs=False))


def create_risk_gauge(risk: PortfolioRisk) -> str:
    """Create a gauge chart for portfolio risk metrics."""
    fig = make_subplots(
        rows=1,
        cols=3,
        specs=[[{"type": "indicator"}, {"type": "indicator"}, {"type": "indicator"}]],
        subplot_titles=["Sharpe Ratio", "Max Drawdown", "Volatility"],
    )

    # Sharpe Ratio gauge
    fig.add_trace(
        go.Indicator(
            mode="gauge+number",
            value=risk.sharpe_ratio,
            gauge=dict(
                axis=dict(range=[-1, 3]),
                bar=dict(color="#4CAF50" if risk.sharpe_ratio > 0.5 else "#FF9800"),
                steps=[
                    dict(range=[-1, 0], color="#FFEBEE"),
                    dict(range=[0, 0.5], color="#FFF3E0"),
                    dict(range=[0.5, 1], color="#E8F5E9"),
                    dict(range=[1, 3], color="#C8E6C9"),
                ],
            ),
        ),
        row=1,
        col=1,
    )

    # Max Drawdown gauge
    fig.add_trace(
        go.Indicator(
            mode="gauge+number",
            value=risk.max_drawdown,
            number=dict(suffix="%"),
            gauge=dict(
                axis=dict(range=[0, 50]),
                bar=dict(color="#F44336" if risk.max_drawdown > 20 else "#4CAF50"),
                steps=[
                    dict(range=[0, 10], color="#E8F5E9"),
                    dict(range=[10, 20], color="#FFF3E0"),
                    dict(range=[20, 50], color="#FFEBEE"),
                ],
            ),
        ),
        row=1,
        col=2,
    )

    # Volatility gauge
    fig.add_trace(
        go.Indicator(
            mode="gauge+number",
            value=risk.volatility,
            number=dict(suffix="%"),
            gauge=dict(
                axis=dict(range=[0, 40]),
                bar=dict(color="#FF9800" if risk.volatility > 20 else "#4CAF50"),
                steps=[
                    dict(range=[0, 15], color="#E8F5E9"),
                    dict(range=[15, 25], color="#FFF3E0"),
                    dict(range=[25, 40], color="#FFEBEE"),
                ],
            ),
        ),
        row=1,
        col=3,
    )

    fig.update_layout(
        margin=dict(t=80, b=20, l=20, r=20),
        height=250,
    )

    return str(fig.to_html(full_html=False, include_plotlyjs=False))


def create_holdings_table(portfolio: Portfolio) -> str:
    """Create an HTML table of holdings."""
    positions = sorted(portfolio.all_positions, key=lambda p: p.market_value, reverse=True)

    rows = []
    for p in positions[:20]:  # Top 20 positions
        weight = (p.market_value / portfolio.total_value * 100) if portfolio.total_value > 0 else 0
        gain_loss_str = f"${p.gain_loss:,.0f}" if p.gain_loss else "N/A"
        gain_loss_pct_str = f"{p.gain_loss_pct:.1f}%" if p.gain_loss_pct else "N/A"

        rows.append(f"""
        <tr>
            <td><strong>{p.ticker}</strong></td>
            <td>{p.name[:30]}...</td>
            <td class="right">{p.shares:,.2f}</td>
            <td class="right">${p.current_price:,.2f}</td>
            <td class="right">${p.market_value:,.0f}</td>
            <td class="right">{weight:.1f}%</td>
            <td class="right {'positive' if p.gain_loss and p.gain_loss > 0 else 'negative' if p.gain_loss else ''}">{gain_loss_str}</td>
            <td class="right {'positive' if p.gain_loss_pct and p.gain_loss_pct > 0 else 'negative' if p.gain_loss_pct else ''}">{gain_loss_pct_str}</td>
        </tr>
        """)

    return f"""
    <table class="holdings-table">
        <thead>
            <tr>
                <th>Ticker</th>
                <th>Name</th>
                <th class="right">Shares</th>
                <th class="right">Price</th>
                <th class="right">Value</th>
                <th class="right">Weight</th>
                <th class="right">Gain/Loss</th>
                <th class="right">%</th>
            </tr>
        </thead>
        <tbody>
            {''.join(rows)}
        </tbody>
    </table>
    """


def create_account_breakdown(portfolio: Portfolio) -> str:
    """Create a breakdown by account."""
    accounts = sorted(portfolio.accounts, key=lambda a: a.total_value, reverse=True)

    labels = [a.name for a in accounts]
    values = [a.total_value for a in accounts]
    colors = ["#4CAF50", "#2196F3", "#FF9800", "#9C27B0", "#F44336", "#00BCD4"]

    fig = go.Figure(
        data=[
            go.Pie(
                labels=labels,
                values=values,
                hole=0.4,
                marker_colors=colors[: len(labels)],
                textinfo="label+value",
                texttemplate="%{label}<br>$%{value:,.0f}",
                textposition="outside",
            )
        ]
    )

    fig.update_layout(
        title="Value by Account",
        showlegend=False,
        margin=dict(t=50, b=50, l=20, r=20),
        height=350,
    )

    return str(fig.to_html(full_html=False, include_plotlyjs=False))
