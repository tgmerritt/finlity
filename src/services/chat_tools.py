"""Tool definitions and executor for context-aware chat.

This module provides tools that Claude can call during chat conversations
to query the portfolio database for detailed information.
"""

import logging

logger = logging.getLogger(__name__)

# Tool schemas for Claude API
CHAT_TOOLS = [
    {
        "name": "get_positions_by_account",
        "description": "Get all positions in a specific account or account type. Use when user asks about holdings in a specific account like 'What's in my Roth IRA?' or 'Show me my 401k positions'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "account_name": {
                    "type": "string",
                    "description": "The account name (e.g., 'Fidelity Roth IRA') or account type (e.g., 'roth_ira', 'traditional_401k', 'taxable')"
                },
                "include_cash": {
                    "type": "boolean",
                    "description": "Whether to include cash positions",
                    "default": True
                }
            },
            "required": ["account_name"]
        }
    },
    {
        "name": "get_allocation_details",
        "description": "Get detailed portfolio allocation breakdown. Use when user asks about asset allocation, sector exposure, geographic diversification, or position concentration.",
        "input_schema": {
            "type": "object",
            "properties": {
                "breakdown_type": {
                    "type": "string",
                    "enum": ["sector", "asset_class", "geography", "cap", "style", "position_type", "account_type"],
                    "description": "Type of allocation breakdown to retrieve"
                },
                "top_n": {
                    "type": "integer",
                    "description": "Return only top N items by value",
                    "default": 10
                }
            },
            "required": ["breakdown_type"]
        }
    },
    {
        "name": "get_position_details",
        "description": "Get detailed information about a specific ticker/position across all accounts. Use when user asks about a specific stock or fund like 'Tell me about my VTI holdings' or 'How much AAPL do I own?'.",
        "input_schema": {
            "type": "object",
            "properties": {
                "ticker": {
                    "type": "string",
                    "description": "The ticker symbol (e.g., 'VTI', 'AAPL', 'VXUS')"
                }
            },
            "required": ["ticker"]
        }
    },
    {
        "name": "get_performance_metrics",
        "description": "Get portfolio performance metrics including returns and alpha. Use when user asks about how their portfolio is performing, returns, or comparison to benchmarks.",
        "input_schema": {
            "type": "object",
            "properties": {
                "benchmark": {
                    "type": "string",
                    "description": "Benchmark ticker for comparison (default: SPY)",
                    "default": "SPY"
                }
            }
        }
    },
    {
        "name": "get_risk_metrics",
        "description": "Get portfolio risk metrics including volatility, Sharpe ratio, beta, and VaR. Use when user asks about portfolio risk, volatility, or risk-adjusted returns.",
        "input_schema": {
            "type": "object",
            "properties": {
                "benchmark": {
                    "type": "string",
                    "description": "Benchmark ticker for beta calculation (default: SPY)",
                    "default": "SPY"
                }
            }
        }
    },
    {
        "name": "get_trigger_status",
        "description": "Get the status of portfolio allocation triggers/alerts. Use when user asks about alerts, triggers, or monitoring conditions.",
        "input_schema": {
            "type": "object",
            "properties": {
                "triggered_only": {
                    "type": "boolean",
                    "description": "Only return triggered alerts",
                    "default": False
                }
            }
        }
    },
    {
        "name": "run_monte_carlo_projection",
        "description": "Run a retirement projection simulation. Use when user asks about retirement planning, success rates, or 'will I have enough'. Only call if user provides or asks to change projection parameters.",
        "input_schema": {
            "type": "object",
            "properties": {
                "current_age": {
                    "type": "integer",
                    "description": "User's current age"
                },
                "retirement_age": {
                    "type": "integer",
                    "description": "Target retirement age"
                },
                "monthly_contribution": {
                    "type": "number",
                    "description": "Monthly savings contribution"
                },
                "monthly_withdrawal": {
                    "type": "number",
                    "description": "Monthly withdrawal in retirement"
                },
                "stock_allocation": {
                    "type": "number",
                    "description": "Stock allocation as decimal (e.g., 0.70 for 70%)",
                    "default": 0.70
                }
            },
            "required": ["current_age", "retirement_age", "monthly_contribution", "monthly_withdrawal"]
        }
    },
    {
        "name": "get_withdrawal_table",
        "description": "Generate a year-by-year withdrawal projection table. Use when user asks about specific withdrawal scenarios or wants to see yearly projections.",
        "input_schema": {
            "type": "object",
            "properties": {
                "withdrawal_rate": {
                    "type": "number",
                    "description": "Annual withdrawal rate as decimal (e.g., 0.04 for 4%)",
                    "default": 0.04
                },
                "start_age": {
                    "type": "integer",
                    "description": "Age to begin withdrawals",
                    "default": 65
                },
                "end_age": {
                    "type": "integer",
                    "description": "Maximum age to project",
                    "default": 95
                }
            }
        }
    },
    {
        "name": "get_tax_projection",
        "description": "Get tax-aware withdrawal projection showing federal/state taxes over time. Use when user asks about taxes in retirement, tax-efficient withdrawals, or RMDs.",
        "input_schema": {
            "type": "object",
            "properties": {
                "current_age": {
                    "type": "integer",
                    "description": "User's current age"
                },
                "retirement_age": {
                    "type": "integer",
                    "description": "Target retirement age"
                },
                "annual_spending": {
                    "type": "number",
                    "description": "Annual spending need in retirement"
                },
                "federal_tax_rate": {
                    "type": "number",
                    "description": "Expected federal marginal tax rate",
                    "default": 0.22
                },
                "state_tax_rate": {
                    "type": "number",
                    "description": "Expected state tax rate",
                    "default": 0.05
                }
            },
            "required": ["current_age", "retirement_age", "annual_spending"]
        }
    }
]


class ChatToolExecutor:
    """Executes chat tools against the database."""

    def __init__(self, db):
        """Initialize the executor with a database instance.

        Args:
            db: Database instance for querying portfolio data
        """
        self.db = db

    def execute_tool(self, tool_name: str, tool_input: dict) -> dict:
        """Execute a tool and return the result.

        Args:
            tool_name: Name of the tool to execute
            tool_input: Input parameters for the tool

        Returns:
            Tool result as a dictionary
        """
        handlers = {
            "get_positions_by_account": self._get_positions_by_account,
            "get_allocation_details": self._get_allocation_details,
            "get_position_details": self._get_position_details,
            "get_performance_metrics": self._get_performance_metrics,
            "get_risk_metrics": self._get_risk_metrics,
            "get_trigger_status": self._get_trigger_status,
            "run_monte_carlo_projection": self._run_monte_carlo_projection,
            "get_withdrawal_table": self._get_withdrawal_table,
            "get_tax_projection": self._get_tax_projection,
        }

        handler = handlers.get(tool_name)
        if not handler:
            return {"error": f"Unknown tool: {tool_name}"}

        try:
            return handler(**tool_input)
        except Exception as e:
            logger.error(f"Tool execution error for {tool_name}: {e}")
            return {"error": str(e)}

    def _get_positions_by_account(self, account_name: str, include_cash: bool = True) -> dict:
        """Get positions for a specific account or account type."""
        accounts = self.db.get_all_accounts()
        positions = self.db.get_all_positions()

        # Find matching accounts (case-insensitive, flexible matching)
        matching_accounts = []
        account_name_lower = account_name.lower().replace("_", " ").replace("-", " ")

        for acc in accounts:
            acc_name_lower = acc.name.lower()
            acc_type_lower = acc.account_type.lower().replace("_", " ")

            if (account_name_lower in acc_name_lower or
                account_name_lower == acc_type_lower or
                account_name_lower in acc_type_lower):
                matching_accounts.append(acc)

        if not matching_accounts:
            return {
                "error": f"No account found matching '{account_name}'",
                "available_accounts": [a.name for a in accounts]
            }

        result_positions = []
        for acc in matching_accounts:
            acc_positions = [p for p in positions if p.account_id == acc.id]
            for pos in acc_positions:
                if not include_cash and pos.position_type == "cash":
                    continue
                value = (pos.shares * pos.current_price) if pos.current_price else 0
                gain_loss = value - pos.cost_basis if pos.cost_basis else None
                result_positions.append({
                    "account": acc.name,
                    "account_type": acc.account_type,
                    "ticker": pos.ticker,
                    "name": pos.name,
                    "shares": round(pos.shares, 4),
                    "price": round(pos.current_price, 2) if pos.current_price else None,
                    "value": round(value, 2),
                    "cost_basis": round(pos.cost_basis, 2) if pos.cost_basis else None,
                    "gain_loss": round(gain_loss, 2) if gain_loss is not None else None,
                    "position_type": pos.position_type,
                })

        total_value = sum(p["value"] for p in result_positions)
        return {
            "accounts": [a.name for a in matching_accounts],
            "positions": result_positions,
            "total_value": round(total_value, 2),
            "position_count": len(result_positions)
        }

    def _get_allocation_details(self, breakdown_type: str, top_n: int = 10) -> dict:
        """Get allocation breakdown."""
        from src.api.analysis import get_detailed_allocation

        try:
            detailed = get_detailed_allocation(self.db)
        except Exception as e:
            return {"error": f"Could not get allocation data: {e}"}

        type_mapping = {
            "sector": "by_sector",
            "asset_class": "by_asset_class",
            "geography": "by_geography",
            "cap": "by_cap",
            "style": "by_style",
            "position_type": "by_position_type",
        }

        data_key = type_mapping.get(breakdown_type)
        if not data_key:
            return {"error": f"Unknown breakdown type: {breakdown_type}", "valid_types": list(type_mapping.keys())}

        rows = getattr(detailed, data_key, [])
        result = [
            {"name": r.name, "value": round(r.total, 2), "percent": round(r.current_pct, 2)}
            for r in rows[:top_n]
        ]

        return {
            "breakdown_type": breakdown_type,
            "total_value": round(detailed.total_value, 2),
            "allocations": result,
            "cash_allocation": round(detailed.cash_allocation, 2),
            "invested_allocation": round(detailed.invested_allocation, 2)
        }

    def _get_position_details(self, ticker: str) -> dict:
        """Get details for a specific ticker across all accounts."""
        positions = self.db.get_all_positions()
        accounts = {a.id: a for a in self.db.get_all_accounts()}

        ticker_upper = ticker.upper()
        matching = [p for p in positions if p.ticker.upper() == ticker_upper]

        if not matching:
            # Suggest similar tickers
            all_tickers = list(set(p.ticker.upper() for p in positions))
            return {"error": f"No positions found for ticker '{ticker}'", "available_tickers": sorted(all_tickers)[:20]}

        total_shares = sum(p.shares for p in matching)
        total_value = sum((p.shares * p.current_price) if p.current_price else 0 for p in matching)
        total_cost = sum(p.cost_basis or 0 for p in matching)

        holdings_by_account = []
        for pos in matching:
            acc = accounts.get(pos.account_id)
            value = (pos.shares * pos.current_price) if pos.current_price else 0
            holdings_by_account.append({
                "account": acc.name if acc else "Unknown",
                "account_type": acc.account_type if acc else "unknown",
                "is_retirement": acc.is_retirement if acc else False,
                "shares": round(pos.shares, 4),
                "value": round(value, 2),
                "cost_basis": round(pos.cost_basis, 2) if pos.cost_basis else None,
            })

        return {
            "ticker": ticker_upper,
            "name": matching[0].name,
            "total_shares": round(total_shares, 4),
            "total_value": round(total_value, 2),
            "total_cost_basis": round(total_cost, 2) if total_cost else None,
            "total_gain_loss": round(total_value - total_cost, 2) if total_cost else None,
            "gain_loss_percent": round((total_value - total_cost) / total_cost * 100, 2) if total_cost and total_cost > 0 else None,
            "is_fund": matching[0].is_fund,
            "sector": matching[0].sector,
            "holdings": holdings_by_account
        }

    def _get_performance_metrics(self, benchmark: str = "SPY") -> dict:
        """Get performance metrics."""
        from src.api.analysis import get_performance

        try:
            result = get_performance(benchmark=benchmark, db=self.db)
            return {
                "total_value": round(result.total_value, 2),
                "total_cost_basis": round(result.total_cost_basis, 2),
                "total_gain_loss": round(result.total_gain_loss, 2),
                "total_gain_loss_pct": round(result.total_gain_loss_pct, 2),
                "ytd_return": round(result.ytd_return, 2) if result.ytd_return else None,
                "benchmark_ytd": round(result.benchmark_ytd, 2) if result.benchmark_ytd else None,
                "alpha_ytd": round(result.alpha_ytd, 2) if result.alpha_ytd else None,
                "benchmark": benchmark
            }
        except Exception as e:
            return {"error": f"Could not get performance metrics: {e}"}

    def _get_risk_metrics(self, benchmark: str = "SPY") -> dict:
        """Get risk metrics."""
        from src.api.analysis import get_risk

        try:
            result = get_risk(benchmark=benchmark, db=self.db)
            return {
                "volatility": round(result.volatility, 2) if result.volatility else None,
                "sharpe_ratio": round(result.sharpe_ratio, 2) if result.sharpe_ratio else None,
                "sortino_ratio": round(result.sortino_ratio, 2) if result.sortino_ratio else None,
                "max_drawdown": round(result.max_drawdown, 2) if result.max_drawdown else None,
                "beta": round(result.beta, 2) if result.beta else None,
                "var_95": round(result.var_95, 2) if result.var_95 else None,
                "diversification_score": round(result.diversification_score, 2) if result.diversification_score else None,
                "benchmark": benchmark
            }
        except Exception as e:
            return {"error": f"Could not get risk metrics: {e}"}

    def _get_trigger_status(self, triggered_only: bool = False) -> dict:
        """Get trigger/alert status."""
        from src.services.triggers import TriggerEvaluator

        try:
            evaluator = TriggerEvaluator(self.db)
            results = evaluator.get_triggered() if triggered_only else evaluator.evaluate_all()

            return {
                "total_triggers": len(results),
                "triggered_count": sum(1 for r in results if r.triggered),
                "triggers": [
                    {
                        "name": r.trigger_name,
                        "triggered": r.triggered,
                        "current_value": round(r.current_value, 2) if r.current_value else None,
                        "threshold": r.threshold,
                        "message": r.message
                    }
                    for r in results
                ]
            }
        except Exception as e:
            return {"error": f"Could not get trigger status: {e}"}

    def _run_monte_carlo_projection(
        self,
        current_age: int,
        retirement_age: int,
        monthly_contribution: float,
        monthly_withdrawal: float,
        stock_allocation: float = 0.70
    ) -> dict:
        """Run Monte Carlo simulation."""
        from src.projections.engine import MonteCarloEngine, ProjectionParams

        try:
            summary = self.db.get_portfolio_summary()

            params = ProjectionParams(
                current_age=current_age,
                retirement_age=retirement_age,
                current_balance=summary["total_value"],
                monthly_contribution=monthly_contribution,
                monthly_withdrawal=monthly_withdrawal,
                stock_allocation=stock_allocation,
                bond_allocation=1.0 - stock_allocation,
            )

            engine = MonteCarloEngine()
            result = engine.run_projection(params)

            return {
                "current_balance": round(summary["total_value"], 2),
                "success_rate": round(result.success_rate * 100, 1),
                "median_final_value": round(result.median_final_value, 2),
                "percentile_10": round(result.percentile_10, 2),
                "percentile_90": round(result.percentile_90, 2),
                "years_to_retirement": retirement_age - current_age,
                "parameters": {
                    "current_age": current_age,
                    "retirement_age": retirement_age,
                    "monthly_contribution": monthly_contribution,
                    "monthly_withdrawal": monthly_withdrawal,
                    "stock_allocation": stock_allocation
                }
            }
        except Exception as e:
            return {"error": f"Could not run Monte Carlo projection: {e}"}

    def _get_withdrawal_table(
        self,
        withdrawal_rate: float = 0.04,
        start_age: int = 65,
        end_age: int = 95
    ) -> dict:
        """Generate withdrawal projection table."""
        from src.projections.engine import WithdrawalProjection

        try:
            summary = self.db.get_portfolio_summary()
            starting_balance = summary["total_value"]

            projection = WithdrawalProjection()
            result = projection.project_withdrawals(
                starting_balance=starting_balance,
                withdrawal_rate_or_amount=withdrawal_rate,
                is_percentage=True,
                start_age=start_age,
                end_age=end_age,
            )

            # Return sample years, not full table
            sample_ages = [start_age, 70, 75, 80, 85, 90, end_age]
            sample_years = [r for r in result.rows if r.age in sample_ages]

            return {
                "starting_balance": round(starting_balance, 2),
                "withdrawal_rate": withdrawal_rate,
                "annual_withdrawal": round(result.rows[0].withdrawal_amount, 2) if result.rows else 0,
                "success": result.success,
                "depletion_age": result.depletion_age,
                "final_balance": round(result.final_balance, 2) if result.final_balance else 0,
                "sample_years": [
                    {
                        "age": r.age,
                        "beginning_balance": round(r.beginning_balance, 2),
                        "withdrawal": round(r.withdrawal_amount, 2),
                        "ending_balance": round(r.ending_balance, 2)
                    }
                    for r in sample_years
                ]
            }
        except Exception as e:
            return {"error": f"Could not generate withdrawal table: {e}"}

    def _get_tax_projection(
        self,
        current_age: int,
        retirement_age: int,
        annual_spending: float,
        federal_tax_rate: float = 0.22,
        state_tax_rate: float = 0.05
    ) -> dict:
        """Run tax-aware projection."""
        try:
            from src.projections.engine import TaxAwareWithdrawalStrategy, AccountBalances
            from src.api.projections import get_account_balances_by_type

            balances = get_account_balances_by_type(self.db)

            initial_balances = AccountBalances(
                taxable=balances.taxable,
                traditional=balances.traditional,
                roth=balances.roth,
            )

            strategy = TaxAwareWithdrawalStrategy(
                tax_rate_ordinary=federal_tax_rate,
                tax_rate_state=state_tax_rate,
                filing_status="married_joint",  # Default for chat tool
                tax_year=2025,
            )

            result = strategy.project_year_by_year(
                current_age=current_age,
                retirement_age=retirement_age,
                end_age=95,
                initial_balances=initial_balances,
                annual_spending=annual_spending,
            )

            return {
                "total_federal_tax": round(result.summary.total_federal_tax, 2),
                "total_state_tax": round(result.summary.total_state_tax, 2),
                "total_tax": round(result.summary.total_tax, 2),
                "average_effective_rate": round(result.summary.average_effective_rate * 100, 2),
                "depletion_age": result.summary.depletion_age,
                "final_balance": round(result.summary.final_balance, 2),
                "account_balances": {
                    "taxable": round(balances.taxable, 2),
                    "traditional": round(balances.traditional, 2),
                    "roth": round(balances.roth, 2)
                },
                "parameters": {
                    "current_age": current_age,
                    "retirement_age": retirement_age,
                    "annual_spending": annual_spending,
                    "federal_tax_rate": federal_tax_rate,
                    "state_tax_rate": state_tax_rate
                }
            }
        except Exception as e:
            return {"error": f"Could not generate tax projection: {e}"}
