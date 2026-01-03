"""Registry of dashboard elements that can receive AI commentary.

Each element defines:
- type: The visual type (stat_card, chart, table, metric, list)
- tab: Which dashboard tab it appears on
- title: Human-readable title
- data_dependencies: Which data fields this element depends on (for change detection)
- web_search_queries: Queries to run for comparison data (with {placeholders})
- refresh_triggers: Events that should invalidate this commentary
"""

from typing import TypedDict, Optional


class ElementConfig(TypedDict, total=False):
    """Configuration for a dashboard element."""
    type: str  # stat_card, chart, table, metric, list
    tab: str  # dashboard, holdings, analysis, projections, taxes, budget
    title: str  # Human-readable title
    data_dependencies: list[str]  # Dot-notation paths to data fields
    web_search_queries: list[str]  # Search queries with {placeholders}
    refresh_triggers: list[str]  # Events that invalidate: position_change, price_update, settings_change
    prompt_key: str  # Key in PROMPT_TEMPLATES


# All dashboard elements that can receive AI commentary
ELEMENT_REGISTRY: dict[str, ElementConfig] = {
    # =========================================================================
    # DASHBOARD TAB - Summary Stat Cards (Row 1)
    # =========================================================================
    "dashboard.total_value": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "Total Portfolio Value",
        "data_dependencies": ["summary.total_value"],
        "web_search_queries": [
            "average retirement savings by age {user_age} 2024",
            "median net worth {user_age} year old united states",
        ],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "total_value",
    },
    "dashboard.total_gain_loss": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "Total Gain/Loss",
        "data_dependencies": ["summary.total_gain_loss", "summary.total_gain_loss_pct"],
        "web_search_queries": [
            "S&P 500 YTD return {current_year}",
            "average stock market return {current_year}",
        ],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "gain_loss",
    },
    "dashboard.retirement_value": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "Retirement Value",
        "data_dependencies": ["summary.retirement_value"],
        "web_search_queries": [
            "average 401k balance by age {user_age}",
            "recommended retirement savings {user_age} years old",
        ],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "retirement_value",
    },
    "dashboard.taxable_value": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "Taxable Value",
        "data_dependencies": ["summary.taxable_value"],
        "web_search_queries": [
            "average taxable investment account balance by age",
        ],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "taxable_value",
    },

    # =========================================================================
    # DASHBOARD TAB - Retirement Metrics (Row 2)
    # =========================================================================
    "dashboard.monthly_retirement_income": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "Monthly Retirement Income",
        "data_dependencies": ["retirement_metrics.monthly_income", "summary.total_value"],
        "web_search_queries": [
            "average retirement income needed per month {current_year}",
            "4 percent rule retirement withdrawal",
        ],
        "refresh_triggers": ["position_change", "price_update", "settings_change"],
        "prompt_key": "monthly_retirement_income",
    },
    "dashboard.success_probability": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "Success Probability",
        "data_dependencies": ["retirement_metrics.success_rate"],
        "web_search_queries": [
            "what is a good retirement success probability",
            "Monte Carlo simulation retirement planning",
        ],
        "refresh_triggers": ["position_change", "settings_change"],
        "prompt_key": "success_probability",
    },
    "dashboard.earliest_retirement_age": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "Earliest Retirement Age",
        "data_dependencies": ["retirement_metrics.earliest_retirement_age", "user.current_age"],
        "web_search_queries": [
            "average retirement age united states {current_year}",
            "FIRE movement early retirement age",
        ],
        "refresh_triggers": ["position_change", "settings_change"],
        "prompt_key": "earliest_retirement_age",
    },
    "dashboard.fire_number": {
        "type": "stat_card",
        "tab": "dashboard",
        "title": "FIRE Number",
        "data_dependencies": ["retirement_metrics.fire_number", "summary.total_value"],
        "web_search_queries": [
            "how to calculate FIRE number",
            "average FIRE number needed to retire",
        ],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "fire_number",
    },

    # =========================================================================
    # DASHBOARD TAB - Charts
    # =========================================================================
    "dashboard.account_balances_table": {
        "type": "table",
        "tab": "dashboard",
        "title": "Account Balances",
        "data_dependencies": ["summary.accounts"],
        "web_search_queries": [],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "account_balances_table",
    },
    "dashboard.allocation_chart": {
        "type": "chart",
        "tab": "dashboard",
        "title": "Asset Allocation",
        "data_dependencies": ["positions"],
        "web_search_queries": [
            "recommended portfolio diversification {user_age} years old",
        ],
        "refresh_triggers": ["position_change"],
        "prompt_key": "allocation_chart",
    },
    "dashboard.account_type_chart": {
        "type": "chart",
        "tab": "dashboard",
        "title": "By Account Type",
        "data_dependencies": ["summary.by_account_type"],
        "web_search_queries": [
            "optimal tax-advantaged vs taxable account ratio",
        ],
        "refresh_triggers": ["position_change"],
        "prompt_key": "account_type_chart",
    },
    "dashboard.history_chart": {
        "type": "chart",
        "tab": "dashboard",
        "title": "Portfolio Value History",
        "data_dependencies": ["history"],
        "web_search_queries": [],
        "refresh_triggers": ["daily"],
        "prompt_key": "history_chart",
    },

    # =========================================================================
    # HOLDINGS TAB
    # =========================================================================
    "holdings.table": {
        "type": "table",
        "tab": "holdings",
        "title": "Holdings Table",
        "data_dependencies": ["positions"],
        "web_search_queries": [],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "holdings_table",
    },

    # =========================================================================
    # ANALYSIS TAB - Card Headers (Summary for each card)
    # =========================================================================
    "analysis.performance_metrics": {
        "type": "card_header",
        "tab": "analysis",
        "title": "Performance Metrics Overview",
        "data_dependencies": ["performance.ytd_return", "performance.alpha"],
        "web_search_queries": [
            "S&P 500 YTD return {current_year}",
            "average portfolio performance {current_year}",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "performance_overview",
    },
    "analysis.risk_metrics": {
        "type": "card_header",
        "tab": "analysis",
        "title": "Risk Metrics Overview",
        "data_dependencies": ["risk.volatility", "risk.sharpe_ratio", "risk.max_drawdown"],
        "web_search_queries": [
            "what is a good sharpe ratio",
            "average portfolio volatility",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "risk_overview",
    },
    "analysis.concentration": {
        "type": "card_header",
        "tab": "analysis",
        "title": "Portfolio Concentration",
        "data_dependencies": ["concentration.top_5_pct", "concentration.top_10_pct"],
        "web_search_queries": [
            "recommended portfolio diversification",
            "portfolio concentration risk",
        ],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "concentration_overview",
    },

    # =========================================================================
    # ANALYSIS TAB - Performance Metrics (Individual)
    # =========================================================================
    "analysis.performance.ytd_return": {
        "type": "metric",
        "tab": "analysis",
        "title": "YTD Return",
        "data_dependencies": ["performance.ytd_return"],
        "web_search_queries": [
            "S&P 500 YTD return {current_year}",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "ytd_return",
    },
    "analysis.performance.one_year_return": {
        "type": "metric",
        "tab": "analysis",
        "title": "1-Year Return (TTM)",
        "data_dependencies": ["performance.one_year_return"],
        "web_search_queries": [
            "S&P 500 1 year return",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "one_year_return",
    },
    "analysis.performance.alpha": {
        "type": "metric",
        "tab": "analysis",
        "title": "Alpha vs S&P 500",
        "data_dependencies": ["performance.alpha"],
        "web_search_queries": [
            "what is good alpha for portfolio",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "alpha",
    },
    "analysis.performance.benchmark": {
        "type": "metric",
        "tab": "analysis",
        "title": "Benchmark YTD",
        "data_dependencies": ["performance.benchmark_ytd"],
        "web_search_queries": [],
        "refresh_triggers": ["daily"],
        "prompt_key": "benchmark",
    },

    # =========================================================================
    # ANALYSIS TAB - Risk Metrics
    # =========================================================================
    "analysis.risk.volatility": {
        "type": "metric",
        "tab": "analysis",
        "title": "Volatility (Annual)",
        "data_dependencies": ["risk.volatility"],
        "web_search_queries": [
            "S&P 500 historical volatility",
            "what is normal portfolio volatility",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "volatility",
    },
    "analysis.risk.sharpe_ratio": {
        "type": "metric",
        "tab": "analysis",
        "title": "Sharpe Ratio",
        "data_dependencies": ["risk.sharpe_ratio"],
        "web_search_queries": [
            "what is a good Sharpe ratio for portfolio",
            "average Sharpe ratio S&P 500",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "sharpe_ratio",
    },
    "analysis.risk.max_drawdown": {
        "type": "metric",
        "tab": "analysis",
        "title": "Max Drawdown",
        "data_dependencies": ["risk.max_drawdown"],
        "web_search_queries": [
            "S&P 500 max drawdown history",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "max_drawdown",
    },
    "analysis.risk.beta": {
        "type": "metric",
        "tab": "analysis",
        "title": "Beta",
        "data_dependencies": ["risk.beta"],
        "web_search_queries": [
            "what does portfolio beta mean",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "beta",
    },
    "analysis.risk.var_95": {
        "type": "metric",
        "tab": "analysis",
        "title": "Value at Risk (95%)",
        "data_dependencies": ["risk.var_95"],
        "web_search_queries": [
            "how to interpret Value at Risk",
        ],
        "refresh_triggers": ["price_update", "daily"],
        "prompt_key": "var_95",
    },

    # =========================================================================
    # ANALYSIS TAB - Concentration Metrics
    # =========================================================================
    "analysis.concentration.top_5": {
        "type": "metric",
        "tab": "analysis",
        "title": "Top 5 Holdings %",
        "data_dependencies": ["allocation.top_5_pct"],
        "web_search_queries": [
            "portfolio concentration risk guidelines",
        ],
        "refresh_triggers": ["position_change"],
        "prompt_key": "top_5_concentration",
    },
    "analysis.concentration.top_10": {
        "type": "metric",
        "tab": "analysis",
        "title": "Top 10 Holdings %",
        "data_dependencies": ["allocation.top_10_pct"],
        "web_search_queries": [],
        "refresh_triggers": ["position_change"],
        "prompt_key": "top_10_concentration",
    },
    "analysis.concentration.cash_pct": {
        "type": "metric",
        "tab": "analysis",
        "title": "Cash Allocation %",
        "data_dependencies": ["allocation.cash_pct"],
        "web_search_queries": [
            "how much cash should be in investment portfolio",
        ],
        "refresh_triggers": ["position_change"],
        "prompt_key": "cash_allocation",
    },
    "analysis.concentration.invested_pct": {
        "type": "metric",
        "tab": "analysis",
        "title": "Invested Allocation %",
        "data_dependencies": ["allocation.invested_pct"],
        "web_search_queries": [],
        "refresh_triggers": ["position_change"],
        "prompt_key": "invested_allocation",
    },

    # =========================================================================
    # ANALYSIS TAB - Top Holdings & Allocation
    # =========================================================================
    "analysis.top_holdings": {
        "type": "list",
        "tab": "analysis",
        "title": "Top Holdings",
        "data_dependencies": ["allocation.top_holdings"],
        "web_search_queries": [],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "top_holdings",
    },
    "analysis.allocation.by_sector": {
        "type": "table",
        "tab": "analysis",
        "title": "Allocation by Sector",
        "data_dependencies": ["detailed_allocation.sector"],
        "web_search_queries": [
            "recommended sector allocation portfolio {current_year}",
        ],
        "refresh_triggers": ["position_change"],
        "prompt_key": "allocation_by_sector",
    },
    "analysis.allocation.by_asset_class": {
        "type": "table",
        "tab": "analysis",
        "title": "Allocation by Asset Class",
        "data_dependencies": ["detailed_allocation.asset_class"],
        "web_search_queries": [
            "recommended asset allocation {user_age} years old",
        ],
        "refresh_triggers": ["position_change"],
        "prompt_key": "allocation_by_asset_class",
    },
    "analysis.allocation.by_geography": {
        "type": "table",
        "tab": "analysis",
        "title": "Allocation by Geography",
        "data_dependencies": ["detailed_allocation.geography"],
        "web_search_queries": [
            "international vs domestic stock allocation recommendation",
        ],
        "refresh_triggers": ["position_change"],
        "prompt_key": "allocation_by_geography",
    },

    # =========================================================================
    # ANALYSIS TAB - Alerts
    # =========================================================================
    "analysis.triggered_alerts": {
        "type": "list",
        "tab": "analysis",
        "title": "Triggered Alerts",
        "data_dependencies": ["triggers.triggered"],
        "web_search_queries": [],
        "refresh_triggers": ["position_change", "price_update"],
        "prompt_key": "triggered_alerts",
    },

    # =========================================================================
    # PROJECTIONS TAB
    # =========================================================================
    "projections.success_rate": {
        "type": "stat_card",
        "tab": "projections",
        "title": "Monte Carlo Success Rate",
        "data_dependencies": ["monte_carlo.success_rate"],
        "web_search_queries": [
            "Monte Carlo retirement success rate interpretation",
        ],
        "refresh_triggers": ["settings_change", "position_change"],
        "prompt_key": "mc_success_rate",
    },
    "projections.median_final_value": {
        "type": "stat_card",
        "tab": "projections",
        "title": "Median Final Value",
        "data_dependencies": ["monte_carlo.median_final_value"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change", "position_change"],
        "prompt_key": "mc_median_final",
    },
    "projections.worst_case": {
        "type": "stat_card",
        "tab": "projections",
        "title": "Worst Case (5th Percentile)",
        "data_dependencies": ["monte_carlo.worst_case"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change", "position_change"],
        "prompt_key": "mc_worst_case",
    },
    "projections.best_case": {
        "type": "stat_card",
        "tab": "projections",
        "title": "Best Case (95th Percentile)",
        "data_dependencies": ["monte_carlo.best_case"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change", "position_change"],
        "prompt_key": "mc_best_case",
    },
    "projections.chart": {
        "type": "chart",
        "tab": "projections",
        "title": "Monte Carlo Projection Chart",
        "data_dependencies": ["monte_carlo.paths"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change", "position_change"],
        "prompt_key": "mc_chart",
    },

    # =========================================================================
    # TAXES TAB
    # =========================================================================
    "taxes.federal_income_tax": {
        "type": "stat_card",
        "tab": "taxes",
        "title": "Federal Income Tax (Lifetime)",
        "data_dependencies": ["tax_projection.federal_total"],
        "web_search_queries": [
            "average federal income tax retirement",
        ],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "federal_tax",
    },
    "taxes.state_income_tax": {
        "type": "stat_card",
        "tab": "taxes",
        "title": "State Income Tax (Lifetime)",
        "data_dependencies": ["tax_projection.state_total"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "state_tax",
    },
    "taxes.capital_gains_tax": {
        "type": "stat_card",
        "tab": "taxes",
        "title": "Capital Gains Tax (Lifetime)",
        "data_dependencies": ["tax_projection.cap_gains_total"],
        "web_search_queries": [
            "capital gains tax rates {current_year}",
        ],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "cap_gains_tax",
    },
    "taxes.total_tax": {
        "type": "stat_card",
        "tab": "taxes",
        "title": "Total Lifetime Tax",
        "data_dependencies": ["tax_projection.total_tax"],
        "web_search_queries": [
            "tax efficient retirement withdrawal strategy",
        ],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "total_tax",
    },
    "taxes.withdrawal_table": {
        "type": "table",
        "tab": "taxes",
        "title": "Year-by-Year Withdrawal Table",
        "data_dependencies": ["tax_projection.years"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "withdrawal_table",
    },
    "taxes.burden_chart": {
        "type": "chart",
        "tab": "taxes",
        "title": "Tax Burden by Year",
        "data_dependencies": ["tax_projection.years"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "tax_burden_chart",
    },
    "taxes.balance_chart": {
        "type": "chart",
        "tab": "taxes",
        "title": "Account Balance Over Time",
        "data_dependencies": ["tax_projection.balances"],
        "web_search_queries": [],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "tax_balance_chart",
    },

    # =========================================================================
    # BUDGET TAB
    # =========================================================================
    "budget.income_summary": {
        "type": "stat_card",
        "tab": "budget",
        "title": "Income Summary",
        "data_dependencies": ["budget.gross_annual", "budget.net_annual"],
        "web_search_queries": [
            "median household income united states {current_year}",
        ],
        "refresh_triggers": ["budget_change"],
        "prompt_key": "income_summary",
    },
    "budget.expenses_summary": {
        "type": "stat_card",
        "tab": "budget",
        "title": "Expenses Summary",
        "data_dependencies": ["budget.total_expenses"],
        "web_search_queries": [
            "average monthly expenses american household",
        ],
        "refresh_triggers": ["budget_change"],
        "prompt_key": "expenses_summary",
    },
    "budget.cashflow_chart": {
        "type": "chart",
        "tab": "budget",
        "title": "Cash Flow Waterfall",
        "data_dependencies": ["budget.income", "budget.expenses", "budget.net"],
        "web_search_queries": [],
        "refresh_triggers": ["budget_change"],
        "prompt_key": "cashflow_chart",
    },
    "budget.transition_chart": {
        "type": "chart",
        "tab": "budget",
        "title": "Pre/Post Retirement Transition",
        "data_dependencies": ["budget.transition"],
        "web_search_queries": [
            "retirement income replacement ratio",
        ],
        "refresh_triggers": ["budget_change", "settings_change"],
        "prompt_key": "transition_chart",
    },

    # =========================================================================
    # SETTINGS TAB
    # =========================================================================
    "settings.data_storage": {
        "type": "settings_card",
        "tab": "settings",
        "title": "Data Storage Settings",
        "data_dependencies": [],
        "web_search_queries": [],
        "refresh_triggers": [],
        "prompt_key": "settings_data_storage",
    },
    "settings.personal": {
        "type": "settings_card",
        "tab": "settings",
        "title": "Personal Settings",
        "data_dependencies": ["settings.dob", "settings.retirement_age", "settings.withdrawal_rate"],
        "web_search_queries": [
            "4 percent rule retirement withdrawal",
            "safe withdrawal rate retirement {current_year}",
        ],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "settings_personal",
    },
    "settings.asset_targets": {
        "type": "settings_card",
        "tab": "settings",
        "title": "Asset Class Targets",
        "data_dependencies": ["settings.target_equities", "settings.target_bonds"],
        "web_search_queries": [
            "recommended stock bond allocation by age",
            "glide path asset allocation retirement",
        ],
        "refresh_triggers": ["settings_change"],
        "prompt_key": "settings_asset_targets",
    },
    "settings.market_assumptions": {
        "type": "settings_card",
        "tab": "settings",
        "title": "Market Assumptions",
        "data_dependencies": ["settings.stock_return", "settings.stock_std", "settings.inflation"],
        "web_search_queries": [
            "historical stock market average return",
            "historical S&P 500 volatility",
            "long term inflation rate forecast",
        ],
        "refresh_triggers": [],
        "prompt_key": "settings_market_assumptions",
    },
    "settings.monte_carlo": {
        "type": "settings_card",
        "tab": "settings",
        "title": "Monte Carlo Settings",
        "data_dependencies": ["settings.mc_simulations", "settings.black_swan_prob"],
        "web_search_queries": [
            "Monte Carlo simulation retirement planning",
            "black swan event probability finance",
        ],
        "refresh_triggers": [],
        "prompt_key": "settings_monte_carlo",
    },
    "settings.portfolio_views": {
        "type": "settings_card",
        "tab": "settings",
        "title": "Portfolio Views",
        "data_dependencies": [],
        "web_search_queries": [],
        "refresh_triggers": [],
        "prompt_key": "settings_portfolio_views",
    },
}


def get_element_config(element_id: str) -> Optional[ElementConfig]:
    """Get configuration for a specific element."""
    return ELEMENT_REGISTRY.get(element_id)


def get_elements_by_tab(tab: str) -> dict[str, ElementConfig]:
    """Get all elements for a specific tab."""
    return {
        eid: config
        for eid, config in ELEMENT_REGISTRY.items()
        if config.get("tab") == tab
    }


def get_elements_by_trigger(trigger: str) -> list[str]:
    """Get element IDs that should be invalidated by a specific trigger."""
    return [
        eid
        for eid, config in ELEMENT_REGISTRY.items()
        if trigger in config.get("refresh_triggers", [])
    ]


def get_all_element_ids() -> list[str]:
    """Get all registered element IDs."""
    return list(ELEMENT_REGISTRY.keys())
