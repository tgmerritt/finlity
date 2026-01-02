"""
Budget data models and dataclasses.

Provides structured data types for income, expenses, and budget calculations.
"""

from dataclasses import dataclass, field
from typing import Optional
from datetime import datetime
from enum import Enum


class PayFrequency(str, Enum):
    """Pay frequency options."""
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    SEMIMONTHLY = "semimonthly"
    MONTHLY = "monthly"
    ANNUAL = "annual"

    @property
    def periods_per_year(self) -> int:
        """Number of pay periods per year."""
        return {
            "weekly": 52,
            "biweekly": 26,
            "semimonthly": 24,
            "monthly": 12,
            "annual": 1,
        }[self.value]


class FilingStatus(str, Enum):
    """Tax filing status options."""
    SINGLE = "single"
    MARRIED_JOINT = "married_joint"
    MARRIED_SEPARATE = "married_separate"
    HEAD_HOUSEHOLD = "head_household"


class IncomeType(str, Enum):
    """Income source types."""
    EMPLOYMENT = "employment"
    SELF_EMPLOYMENT = "self_employment"
    RENTAL = "rental"
    INVESTMENT = "investment"
    OTHER = "other"


class ExpenseFrequency(str, Enum):
    """Expense frequency options."""
    WEEKLY = "weekly"
    BIWEEKLY = "biweekly"
    MONTHLY = "monthly"
    QUARTERLY = "quarterly"
    ANNUAL = "annual"
    ONE_TIME = "one_time"

    @property
    def periods_per_year(self) -> float:
        """Number of occurrences per year."""
        return {
            "weekly": 52,
            "biweekly": 26,
            "monthly": 12,
            "quarterly": 4,
            "annual": 1,
            "one_time": 0,  # Not recurring
        }[self.value]


@dataclass
class IncomeSource:
    """An income source (job, self-employment, etc.)."""

    id: Optional[int] = None
    name: str = ""
    income_type: str = "employment"
    gross_annual: float = 0.0
    pay_frequency: str = "biweekly"
    state: str = "CA"
    is_active: bool = True
    created_at: Optional[datetime] = None

    @property
    def gross_per_period(self) -> float:
        """Gross income per pay period."""
        freq = PayFrequency(self.pay_frequency)
        return self.gross_annual / freq.periods_per_year

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "id": self.id,
            "name": self.name,
            "income_type": self.income_type,
            "gross_annual": round(self.gross_annual, 2),
            "pay_frequency": self.pay_frequency,
            "state": self.state,
            "is_active": self.is_active,
            "gross_per_period": round(self.gross_per_period, 2),
        }


@dataclass
class ExpenseCategory:
    """Expense category for grouping expenses."""

    id: Optional[int] = None
    name: str = ""
    icon: str = ""
    color: str = "#6b7280"
    sort_order: int = 0

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "id": self.id,
            "name": self.name,
            "icon": self.icon,
            "color": self.color,
            "sort_order": self.sort_order,
        }


@dataclass
class Expense:
    """A recurring or one-time expense."""

    id: Optional[int] = None
    category_id: int = 0
    category_name: str = ""
    name: str = ""
    amount: float = 0.0
    frequency: str = "monthly"
    is_pretax: bool = False  # 401k, HSA contributions
    is_mortgage: bool = False
    principal_portion: Optional[float] = None
    interest_portion: Optional[float] = None
    is_active: bool = True
    start_date: Optional[datetime] = None
    end_date: Optional[datetime] = None

    @property
    def annual_amount(self) -> float:
        """Calculate annual cost."""
        freq = ExpenseFrequency(self.frequency)
        if freq == ExpenseFrequency.ONE_TIME:
            return self.amount
        return self.amount * freq.periods_per_year

    @property
    def monthly_amount(self) -> float:
        """Calculate monthly equivalent."""
        return self.annual_amount / 12

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "id": self.id,
            "category_id": self.category_id,
            "category_name": self.category_name,
            "name": self.name,
            "amount": round(self.amount, 2),
            "frequency": self.frequency,
            "is_pretax": self.is_pretax,
            "is_mortgage": self.is_mortgage,
            "principal_portion": round(self.principal_portion, 2) if self.principal_portion else None,
            "interest_portion": round(self.interest_portion, 2) if self.interest_portion else None,
            "is_active": self.is_active,
            "annual_amount": round(self.annual_amount, 2),
            "monthly_amount": round(self.monthly_amount, 2),
        }


@dataclass
class PretaxDeduction:
    """Pre-tax deduction from income (401k, HSA, etc.)."""

    id: Optional[int] = None
    income_source_id: Optional[int] = None
    deduction_type: str = "401k"  # "401k", "hsa", "fsa", "dental", "vision", "other"
    amount_per_period: float = 0.0
    employer_match: float = 0.0  # Employer contribution
    is_percentage: bool = False  # If true, amount is % of gross
    max_annual: Optional[float] = None  # Max annual contribution

    @property
    def annual_amount(self) -> float:
        """Annual deduction (assumes biweekly if percentage-based)."""
        # This would need income context for percentage calculation
        return self.amount_per_period * 26  # Assuming biweekly

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "id": self.id,
            "income_source_id": self.income_source_id,
            "deduction_type": self.deduction_type,
            "amount_per_period": round(self.amount_per_period, 2),
            "employer_match": round(self.employer_match, 2),
            "is_percentage": self.is_percentage,
            "max_annual": round(self.max_annual, 2) if self.max_annual else None,
        }


@dataclass
class TaxConfig:
    """Tax configuration for the household."""

    id: Optional[int] = None
    tax_year: int = 2024
    filing_status: str = "single"
    state: str = "CA"
    ss_benefit_override: Optional[float] = None  # User-specified SS benefit
    additional_withholding: float = 0.0
    itemized_deduction: Optional[float] = None  # None = use standard
    created_at: Optional[datetime] = None

    @property
    def use_standard_deduction(self) -> bool:
        """Whether to use standard deduction."""
        return self.itemized_deduction is None

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "id": self.id,
            "tax_year": self.tax_year,
            "filing_status": self.filing_status,
            "state": self.state,
            "ss_benefit_override": round(self.ss_benefit_override, 2) if self.ss_benefit_override else None,
            "additional_withholding": round(self.additional_withholding, 2),
            "itemized_deduction": round(self.itemized_deduction, 2) if self.itemized_deduction else None,
            "use_standard_deduction": self.use_standard_deduction,
        }


@dataclass
class AnnualBudgetSummary:
    """Annual budget summary with all income and expense totals."""

    # Income
    gross_income: float = 0.0
    total_income_sources: int = 0

    # Taxes
    federal_income_tax: float = 0.0
    state_income_tax: float = 0.0
    social_security_tax: float = 0.0
    medicare_tax: float = 0.0
    total_taxes: float = 0.0

    # Deductions
    total_pretax_deductions: float = 0.0
    employer_match_total: float = 0.0

    # Net income
    net_income: float = 0.0

    # Expenses
    total_expenses: float = 0.0
    expenses_by_category: dict = field(default_factory=dict)

    # Savings
    net_savings: float = 0.0
    savings_rate: float = 0.0  # As percentage

    # Effective rates
    effective_tax_rate: float = 0.0
    marginal_federal_rate: float = 0.0
    marginal_state_rate: float = 0.0

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "gross_income": round(self.gross_income, 2),
            "total_income_sources": self.total_income_sources,
            "federal_income_tax": round(self.federal_income_tax, 2),
            "state_income_tax": round(self.state_income_tax, 2),
            "social_security_tax": round(self.social_security_tax, 2),
            "medicare_tax": round(self.medicare_tax, 2),
            "total_taxes": round(self.total_taxes, 2),
            "total_pretax_deductions": round(self.total_pretax_deductions, 2),
            "employer_match_total": round(self.employer_match_total, 2),
            "net_income": round(self.net_income, 2),
            "total_expenses": round(self.total_expenses, 2),
            "expenses_by_category": {
                k: round(v, 2) for k, v in self.expenses_by_category.items()
            },
            "net_savings": round(self.net_savings, 2),
            "savings_rate": round(self.savings_rate, 2),
            "effective_tax_rate": round(self.effective_tax_rate, 2),
            "marginal_federal_rate": round(self.marginal_federal_rate, 2),
            "marginal_state_rate": round(self.marginal_state_rate, 2),
            "monthly_gross": round(self.gross_income / 12, 2),
            "monthly_net": round(self.net_income / 12, 2),
            "monthly_expenses": round(self.total_expenses / 12, 2),
            "monthly_savings": round(self.net_savings / 12, 2),
        }


@dataclass
class IncomeTransitionYear:
    """Single year in an income transition projection."""

    year: int
    age: int

    # Income sources
    employment_income: float = 0.0
    social_security_income: float = 0.0
    portfolio_withdrawals: float = 0.0
    other_income: float = 0.0
    total_income: float = 0.0

    # Expenses
    total_expenses: float = 0.0

    # Taxes
    income_taxes: float = 0.0

    # Portfolio
    portfolio_contribution: float = 0.0  # During accumulation
    portfolio_balance: float = 0.0
    investment_return: float = 0.0

    # Metadata
    phase: str = "working"  # "working", "bridge", "retired"
    income_source_mix: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "year": self.year,
            "age": self.age,
            "employment_income": round(self.employment_income, 2),
            "social_security_income": round(self.social_security_income, 2),
            "portfolio_withdrawals": round(self.portfolio_withdrawals, 2),
            "other_income": round(self.other_income, 2),
            "total_income": round(self.total_income, 2),
            "total_expenses": round(self.total_expenses, 2),
            "income_taxes": round(self.income_taxes, 2),
            "portfolio_contribution": round(self.portfolio_contribution, 2),
            "portfolio_balance": round(self.portfolio_balance, 2),
            "investment_return": round(self.investment_return, 2),
            "phase": self.phase,
            "income_source_mix": {k: round(v, 4) for k, v in self.income_source_mix.items()},
        }


# Default expense categories
DEFAULT_EXPENSE_CATEGORIES = [
    ExpenseCategory(id=1, name="Housing", icon="home", color="#3b82f6", sort_order=1),
    ExpenseCategory(id=2, name="Utilities", icon="bolt", color="#8b5cf6", sort_order=2),
    ExpenseCategory(id=3, name="Transportation", icon="car", color="#f97316", sort_order=3),
    ExpenseCategory(id=4, name="Insurance", icon="shield", color="#06b6d4", sort_order=4),
    ExpenseCategory(id=5, name="Healthcare", icon="heart", color="#ef4444", sort_order=5),
    ExpenseCategory(id=6, name="Debt Payments", icon="credit-card", color="#f59e0b", sort_order=6),
    ExpenseCategory(id=7, name="Food & Dining", icon="utensils", color="#22c55e", sort_order=7),
    ExpenseCategory(id=8, name="Entertainment", icon="film", color="#ec4899", sort_order=8),
    ExpenseCategory(id=9, name="Savings & Investments", icon="piggy-bank", color="#14b8a6", sort_order=9),
    ExpenseCategory(id=10, name="Personal", icon="user", color="#6366f1", sort_order=10),
    ExpenseCategory(id=11, name="Education", icon="book", color="#84cc16", sort_order=11),
    ExpenseCategory(id=12, name="Other", icon="ellipsis", color="#6b7280", sort_order=99),
]
