"""
Budget module for income and expense tracking with payroll tax calculations.

This module provides:
- PayrollTaxCalculator: Federal and state income tax calculations
- Social Security benefit estimation
- Expense categorization and tracking
- Cash flow analysis and retirement transition projections
"""

from .tax_calculator import PayrollTaxCalculator, PaycheckBreakdown
from .state_taxes import calculate_state_tax, STATE_TAX_BRACKETS
from .social_security import estimate_social_security_benefit
from .models import (
    IncomeSource,
    Expense,
    ExpenseCategory,
    PretaxDeduction,
    TaxConfig,
    AnnualBudgetSummary,
)

__all__ = [
    "PayrollTaxCalculator",
    "PaycheckBreakdown",
    "calculate_state_tax",
    "STATE_TAX_BRACKETS",
    "estimate_social_security_benefit",
    "IncomeSource",
    "Expense",
    "ExpenseCategory",
    "PretaxDeduction",
    "TaxConfig",
    "AnnualBudgetSummary",
]
