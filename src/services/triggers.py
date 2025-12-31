"""Allocation trigger evaluation service."""

import logging
from dataclasses import dataclass
from typing import Optional

from src.database import Database

logger = logging.getLogger(__name__)


# Supported condition types
CONDITION_TYPES = {
    "ticker_value": "Position value exceeds/falls below threshold (in dollars)",
    "ticker_percent": "Position as percentage of portfolio",
    "sector_percent": "Sector allocation as percentage of portfolio",
    "account_invested_percent": "Percentage of account that is invested (vs cash)",
    "total_value": "Total portfolio value",
    "account_value": "Value of a specific account type",
}

# Supported operators
OPERATORS = {
    ">": lambda a, b: a > b,
    "<": lambda a, b: a < b,
    ">=": lambda a, b: a >= b,
    "<=": lambda a, b: a <= b,
    "==": lambda a, b: abs(a - b) < 0.01,  # Float comparison with tolerance
}


@dataclass
class TriggerResult:
    """Result of evaluating a trigger."""

    trigger_id: str
    trigger_name: str
    triggered: bool
    current_value: float
    threshold: float
    operator: str
    condition_description: str
    message: str


class TriggerEvaluator:
    """Evaluates allocation triggers against current portfolio state."""

    def __init__(self, db: Database):
        """Initialize trigger evaluator.

        Args:
            db: Database instance
        """
        self.db = db

    def _get_portfolio_data(self) -> dict:
        """Get current portfolio state for trigger evaluation."""
        summary = self.db.get_portfolio_summary()
        positions = self.db.get_all_positions()
        accounts = self.db.get_all_accounts()

        # Build lookup structures
        account_map = {a.id: a for a in accounts}
        total_value = summary["total_value"]

        # Calculate position values and percentages
        position_values = {}
        ticker_values = {}
        sector_values = {}
        account_values = {}
        account_cash = {}

        for pos in positions:
            value = (pos.shares * pos.current_price) if pos.current_price else 0

            # By position
            position_values[pos.id] = value

            # By ticker (aggregate)
            ticker = pos.ticker.upper()
            ticker_values[ticker] = ticker_values.get(ticker, 0) + value

            # By sector
            if pos.sector:
                sector = pos.sector.lower()
                sector_values[sector] = sector_values.get(sector, 0) + value

            # By account
            account = account_map.get(pos.account_id)
            if account:
                acc_type = account.account_type
                account_values[acc_type] = account_values.get(acc_type, 0) + value

                # Track cash per account
                if pos.position_type == "cash":
                    account_cash[pos.account_id] = account_cash.get(pos.account_id, 0) + value

        # Calculate invested percentage per account
        account_invested_pct = {}
        for account in accounts:
            acc_positions = [p for p in positions if p.account_id == account.id]
            acc_value = sum(
                (p.shares * p.current_price) if p.current_price else 0
                for p in acc_positions
            )
            if acc_value > 0:
                cash_value = account_cash.get(account.id, 0)
                invested_pct = ((acc_value - cash_value) / acc_value) * 100
                account_invested_pct[account.id] = invested_pct
                account_invested_pct[account.account_type] = invested_pct

        return {
            "total_value": total_value,
            "ticker_values": ticker_values,
            "sector_values": sector_values,
            "account_values": account_values,
            "account_invested_pct": account_invested_pct,
            "accounts": accounts,
        }

    def evaluate_trigger(self, trigger, portfolio_data: dict) -> TriggerResult:
        """Evaluate a single trigger.

        Args:
            trigger: AllocationTrigger model instance
            portfolio_data: Pre-computed portfolio data

        Returns:
            TriggerResult with evaluation outcome
        """
        current_value = 0.0
        condition_desc = ""
        total_value = portfolio_data["total_value"]

        if trigger.condition_type == "ticker_value":
            # Check position value in dollars
            ticker = trigger.ticker.upper() if trigger.ticker else ""
            current_value = portfolio_data["ticker_values"].get(ticker, 0)
            condition_desc = f"{ticker} position value"

        elif trigger.condition_type == "ticker_percent":
            # Check position as percentage of portfolio
            ticker = trigger.ticker.upper() if trigger.ticker else ""
            ticker_value = portfolio_data["ticker_values"].get(ticker, 0)
            current_value = (ticker_value / total_value * 100) if total_value > 0 else 0
            condition_desc = f"{ticker} as % of portfolio"

        elif trigger.condition_type == "sector_percent":
            # Check sector as percentage of portfolio
            sector = trigger.sector.lower() if trigger.sector else ""
            sector_value = portfolio_data["sector_values"].get(sector, 0)
            current_value = (sector_value / total_value * 100) if total_value > 0 else 0
            condition_desc = f"{sector.title()} sector as % of portfolio"

        elif trigger.condition_type == "account_invested_percent":
            # Check percentage of account that is invested
            acc_type = trigger.account_type if trigger.account_type else ""
            current_value = portfolio_data["account_invested_pct"].get(acc_type, 0)
            condition_desc = f"{acc_type} account invested %"

        elif trigger.condition_type == "total_value":
            # Check total portfolio value
            current_value = total_value
            condition_desc = "Total portfolio value"

        elif trigger.condition_type == "account_value":
            # Check value of specific account type
            acc_type = trigger.account_type if trigger.account_type else ""
            current_value = portfolio_data["account_values"].get(acc_type, 0)
            condition_desc = f"{acc_type} account value"

        else:
            condition_desc = f"Unknown condition: {trigger.condition_type}"
            return TriggerResult(
                trigger_id=trigger.id,
                trigger_name=trigger.name,
                triggered=False,
                current_value=0,
                threshold=trigger.threshold,
                operator=trigger.operator,
                condition_description=condition_desc,
                message="Unknown condition type",
            )

        # Evaluate the condition
        operator_fn = OPERATORS.get(trigger.operator, lambda a, b: False)
        triggered = operator_fn(current_value, trigger.threshold)

        # Format message
        if triggered:
            message = f"TRIGGERED: {condition_desc} is {current_value:,.2f} {trigger.operator} {trigger.threshold:,.2f}"
        else:
            message = f"OK: {condition_desc} is {current_value:,.2f} (threshold: {trigger.operator} {trigger.threshold:,.2f})"

        return TriggerResult(
            trigger_id=trigger.id,
            trigger_name=trigger.name,
            triggered=triggered,
            current_value=current_value,
            threshold=trigger.threshold,
            operator=trigger.operator,
            condition_description=condition_desc,
            message=message,
        )

    def evaluate_all(self, active_only: bool = True) -> list[TriggerResult]:
        """Evaluate all triggers.

        Args:
            active_only: Only evaluate active triggers

        Returns:
            List of TriggerResult for each trigger
        """
        triggers = self.db.get_all_triggers(active_only=active_only)
        if not triggers:
            return []

        portfolio_data = self._get_portfolio_data()
        results = []

        for trigger in triggers:
            result = self.evaluate_trigger(trigger, portfolio_data)
            results.append(result)

        return results

    def get_triggered(self, active_only: bool = True) -> list[TriggerResult]:
        """Get only triggers that are currently triggered.

        Args:
            active_only: Only check active triggers

        Returns:
            List of triggered TriggerResults
        """
        all_results = self.evaluate_all(active_only=active_only)
        return [r for r in all_results if r.triggered]

    @staticmethod
    def get_condition_types() -> dict[str, str]:
        """Get available condition types and descriptions."""
        return CONDITION_TYPES.copy()

    @staticmethod
    def get_operators() -> list[str]:
        """Get available operators."""
        return list(OPERATORS.keys())
