"""Dashboard generator using Jinja2 and Plotly."""

from datetime import datetime
from pathlib import Path
from typing import Optional

from jinja2 import Environment, FileSystemLoader

from src.analysis import (
    AllocationAnalyzer,
    CorrelationAnalyzer,
    PerformanceAnalyzer,
    RiskAnalyzer,
)
from src.data import FundLookupService, PriceService
from src.models import AllocationTargets, Portfolio

from .charts import (
    create_account_breakdown,
    create_allocation_pie,
    create_correlation_heatmap,
    create_deviation_chart,
    create_geography_chart,
    create_holdings_table,
    create_risk_gauge,
    create_sector_chart,
)


class DashboardGenerator:
    """Generates an interactive HTML dashboard for the portfolio."""

    def __init__(
        self,
        templates_dir: str = "templates",
        output_dir: str = "output",
    ):
        self.templates_dir = Path(templates_dir)
        self.output_dir = Path(output_dir)
        self.output_dir.mkdir(parents=True, exist_ok=True)

        # Initialize services
        self.price_service = PriceService()
        self.fund_service = FundLookupService()

        # Initialize analyzers
        self.performance_analyzer = PerformanceAnalyzer(self.price_service)
        self.risk_analyzer = RiskAnalyzer(self.price_service)
        self.allocation_analyzer = AllocationAnalyzer(fund_service=self.fund_service)
        self.correlation_analyzer = CorrelationAnalyzer(self.price_service)

    def generate(
        self,
        portfolio: Portfolio,
        output_filename: str = "report.html",
    ) -> Path:
        """Generate the dashboard HTML file."""
        # Calculate all analytics
        performance = self.performance_analyzer.get_portfolio_performance(portfolio)
        risk = self.risk_analyzer.get_portfolio_risk(portfolio)
        allocation = self.allocation_analyzer.calculate_allocation(portfolio)
        deviations = self.allocation_analyzer.calculate_deviations(portfolio)
        suggestions = self.allocation_analyzer.get_rebalancing_suggestions(portfolio)
        corr_matrix = self.correlation_analyzer.calculate_correlation_matrix(portfolio)
        diversification = self.correlation_analyzer.calculate_diversification_score(portfolio)

        # Get targets for display
        targets = self.allocation_analyzer.targets

        # Generate charts
        charts = {
            "allocation_pie": create_allocation_pie(allocation),
            "sector_chart": create_sector_chart(allocation),
            "geography_chart": create_geography_chart(allocation),
            "deviation_chart": create_deviation_chart(deviations),
            "correlation_heatmap": create_correlation_heatmap(corr_matrix),
            "risk_gauge": create_risk_gauge(risk),
            "holdings_table": create_holdings_table(portfolio),
            "account_breakdown": create_account_breakdown(portfolio),
        }

        # Build the HTML
        html = self._build_html(
            portfolio=portfolio,
            performance=performance,
            risk=risk,
            allocation=allocation,
            targets=targets,
            deviations=deviations,
            suggestions=suggestions,
            diversification=diversification,
            charts=charts,
        )

        # Write to file
        output_path = self.output_dir / output_filename
        with open(output_path, "w") as f:
            f.write(html)

        return output_path

    def _build_html(
        self,
        portfolio,
        performance,
        risk,
        allocation,
        targets,
        deviations,
        suggestions,
        diversification,
        charts,
    ) -> str:
        """Build the complete HTML dashboard."""
        # Get rebalancing advice HTML
        advice_html = self._build_advice_section(suggestions)

        return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Investment Portfolio Dashboard</title>
    <script src="https://cdn.plot.ly/plotly-2.27.0.min.js"></script>
    <style>
        * {{
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }}

        body {{
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, sans-serif;
            background-color: #f5f5f5;
            color: #333;
            line-height: 1.6;
        }}

        .container {{
            max-width: 1400px;
            margin: 0 auto;
            padding: 20px;
        }}

        header {{
            background: linear-gradient(135deg, #1a237e 0%, #0d47a1 100%);
            color: white;
            padding: 30px;
            border-radius: 10px;
            margin-bottom: 20px;
        }}

        header h1 {{
            font-size: 2rem;
            margin-bottom: 10px;
        }}

        .summary-cards {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
            gap: 15px;
            margin-bottom: 20px;
        }}

        .card {{
            background: white;
            border-radius: 10px;
            padding: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }}

        .card h3 {{
            color: #666;
            font-size: 0.9rem;
            text-transform: uppercase;
            margin-bottom: 5px;
        }}

        .card .value {{
            font-size: 1.8rem;
            font-weight: bold;
            color: #1a237e;
        }}

        .card .change {{
            font-size: 0.9rem;
            margin-top: 5px;
        }}

        .positive {{ color: #4CAF50; }}
        .negative {{ color: #F44336; }}

        .grid-2 {{
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 20px;
            margin-bottom: 20px;
        }}

        .grid-3 {{
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 20px;
            margin-bottom: 20px;
        }}

        @media (max-width: 1000px) {{
            .grid-2, .grid-3 {{
                grid-template-columns: 1fr;
            }}
        }}

        .section {{
            background: white;
            border-radius: 10px;
            padding: 20px;
            margin-bottom: 20px;
            box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        }}

        .section h2 {{
            color: #1a237e;
            border-bottom: 2px solid #e0e0e0;
            padding-bottom: 10px;
            margin-bottom: 20px;
        }}

        .holdings-table {{
            width: 100%;
            border-collapse: collapse;
            font-size: 0.9rem;
        }}

        .holdings-table th, .holdings-table td {{
            padding: 12px 8px;
            text-align: left;
            border-bottom: 1px solid #e0e0e0;
        }}

        .holdings-table th {{
            background: #f5f5f5;
            font-weight: 600;
            color: #666;
        }}

        .holdings-table tr:hover {{
            background: #f9f9f9;
        }}

        .right {{
            text-align: right;
        }}

        .advice-list {{
            list-style: none;
        }}

        .advice-item {{
            padding: 15px;
            margin-bottom: 10px;
            border-radius: 8px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }}

        .advice-item.buy {{
            background: #E8F5E9;
            border-left: 4px solid #4CAF50;
        }}

        .advice-item.sell {{
            background: #FFEBEE;
            border-left: 4px solid #F44336;
        }}

        .advice-action {{
            font-weight: bold;
            padding: 5px 15px;
            border-radius: 20px;
            font-size: 0.85rem;
        }}

        .buy .advice-action {{
            background: #4CAF50;
            color: white;
        }}

        .sell .advice-action {{
            background: #F44336;
            color: white;
        }}

        .metric-grid {{
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
        }}

        .metric {{
            text-align: center;
            padding: 15px;
            background: #f9f9f9;
            border-radius: 8px;
        }}

        .metric .label {{
            color: #666;
            font-size: 0.85rem;
            margin-bottom: 5px;
        }}

        .metric .value {{
            font-size: 1.5rem;
            font-weight: bold;
            color: #1a237e;
        }}

        .grade {{
            display: inline-block;
            width: 50px;
            height: 50px;
            line-height: 50px;
            text-align: center;
            font-size: 1.5rem;
            font-weight: bold;
            border-radius: 50%;
            color: white;
        }}

        .grade-A {{ background: #4CAF50; }}
        .grade-B {{ background: #8BC34A; }}
        .grade-C {{ background: #FFC107; }}
        .grade-D {{ background: #FF9800; }}
        .grade-F {{ background: #F44336; }}

        footer {{
            text-align: center;
            padding: 20px;
            color: #666;
            font-size: 0.85rem;
        }}

        @media print {{
            body {{
                background: white;
            }}
            .section {{
                box-shadow: none;
                border: 1px solid #ddd;
            }}
        }}
    </style>
</head>
<body>
    <div class="container">
        <header>
            <h1>Investment Portfolio Dashboard</h1>
            <p>Generated {datetime.now().strftime('%B %d, %Y at %I:%M %p')} | Age: {targets.current_age} | Retirement in {targets.years_to_retirement} years</p>
        </header>

        <!-- Summary Cards -->
        <div class="summary-cards">
            <div class="card">
                <h3>Total Value</h3>
                <div class="value">${portfolio.total_value:,.0f}</div>
            </div>
            <div class="card">
                <h3>YTD Return</h3>
                <div class="value {'positive' if performance.ytd_return >= 0 else 'negative'}">{performance.ytd_return:+.1f}%</div>
                <div class="change">vs S&P 500: {performance.benchmark_ytd:+.1f}%</div>
            </div>
            <div class="card">
                <h3>1-Year Return</h3>
                <div class="value {'positive' if performance.one_year_return >= 0 else 'negative'}">{performance.one_year_return:+.1f}%</div>
                <div class="change">Alpha: {performance.alpha_one_year:+.1f}%</div>
            </div>
            <div class="card">
                <h3>Sharpe Ratio</h3>
                <div class="value">{risk.sharpe_ratio:.2f}</div>
                <div class="change">Risk-adjusted return</div>
            </div>
            <div class="card">
                <h3>Diversification</h3>
                <div class="value"><span class="grade grade-{diversification.grade}">{diversification.grade}</span></div>
                <div class="change">Score: {diversification.score:.0f}/100</div>
            </div>
        </div>

        <!-- Risk Metrics -->
        <div class="section">
            <h2>Risk Metrics</h2>
            {charts['risk_gauge']}
            <div class="metric-grid" style="margin-top: 20px;">
                <div class="metric">
                    <div class="label">Sortino Ratio</div>
                    <div class="value">{risk.sortino_ratio:.2f}</div>
                </div>
                <div class="metric">
                    <div class="label">Beta (vs S&P 500)</div>
                    <div class="value">{risk.beta:.2f}</div>
                </div>
                <div class="metric">
                    <div class="label">VaR (95%)</div>
                    <div class="value">{risk.var_95:.1f}%</div>
                </div>
                <div class="metric">
                    <div class="label">CVaR (95%)</div>
                    <div class="value">{risk.cvar_95:.1f}%</div>
                </div>
            </div>
        </div>

        <!-- Allocation -->
        <div class="grid-2">
            <div class="section">
                <h2>Asset Allocation</h2>
                {charts['allocation_pie']}
            </div>
            <div class="section">
                <h2>Sector Breakdown</h2>
                {charts['sector_chart']}
            </div>
        </div>

        <div class="grid-2">
            <div class="section">
                <h2>Geography</h2>
                {charts['geography_chart']}
            </div>
            <div class="section">
                <h2>Allocation Deviations</h2>
                {charts['deviation_chart']}
            </div>
        </div>

        <!-- Rebalancing Advice -->
        <div class="section">
            <h2>Rebalancing Suggestions</h2>
            {advice_html}
        </div>

        <!-- Correlation -->
        <div class="section">
            <h2>Position Correlations</h2>
            <p style="margin-bottom: 15px;">{diversification.description}</p>
            {charts['correlation_heatmap']}
        </div>

        <!-- Holdings Table -->
        <div class="section">
            <h2>Top Holdings</h2>
            {charts['holdings_table']}
        </div>

        <!-- Account Breakdown -->
        <div class="section">
            <h2>Account Breakdown</h2>
            <div class="grid-2">
                <div>
                    {charts['account_breakdown']}
                </div>
                <div>
                    <div class="metric-grid">
                        <div class="metric">
                            <div class="label">Retirement Accounts</div>
                            <div class="value">${portfolio.retirement_value:,.0f}</div>
                        </div>
                        <div class="metric">
                            <div class="label">Taxable Accounts</div>
                            <div class="value">${portfolio.taxable_value:,.0f}</div>
                        </div>
                    </div>
                </div>
            </div>
        </div>

        <footer>
            <p>Investment Portfolio Dashboard | Data as of {portfolio.snapshot_date.strftime('%Y-%m-%d')}</p>
        </footer>
    </div>
</body>
</html>
"""

    def _build_advice_section(self, suggestions) -> str:
        """Build the rebalancing advice HTML."""
        if not suggestions:
            return "<p>Portfolio is well-balanced - no rebalancing needed.</p>"

        items = []
        for s in suggestions[:10]:  # Top 10 suggestions
            css_class = "buy" if s.action == "BUY" else "sell"
            action_text = f"{s.action} ${abs(s.deviation_dollars):,.0f}"
            items.append(f"""
            <li class="advice-item {css_class}">
                <div>
                    <strong>{s.subcategory}</strong> ({s.category})<br>
                    <span>Current: {s.current_pct:.1f}% | Target: {s.target_pct:.1f}% | Deviation: {s.deviation_pct:+.1f}%</span>
                </div>
                <span class="advice-action">{action_text}</span>
            </li>
            """)

        return f'<ul class="advice-list">{"".join(items)}</ul>'
