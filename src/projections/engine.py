"""
Monte Carlo projection engine for retirement planning.

Incorporates black swan/golden swan modeling and t-distribution returns
from the retirement_planner_analyzer project.
"""

from dataclasses import dataclass
from typing import Optional

import numpy as np
from scipy.stats import t as t_dist

# Import tax calculator for pre-retirement tax calculations
from src.budget.tax_calculator import (
    PayrollTaxCalculator,
)


@dataclass
class AccountBalances:
    """Balances by account type for tax-aware simulations."""

    taxable: float = 0.0  # Taxable brokerage accounts
    traditional: float = 0.0  # Traditional IRA/401k (pre-tax)
    roth: float = 0.0  # Roth IRA/401k (post-tax, tax-free growth)

    @property
    def total(self) -> float:
        """Total balance across all account types."""
        return self.taxable + self.traditional + self.roth

    def as_dict(self) -> dict:
        """Return as dictionary."""
        return {
            "taxable": self.taxable,
            "traditional": self.traditional,
            "roth": self.roth,
            "total": self.total,
        }


@dataclass
class ProjectionParams:
    """Parameters for retirement projections."""

    current_age: int
    retirement_age: int
    current_balance: float
    monthly_contribution: float
    monthly_withdrawal: float
    stock_allocation: float = 0.70
    bond_allocation: float = 0.25
    cash_allocation: float = 0.05
    inflation_rate: float = 0.03

    # Tax-aware withdrawal parameters
    use_tax_aware_withdrawals: bool = False
    account_balances: Optional[AccountBalances] = None

    # Tax rates
    tax_rate_ordinary: float = 0.22  # Federal marginal rate for traditional withdrawals
    tax_rate_capital_gains: float = 0.15  # Long-term capital gains rate
    tax_rate_state: float = 0.05  # State income tax rate
    cost_basis_ratio: float = 0.60  # Portion of taxable account that is cost basis (not taxed)

    # Contribution allocation (how monthly contributions are split)
    contribution_traditional_pct: float = 0.60  # % to traditional 401k/IRA
    contribution_roth_pct: float = 0.25  # % to Roth 401k/IRA
    contribution_taxable_pct: float = 0.15  # % to taxable brokerage


@dataclass
class ProjectionResult:
    """Results from a single projection run."""

    ages: list[int]
    median_values: list[float]
    percentile_10: list[float]
    percentile_25: list[float]
    percentile_75: list[float]
    percentile_90: list[float]
    success_rate: float  # Probability of not running out of money
    median_final_value: float
    worst_case_final: float
    best_case_final: float


@dataclass
class SensitivityResult:
    """Results from sensitivity analysis."""

    contribution_impacts: dict[float, float]  # monthly_contribution -> final_value
    return_impacts: dict[float, float]  # return_rate -> final_value
    withdrawal_impacts: dict[float, float]  # withdrawal_rate -> success_rate


# RMD divisor table (age -> divisor) based on IRS Uniform Lifetime Table
# https://www.irs.gov/publications/p590b
RMD_TABLE = {
    73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1, 80: 20.2,
    81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2, 87: 14.4, 88: 13.7,
    89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1, 94: 9.5, 95: 8.9, 96: 8.4,
    97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4, 101: 6.0, 102: 5.6, 103: 5.2, 104: 4.9,
    105: 4.6, 106: 4.3, 107: 4.1, 108: 3.9, 109: 3.7, 110: 3.5, 111: 3.4, 112: 3.3,
    113: 3.1, 114: 3.0, 115: 2.9, 116: 2.8, 117: 2.7, 118: 2.5, 119: 2.3, 120: 2.0,
}


@dataclass
class WithdrawalBreakdown:
    """Breakdown of a withdrawal by source and tax impact."""

    gross_needed: float  # Total spending needed
    from_taxable: float  # Withdrawn from taxable accounts
    from_traditional: float  # Withdrawn from traditional IRA/401k
    from_roth: float  # Withdrawn from Roth accounts
    rmd_amount: float  # Required minimum distribution (may overlap with from_traditional)
    taxes_paid: float  # Total taxes on withdrawals
    federal_tax: float = 0.0  # Federal portion of taxes
    state_tax: float = 0.0  # State portion of taxes
    net_withdrawal: float = 0.0  # After-tax amount available for spending


@dataclass
class TaxYearProjection:
    """Single year in tax-aware withdrawal projection."""

    year: int
    age: int
    # Balances at start of year
    taxable_balance: float
    traditional_balance: float
    roth_balance: float
    total_balance: float
    # Withdrawals
    rmd_amount: float
    from_taxable: float
    from_traditional: float
    from_roth: float
    gross_withdrawal: float
    # Taxes
    federal_tax: float
    state_tax: float
    total_tax: float
    effective_rate: float
    # Net
    net_withdrawal: float
    # Investment return for the year
    investment_return: float
    # Phase tracking (for frontend filtering)
    phase: str = "withdrawal"  # "accumulation" or "withdrawal"
    income_source: str = "withdrawal"  # "salary" or "withdrawal"


@dataclass
class TaxProjectionSummary:
    """Summary statistics for tax projection."""

    total_federal_tax: float
    total_state_tax: float
    total_tax: float
    average_effective_rate: float
    total_withdrawn: float  # Net withdrawals (after tax)
    total_gross_withdrawn: float  # Gross withdrawals (before tax)
    final_balance: float
    depletion_age: Optional[int]
    # Pre-retirement (accumulation phase) tax totals
    pre_retirement_federal_tax: float = 0.0
    pre_retirement_state_tax: float = 0.0
    pre_retirement_total_tax: float = 0.0
    pre_retirement_avg_effective_rate: float = 0.0
    # Post-retirement (withdrawal phase) tax totals - same as total_ for backwards compat
    post_retirement_federal_tax: float = 0.0
    post_retirement_state_tax: float = 0.0
    post_retirement_total_tax: float = 0.0


@dataclass
class TaxProjectionResult:
    """Result of year-by-year tax projection."""

    years: list[TaxYearProjection]
    summary: TaxProjectionSummary


class TaxAwareWithdrawalStrategy:
    """
    Implements tax-efficient withdrawal ordering.

    Order of withdrawals (conventional wisdom):
    1. Required Minimum Distributions (RMDs) from traditional accounts (mandatory after 73)
    2. Taxable accounts (only gains taxed at capital gains rate)
    3. Traditional IRA/401k (ordinary income tax)
    4. Roth IRA/401k (tax-free, defer as long as possible)

    This strategy minimizes lifetime taxes by:
    - Letting Roth accounts grow tax-free as long as possible
    - Using lower capital gains rates before ordinary income
    - Satisfying RMDs to avoid penalties
    """

    def __init__(
        self,
        tax_rate_ordinary: float = 0.22,
        tax_rate_capital_gains: float = 0.15,
        tax_rate_state: float = 0.05,
        cost_basis_ratio: float = 0.60,
    ):
        """Initialize withdrawal strategy.

        Args:
            tax_rate_ordinary: Marginal federal tax rate for ordinary income
            tax_rate_capital_gains: Long-term capital gains rate
            tax_rate_state: State income tax rate
            cost_basis_ratio: Portion of taxable account that is cost basis
        """
        self.tax_rate_ordinary = tax_rate_ordinary
        self.tax_rate_capital_gains = tax_rate_capital_gains
        self.tax_rate_state = tax_rate_state
        self.cost_basis_ratio = cost_basis_ratio

    def calculate_rmd(self, age: int, traditional_balance: float) -> float:
        """Calculate Required Minimum Distribution.

        Args:
            age: Current age
            traditional_balance: Balance in traditional IRA/401k at start of year

        Returns:
            RMD amount (0 if under RMD age)
        """
        if age < 73 or traditional_balance <= 0:
            return 0.0

        divisor = RMD_TABLE.get(age, 2.0)  # Use 2.0 for ages beyond table
        return traditional_balance / divisor

    def calculate_tax_on_withdrawal(
        self,
        amount: float,
        source: str,  # "taxable", "traditional", "roth"
    ) -> float:
        """Calculate tax owed on a withdrawal.

        Args:
            amount: Withdrawal amount
            source: Account type

        Returns:
            Tax amount
        """
        federal, state = self.calculate_tax_breakdown(amount, source)
        return federal + state

    def calculate_tax_breakdown(
        self,
        amount: float,
        source: str,  # "taxable", "traditional", "roth"
    ) -> tuple[float, float]:
        """Calculate federal and state tax on a withdrawal.

        Args:
            amount: Withdrawal amount
            source: Account type

        Returns:
            Tuple of (federal_tax, state_tax)
        """
        if source == "roth":
            return 0.0, 0.0  # Roth withdrawals are tax-free

        elif source == "taxable":
            # Only gains are taxed (at capital gains rate)
            taxable_portion = amount * (1 - self.cost_basis_ratio)
            # Capital gains are taxed at federal rate only (simplified)
            federal_tax = taxable_portion * self.tax_rate_capital_gains
            # Some states also tax capital gains
            state_tax = taxable_portion * self.tax_rate_state * 0.5  # Reduced state rate on cap gains
            return federal_tax, state_tax

        elif source == "traditional":
            # Entire amount is ordinary income
            federal_tax = amount * self.tax_rate_ordinary
            state_tax = amount * self.tax_rate_state
            return federal_tax, state_tax

        return 0.0, 0.0

    def gross_up_for_taxes(
        self,
        net_needed: float,
        source: str,
    ) -> float:
        """Calculate gross withdrawal needed to get net amount after taxes.

        Args:
            net_needed: After-tax amount needed
            source: Account type

        Returns:
            Gross amount to withdraw
        """
        if source == "roth":
            return net_needed

        elif source == "taxable":
            # Solve: net = gross - (gross * (1 - cost_basis_ratio) * cap_gains_rate)
            taxable_portion = 1 - self.cost_basis_ratio
            effective_rate = taxable_portion * self.tax_rate_capital_gains
            return net_needed / (1 - effective_rate)

        elif source == "traditional":
            # Solve: net = gross - (gross * (ordinary + state))
            total_rate = self.tax_rate_ordinary + self.tax_rate_state
            return net_needed / (1 - total_rate)

        return net_needed

    def execute_withdrawal(
        self,
        spending_needed: float,
        balances: AccountBalances,
        age: int,
    ) -> tuple[WithdrawalBreakdown, AccountBalances]:
        """Execute a tax-efficient withdrawal.

        Args:
            spending_needed: After-tax spending needed
            balances: Current account balances
            age: Current age

        Returns:
            Tuple of (breakdown, new_balances)
        """
        from_taxable = 0.0
        from_traditional = 0.0
        from_roth = 0.0
        total_federal_tax = 0.0
        total_state_tax = 0.0
        remaining_need = spending_needed

        new_balances = AccountBalances(
            taxable=balances.taxable,
            traditional=balances.traditional,
            roth=balances.roth,
        )

        # Step 1: Calculate and satisfy RMD (mandatory)
        rmd_amount = self.calculate_rmd(age, balances.traditional)

        if rmd_amount > 0 and new_balances.traditional > 0:
            actual_rmd = min(rmd_amount, new_balances.traditional)
            from_traditional += actual_rmd
            new_balances.traditional -= actual_rmd

            # Calculate tax on RMD
            federal, state = self.calculate_tax_breakdown(actual_rmd, "traditional")
            total_federal_tax += federal
            total_state_tax += state
            rmd_tax = federal + state

            # RMD provides after-tax spending
            rmd_after_tax = actual_rmd - rmd_tax
            remaining_need = max(0, remaining_need - rmd_after_tax)

        # Step 2: Withdraw from taxable accounts
        if remaining_need > 0 and new_balances.taxable > 0:
            gross_needed = self.gross_up_for_taxes(remaining_need, "taxable")
            actual_withdrawal = min(gross_needed, new_balances.taxable)

            from_taxable += actual_withdrawal
            new_balances.taxable -= actual_withdrawal

            federal, state = self.calculate_tax_breakdown(actual_withdrawal, "taxable")
            total_federal_tax += federal
            total_state_tax += state
            tax = federal + state

            after_tax = actual_withdrawal - tax
            remaining_need = max(0, remaining_need - after_tax)

        # Step 3: Withdraw from traditional accounts
        if remaining_need > 0 and new_balances.traditional > 0:
            gross_needed = self.gross_up_for_taxes(remaining_need, "traditional")
            actual_withdrawal = min(gross_needed, new_balances.traditional)

            from_traditional += actual_withdrawal
            new_balances.traditional -= actual_withdrawal

            federal, state = self.calculate_tax_breakdown(actual_withdrawal, "traditional")
            total_federal_tax += federal
            total_state_tax += state
            tax = federal + state

            after_tax = actual_withdrawal - tax
            remaining_need = max(0, remaining_need - after_tax)

        # Step 4: Withdraw from Roth (last resort, tax-free)
        if remaining_need > 0 and new_balances.roth > 0:
            actual_withdrawal = min(remaining_need, new_balances.roth)

            from_roth += actual_withdrawal
            new_balances.roth -= actual_withdrawal

            # No tax on Roth
            remaining_need = max(0, remaining_need - actual_withdrawal)

        taxes_paid = total_federal_tax + total_state_tax
        breakdown = WithdrawalBreakdown(
            gross_needed=spending_needed,
            from_taxable=from_taxable,
            from_traditional=from_traditional,
            from_roth=from_roth,
            rmd_amount=rmd_amount,
            taxes_paid=taxes_paid,
            federal_tax=total_federal_tax,
            state_tax=total_state_tax,
            net_withdrawal=spending_needed - remaining_need,
        )

        return breakdown, new_balances

    def project_year_by_year(
        self,
        current_age: int,
        retirement_age: int,
        end_age: int,
        initial_balances: AccountBalances,
        annual_spending: float,
        expected_return: float = 0.06,
        inflation_rate: float = 0.03,
        monthly_contribution: float = 0.0,
        contribution_to_traditional_pct: float = 0.60,
        contribution_to_roth_pct: float = 0.25,
        contribution_to_taxable_pct: float = 0.15,
        # Pre-retirement income parameters (for accumulation phase taxes)
        pre_retirement_income: float = 0.0,
        pre_retirement_deductions: float = 0.0,
        filing_status: str = "single",
        state: str = "CA",
        tax_year: int = 2024,
    ) -> TaxProjectionResult:
        """Project year-by-year tax burden and account balances.

        Includes two phases:
        1. Accumulation (current_age to retirement_age): contributions + growth, taxes on salary
        2. Withdrawal (retirement_age to end_age): withdrawals + growth, taxes on withdrawals

        Args:
            current_age: Current age (start of projection)
            retirement_age: Age to begin withdrawals
            end_age: Age to project to
            initial_balances: Starting account balances
            annual_spending: Annual spending need in retirement (will be inflation-adjusted)
            expected_return: Expected annual investment return
            inflation_rate: Annual inflation rate
            monthly_contribution: Monthly contribution during accumulation phase
            contribution_to_traditional_pct: % of contributions to traditional accounts
            contribution_to_roth_pct: % of contributions to Roth accounts
            contribution_to_taxable_pct: % of contributions to taxable accounts
            pre_retirement_income: Total annual gross income during working years
            pre_retirement_deductions: Annual pre-tax deductions (401k, HSA, etc.)
            filing_status: Tax filing status (single, married_joint, etc.)
            state: Two-letter state code for state taxes
            tax_year: Base tax year for brackets (will adjust for inflation in future years)

        Returns:
            TaxProjectionResult with year-by-year projections
        """
        years: list[TaxYearProjection] = []
        balances = AccountBalances(
            taxable=initial_balances.taxable,
            traditional=initial_balances.traditional,
            roth=initial_balances.roth,
        )

        total_federal_tax = 0.0
        total_state_tax = 0.0
        total_withdrawn = 0.0  # Net (after-tax)
        total_gross_withdrawn = 0.0  # Gross (before-tax)
        depletion_age: Optional[int] = None
        effective_rates: list[float] = []

        # Pre-retirement tax tracking
        pre_retirement_federal = 0.0
        pre_retirement_state = 0.0
        pre_retirement_effective_rates: list[float] = []

        annual_contribution = monthly_contribution * 12
        year_num = 0

        # Create tax calculator for pre-retirement income taxes
        tax_calculator = PayrollTaxCalculator(
            filing_status=filing_status,
            state=state,
            tax_year=tax_year,
        )

        # ===== PHASE 1: ACCUMULATION (current_age to retirement_age - 1) =====
        for age in range(current_age, retirement_age):
            year_num += 1

            # Record starting balances
            start_taxable = balances.taxable
            start_traditional = balances.traditional
            start_roth = balances.roth
            start_total = balances.total

            # Apply investment return first (beginning of year)
            investment_return = balances.total * expected_return
            balances.taxable *= (1 + expected_return)
            balances.traditional *= (1 + expected_return)
            balances.roth *= (1 + expected_return)

            # Add contributions (end of year)
            balances.traditional += annual_contribution * contribution_to_traditional_pct
            balances.roth += annual_contribution * contribution_to_roth_pct
            balances.taxable += annual_contribution * contribution_to_taxable_pct

            # Calculate taxes on salary income (if provided)
            federal_tax_yr = 0.0
            state_tax_yr = 0.0
            effective_rate_yr = 0.0

            if pre_retirement_income > 0:
                # Calculate federal income tax using progressive brackets
                federal_tax_yr = tax_calculator.calculate_federal_income_tax(
                    annual_gross=pre_retirement_income,
                    pretax_deductions=pre_retirement_deductions,
                    use_standard_deduction=True,
                )

                # Calculate state income tax
                state_tax_yr = tax_calculator.calculate_state_tax(
                    annual_gross=pre_retirement_income,
                    pretax_deductions=pre_retirement_deductions,
                )

                # Calculate FICA taxes (Social Security + Medicare)
                ss, medicare, add_medicare = tax_calculator.calculate_fica(pre_retirement_income)
                fica_tax = ss + medicare + add_medicare

                # Add FICA to federal for display (it's federal tax)
                federal_tax_yr += fica_tax

                # Track pre-retirement totals
                pre_retirement_federal += federal_tax_yr
                pre_retirement_state += state_tax_yr

                # Calculate effective rate on gross income
                total_tax_yr = federal_tax_yr + state_tax_yr
                effective_rate_yr = (total_tax_yr / pre_retirement_income * 100) if pre_retirement_income > 0 else 0
                pre_retirement_effective_rates.append(effective_rate_yr)

            # Record accumulation year with salary-based taxes
            years.append(TaxYearProjection(
                year=year_num,
                age=age,
                taxable_balance=round(start_taxable, 2),
                traditional_balance=round(start_traditional, 2),
                roth_balance=round(start_roth, 2),
                total_balance=round(start_total, 2),
                rmd_amount=0,
                from_taxable=0,
                from_traditional=0,
                from_roth=0,
                gross_withdrawal=round(pre_retirement_income, 2),  # Salary as "income"
                federal_tax=round(federal_tax_yr, 2),
                state_tax=round(state_tax_yr, 2),
                total_tax=round(federal_tax_yr + state_tax_yr, 2),
                effective_rate=round(effective_rate_yr, 2),
                net_withdrawal=round(pre_retirement_income - federal_tax_yr - state_tax_yr - pre_retirement_deductions, 2),
                investment_return=round(investment_return, 2),
                phase="accumulation",
                income_source="salary",
            ))

        # ===== PHASE 2: WITHDRAWAL (retirement_age to end_age) =====
        years_in_retirement = 0
        for age in range(retirement_age, end_age + 1):
            year_num += 1
            years_in_retirement += 1

            # Record starting balances
            start_taxable = balances.taxable
            start_traditional = balances.traditional
            start_roth = balances.roth
            start_total = balances.total

            # Calculate inflation-adjusted spending need (from retirement start)
            inflation_adjusted_spending = annual_spending * (1 + inflation_rate) ** (years_in_retirement - 1)

            # Skip if already depleted
            if balances.total <= 0:
                if depletion_age is None:
                    depletion_age = age - 1
                years.append(TaxYearProjection(
                    year=year_num,
                    age=age,
                    taxable_balance=0,
                    traditional_balance=0,
                    roth_balance=0,
                    total_balance=0,
                    rmd_amount=0,
                    from_taxable=0,
                    from_traditional=0,
                    from_roth=0,
                    gross_withdrawal=0,
                    federal_tax=0,
                    state_tax=0,
                    total_tax=0,
                    effective_rate=0,
                    net_withdrawal=0,
                    investment_return=0,
                    phase="withdrawal",
                    income_source="withdrawal",
                ))
                continue

            # Execute withdrawal
            breakdown, balances = self.execute_withdrawal(
                spending_needed=inflation_adjusted_spending,
                balances=balances,
                age=age,
            )

            # Calculate effective tax rate
            gross_withdrawal = breakdown.from_taxable + breakdown.from_traditional + breakdown.from_roth
            if gross_withdrawal > 0:
                effective_rate = (breakdown.federal_tax + breakdown.state_tax) / gross_withdrawal * 100
            else:
                effective_rate = 0.0

            # Apply investment return to remaining balances
            investment_return = balances.total * expected_return
            balances.taxable *= (1 + expected_return)
            balances.traditional *= (1 + expected_return)
            balances.roth *= (1 + expected_return)

            # Track totals
            total_federal_tax += breakdown.federal_tax
            total_state_tax += breakdown.state_tax
            total_withdrawn += breakdown.net_withdrawal
            total_gross_withdrawn += gross_withdrawal
            effective_rates.append(effective_rate)

            years.append(TaxYearProjection(
                year=year_num,
                age=age,
                taxable_balance=round(start_taxable, 2),
                traditional_balance=round(start_traditional, 2),
                roth_balance=round(start_roth, 2),
                total_balance=round(start_total, 2),
                rmd_amount=round(breakdown.rmd_amount, 2),
                from_taxable=round(breakdown.from_taxable, 2),
                from_traditional=round(breakdown.from_traditional, 2),
                from_roth=round(breakdown.from_roth, 2),
                gross_withdrawal=round(gross_withdrawal, 2),
                federal_tax=round(breakdown.federal_tax, 2),
                state_tax=round(breakdown.state_tax, 2),
                total_tax=round(breakdown.federal_tax + breakdown.state_tax, 2),
                effective_rate=round(effective_rate, 2),
                net_withdrawal=round(breakdown.net_withdrawal, 2),
                investment_return=round(investment_return, 2),
                phase="withdrawal",
                income_source="withdrawal",
            ))

        # Calculate summary
        avg_effective_rate = sum(effective_rates) / len(effective_rates) if effective_rates else 0.0
        pre_retirement_avg_rate = (
            sum(pre_retirement_effective_rates) / len(pre_retirement_effective_rates)
            if pre_retirement_effective_rates else 0.0
        )

        # Total taxes include both pre-retirement and post-retirement
        combined_federal = total_federal_tax + pre_retirement_federal
        combined_state = total_state_tax + pre_retirement_state

        summary = TaxProjectionSummary(
            total_federal_tax=round(combined_federal, 2),
            total_state_tax=round(combined_state, 2),
            total_tax=round(combined_federal + combined_state, 2),
            average_effective_rate=round(avg_effective_rate, 2),  # Retirement phase only
            total_withdrawn=round(total_withdrawn, 2),
            total_gross_withdrawn=round(total_gross_withdrawn, 2),
            final_balance=round(balances.total, 2),
            depletion_age=depletion_age,
            # Pre-retirement totals
            pre_retirement_federal_tax=round(pre_retirement_federal, 2),
            pre_retirement_state_tax=round(pre_retirement_state, 2),
            pre_retirement_total_tax=round(pre_retirement_federal + pre_retirement_state, 2),
            pre_retirement_avg_effective_rate=round(pre_retirement_avg_rate, 2),
            # Post-retirement totals (withdrawal phase only)
            post_retirement_federal_tax=round(total_federal_tax, 2),
            post_retirement_state_tax=round(total_state_tax, 2),
            post_retirement_total_tax=round(total_federal_tax + total_state_tax, 2),
        )

        return TaxProjectionResult(years=years, summary=summary)


class MonteCarloEngine:
    """
    Monte Carlo simulation engine with black swan modeling.

    Uses:
    - Student's t-distribution for heavy-tailed returns
    - Black swan events (rare large drops)
    - Golden swan events (rare large gains)
    - Correlated returns between stocks and bonds
    """

    def __init__(self, config: dict | None = None):
        # Load config from database (with yaml fallback) if not provided
        if config is None:
            try:
                from src.api.settings import load_config
                config = load_config()
            except Exception:
                config = {}

        market = config.get("market", {})
        mc = config.get("monte_carlo", {})

        self.stock_mean = market.get("stock_mean_return", 0.09)
        self.stock_std = market.get("stock_std_dev", 0.15)
        self.bond_mean = market.get("bond_mean_return", 0.04)
        self.bond_std = market.get("bond_std_dev", 0.06)
        self.correlation = market.get("stock_bond_correlation", -0.2)
        self.inflation = market.get("inflation_rate", 0.03)

        self.num_simulations = mc.get("num_simulations", 10000)
        self.black_swan_prob = mc.get("black_swan_probability", 0.02)
        self.black_swan_impact = mc.get("black_swan_impact", -0.40)
        self.golden_swan_prob = mc.get("golden_swan_probability", 0.02)
        self.golden_swan_impact = mc.get("golden_swan_impact", 0.27)
        self.t_df = mc.get("t_distribution_df", 5)

    def generate_annual_return(
        self,
        stock_allocation: float,
        bond_allocation: float,
        cash_allocation: float = 0.05,
    ) -> float:
        """
        Generate a single year's return using t-distribution with black/golden swan events.
        """
        # Check for black swan or golden swan event
        rand_value = np.random.rand()

        if rand_value < self.black_swan_prob:
            # Black swan event
            return self.black_swan_impact
        elif rand_value < self.black_swan_prob + self.golden_swan_prob:
            # Golden swan event
            return self.golden_swan_impact
        else:
            # Normal return using t-distribution for heavier tails
            expected_return = (
                stock_allocation * self.stock_mean
                + bond_allocation * self.bond_mean
                + cash_allocation * 0.03
            )

            # Use t-distribution with lower degrees of freedom for fatter tails
            annual_return = t_dist.rvs(
                self.t_df,
                loc=expected_return,
                scale=self.stock_std * stock_allocation + self.bond_std * bond_allocation,
            )

            # Cap to realistic limits
            return max(min(annual_return, 1.0), -0.80)

    def generate_correlated_returns(
        self,
        num_years: int,
        num_simulations: int,
    ) -> tuple[np.ndarray, np.ndarray]:
        """Generate correlated stock and bond returns using Cholesky decomposition."""
        # Create correlation matrix
        corr_matrix = np.array([
            [1, self.correlation],
            [self.correlation, 1],
        ])

        # Generate uncorrelated random numbers
        uncorrelated = np.random.normal(size=(2, num_simulations, num_years))

        # Apply Cholesky decomposition
        cholesky = np.linalg.cholesky(corr_matrix)
        correlated = np.dot(cholesky, uncorrelated.reshape(2, -1)).reshape(2, num_simulations, num_years)

        # Transform to returns
        stock_returns = self.stock_mean + self.stock_std * correlated[0]
        bond_returns = self.bond_mean + self.bond_std * correlated[1]

        return stock_returns, bond_returns

    def run_projection(
        self,
        params: ProjectionParams,
        end_age: int = 95,
    ) -> ProjectionResult:
        """
        Run Monte Carlo simulation for retirement projection.

        Supports two modes:
        - Simple mode (use_tax_aware_withdrawals=False): Single pool of money
        - Tax-aware mode (use_tax_aware_withdrawals=True): Tracks taxable, traditional, and Roth
          accounts separately with proper withdrawal ordering and tax treatment

        Returns percentile bands for portfolio value at each age.
        """
        years = end_age - params.current_age + 1
        portfolio_sims = np.zeros((self.num_simulations, years))

        # Initialize based on mode
        use_tax_aware = params.use_tax_aware_withdrawals and params.account_balances is not None

        if use_tax_aware:
            # Tax-aware mode: use provided account balances
            initial_balances = params.account_balances
            portfolio_sims[:, 0] = initial_balances.total

            # Create withdrawal strategy
            withdrawal_strategy = TaxAwareWithdrawalStrategy(
                tax_rate_ordinary=params.tax_rate_ordinary,
                tax_rate_capital_gains=params.tax_rate_capital_gains,
                tax_rate_state=params.tax_rate_state,
                cost_basis_ratio=params.cost_basis_ratio,
            )
        else:
            # Simple mode: single pool
            portfolio_sims[:, 0] = params.current_balance

        for sim in range(self.num_simulations):
            if use_tax_aware:
                # Track separate account balances
                balances = AccountBalances(
                    taxable=initial_balances.taxable,
                    traditional=initial_balances.traditional,
                    roth=initial_balances.roth,
                )
            else:
                portfolio_value = params.current_balance

            for year in range(1, years):
                current_age = params.current_age + year

                # Generate return
                annual_return = self.generate_annual_return(
                    params.stock_allocation,
                    params.bond_allocation,
                    params.cash_allocation,
                )

                if use_tax_aware:
                    # Apply return to each account type
                    balances.taxable *= (1 + annual_return)
                    balances.traditional *= (1 + annual_return)
                    balances.roth *= (1 + annual_return)

                    # Add contributions if pre-retirement (split by allocation)
                    if current_age < params.retirement_age:
                        annual_contribution = params.monthly_contribution * 12
                        balances.traditional += annual_contribution * params.contribution_traditional_pct
                        balances.roth += annual_contribution * params.contribution_roth_pct
                        balances.taxable += annual_contribution * params.contribution_taxable_pct

                    # Withdraw if in retirement using tax-efficient ordering
                    if current_age >= params.retirement_age:
                        years_retired = current_age - params.retirement_age
                        spending_needed = (
                            params.monthly_withdrawal * 12 * (1 + self.inflation) ** years_retired
                        )

                        # Execute tax-efficient withdrawal
                        _, balances = withdrawal_strategy.execute_withdrawal(
                            spending_needed=spending_needed,
                            balances=balances,
                            age=current_age,
                        )

                    portfolio_sims[sim, year] = balances.total

                else:
                    # Simple mode: single pool
                    portfolio_value *= (1 + annual_return)

                    # Add contribution if pre-retirement
                    if current_age < params.retirement_age:
                        portfolio_value += params.monthly_contribution * 12

                    # Subtract withdrawal if in retirement
                    if current_age >= params.retirement_age:
                        years_retired = current_age - params.retirement_age
                        inflation_adjusted_withdrawal = (
                            params.monthly_withdrawal * 12 * (1 + self.inflation) ** years_retired
                        )
                        portfolio_value = max(0, portfolio_value - inflation_adjusted_withdrawal)

                    portfolio_sims[sim, year] = portfolio_value

        # Calculate percentiles
        ages = list(range(params.current_age, end_age + 1))
        percentiles = np.percentile(portfolio_sims, [10, 25, 50, 75, 90], axis=0)

        # Calculate success rate (didn't run out of money)
        final_values = portfolio_sims[:, -1]
        success_rate = np.mean(final_values > 0)

        return ProjectionResult(
            ages=ages,
            median_values=percentiles[2].tolist(),
            percentile_10=percentiles[0].tolist(),
            percentile_25=percentiles[1].tolist(),
            percentile_75=percentiles[3].tolist(),
            percentile_90=percentiles[4].tolist(),
            success_rate=success_rate,
            median_final_value=float(np.median(final_values)),
            worst_case_final=float(np.percentile(final_values, 5)),
            best_case_final=float(np.percentile(final_values, 95)),
        )

    def run_sensitivity_analysis(
        self,
        params: ProjectionParams,
        end_age: int = 95,
    ) -> SensitivityResult:
        """Run sensitivity analysis on key parameters."""
        # Test different contribution levels
        contribution_impacts = {}
        for mult in [0.5, 0.75, 1.0, 1.25, 1.5, 2.0]:
            test_params = ProjectionParams(
                current_age=params.current_age,
                retirement_age=params.retirement_age,
                current_balance=params.current_balance,
                monthly_contribution=params.monthly_contribution * mult,
                monthly_withdrawal=params.monthly_withdrawal,
                stock_allocation=params.stock_allocation,
                bond_allocation=params.bond_allocation,
            )
            result = self.run_projection(test_params, end_age)
            contribution_impacts[params.monthly_contribution * mult] = result.median_final_value

        # Test different return scenarios (via allocation)
        return_impacts = {}
        for stock_alloc in [0.5, 0.6, 0.7, 0.8, 0.9]:
            test_params = ProjectionParams(
                current_age=params.current_age,
                retirement_age=params.retirement_age,
                current_balance=params.current_balance,
                monthly_contribution=params.monthly_contribution,
                monthly_withdrawal=params.monthly_withdrawal,
                stock_allocation=stock_alloc,
                bond_allocation=1.0 - stock_alloc - 0.05,
            )
            result = self.run_projection(test_params, end_age)
            return_impacts[stock_alloc] = result.median_final_value

        # Test different withdrawal rates
        withdrawal_impacts = {}
        for mult in [0.75, 1.0, 1.25, 1.5]:
            test_params = ProjectionParams(
                current_age=params.current_age,
                retirement_age=params.retirement_age,
                current_balance=params.current_balance,
                monthly_contribution=params.monthly_contribution,
                monthly_withdrawal=params.monthly_withdrawal * mult,
                stock_allocation=params.stock_allocation,
                bond_allocation=params.bond_allocation,
            )
            result = self.run_projection(test_params, end_age)
            withdrawal_impacts[params.monthly_withdrawal * mult] = result.success_rate

        return SensitivityResult(
            contribution_impacts=contribution_impacts,
            return_impacts=return_impacts,
            withdrawal_impacts=withdrawal_impacts,
        )

    def analyze_contribution_stopping_point(
        self,
        params: ProjectionParams,
    ) -> dict[int, float]:
        """
        Analyze what happens if you stop contributing at different ages.

        Returns a dict mapping stop_age -> median_final_value
        """
        results = {}

        for stop_age in range(params.current_age, params.retirement_age + 1):
            portfolio_sims = np.zeros((self.num_simulations,))

            for sim in range(self.num_simulations):
                portfolio_value = params.current_balance

                for age in range(params.current_age, 90):
                    annual_return = self.generate_annual_return(
                        params.stock_allocation,
                        params.bond_allocation,
                    )
                    portfolio_value *= (1 + annual_return)

                    # Only contribute if before stop_age
                    if age < stop_age:
                        portfolio_value += params.monthly_contribution * 12

                    # Withdraw if in retirement
                    if age >= params.retirement_age:
                        years_retired = age - params.retirement_age
                        withdrawal = params.monthly_withdrawal * 12 * (1 + self.inflation) ** years_retired
                        portfolio_value = max(0, portfolio_value - withdrawal)

                portfolio_sims[sim] = portfolio_value

            results[stop_age] = float(np.median(portfolio_sims))

        return results

    def calculate_fire_number(
        self,
        annual_spending: float,
        withdrawal_rate: float = 0.04,
    ) -> float:
        """Calculate the FIRE (Financial Independence, Retire Early) number."""
        return annual_spending / withdrawal_rate

    def estimate_years_to_fire(
        self,
        current_balance: float,
        monthly_contribution: float,
        fire_number: float,
        expected_return: float = 0.07,
    ) -> float:
        """Estimate years until reaching FIRE number."""
        annual_contribution = monthly_contribution * 12

        if expected_return == 0:
            return (fire_number - current_balance) / annual_contribution

        # Using future value formula solved for n
        # FV = PV(1+r)^n + PMT*((1+r)^n - 1)/r
        # This requires numerical solution
        for years in range(1, 100):
            future_value = (
                current_balance * (1 + expected_return) ** years
                + annual_contribution * ((1 + expected_return) ** years - 1) / expected_return
            )
            if future_value >= fire_number:
                return years

        return float("inf")


@dataclass
class WithdrawalYearRow:
    """Single year in withdrawal projection table."""

    year: int
    age: int
    beginning_balance: float
    withdrawal_amount: float
    investment_return: float
    ending_balance: float
    cumulative_withdrawn: float


@dataclass
class WithdrawalResult:
    """Result of withdrawal projection."""

    rows: list[WithdrawalYearRow]
    total_withdrawn: float
    final_balance: float
    depletion_year: Optional[int]  # Year when money runs out
    depletion_age: Optional[int]  # Age when money runs out
    success: bool  # True if money lasted until max_age


class WithdrawalProjection:
    """Year-by-year withdrawal analysis with detailed tables."""

    def __init__(
        self,
        expected_return: float = 0.06,
        inflation_rate: float = 0.03,
    ):
        """Initialize withdrawal projection.

        Args:
            expected_return: Expected annual investment return (default 6%)
            inflation_rate: Expected annual inflation rate (default 3%)
        """
        self.expected_return = expected_return
        self.inflation_rate = inflation_rate

    def project_withdrawals(
        self,
        starting_balance: float,
        withdrawal_rate_or_amount: float,
        is_percentage: bool,
        start_age: int,
        end_age: int = 100,
        adjust_for_inflation: bool = True,
    ) -> WithdrawalResult:
        """Generate year-by-year table of withdrawals.

        Args:
            starting_balance: Initial portfolio balance
            withdrawal_rate_or_amount: Either percentage (e.g., 0.04 for 4%)
                                       or fixed dollar amount (e.g., 50000)
            is_percentage: True if withdrawal_rate_or_amount is a percentage
            start_age: Age when withdrawals begin
            end_age: Maximum age to project (default 100)
            adjust_for_inflation: Whether to increase withdrawals for inflation

        Returns:
            WithdrawalResult with year-by-year breakdown
        """
        rows = []
        cumulative_withdrawn = 0.0
        depletion_year = None
        depletion_age = None

        current_balance = starting_balance
        year_num = 0

        # Calculate initial withdrawal amount
        if is_percentage:
            base_withdrawal = starting_balance * withdrawal_rate_or_amount
        else:
            base_withdrawal = withdrawal_rate_or_amount

        for age in range(start_age, end_age + 1):
            year_num += 1
            beginning_balance = current_balance

            # Calculate this year's withdrawal (inflation-adjusted if enabled)
            if adjust_for_inflation:
                withdrawal = base_withdrawal * (1 + self.inflation_rate) ** (year_num - 1)
            else:
                withdrawal = base_withdrawal

            # Don't withdraw more than we have
            actual_withdrawal = min(withdrawal, max(0, current_balance))

            # Subtract withdrawal
            after_withdrawal = current_balance - actual_withdrawal

            # Calculate investment return on remaining balance
            investment_return = after_withdrawal * self.expected_return

            # Ending balance
            ending_balance = max(0, after_withdrawal + investment_return)

            cumulative_withdrawn += actual_withdrawal

            rows.append(WithdrawalYearRow(
                year=year_num,
                age=age,
                beginning_balance=round(beginning_balance, 2),
                withdrawal_amount=round(actual_withdrawal, 2),
                investment_return=round(investment_return, 2),
                ending_balance=round(ending_balance, 2),
                cumulative_withdrawn=round(cumulative_withdrawn, 2),
            ))

            # Check for depletion
            if ending_balance <= 0 and depletion_year is None:
                depletion_year = year_num
                depletion_age = age

            current_balance = ending_balance

        return WithdrawalResult(
            rows=rows,
            total_withdrawn=round(cumulative_withdrawn, 2),
            final_balance=round(current_balance, 2),
            depletion_year=depletion_year,
            depletion_age=depletion_age,
            success=current_balance > 0,
        )

    def find_safe_withdrawal_rate(
        self,
        starting_balance: float,
        start_age: int,
        end_age: int = 100,
        target_ending_balance: float = 0,
    ) -> float:
        """Find the maximum safe withdrawal rate.

        Args:
            starting_balance: Initial portfolio balance
            start_age: Age when withdrawals begin
            end_age: Maximum age to project
            target_ending_balance: Desired balance at end_age (default 0)

        Returns:
            Maximum safe withdrawal rate as a decimal
        """
        low = 0.01
        high = 0.15
        tolerance = 0.001

        while high - low > tolerance:
            mid = (low + high) / 2
            result = self.project_withdrawals(
                starting_balance=starting_balance,
                withdrawal_rate_or_amount=mid,
                is_percentage=True,
                start_age=start_age,
                end_age=end_age,
            )

            if result.final_balance >= target_ending_balance:
                low = mid
            else:
                high = mid

        return round(low, 4)

    def compare_scenarios(
        self,
        starting_balance: float,
        start_age: int,
        end_age: int = 100,
        withdrawal_rates: Optional[list[float]] = None,
    ) -> dict[str, WithdrawalResult]:
        """Compare multiple withdrawal scenarios.

        Args:
            starting_balance: Initial portfolio balance
            start_age: Age when withdrawals begin
            end_age: Maximum age to project
            withdrawal_rates: List of rates to compare (default: common rates)

        Returns:
            Dict mapping rate description to result
        """
        if withdrawal_rates is None:
            withdrawal_rates = [0.03, 0.035, 0.04, 0.045, 0.05]

        results = {}
        for rate in withdrawal_rates:
            result = self.project_withdrawals(
                starting_balance=starting_balance,
                withdrawal_rate_or_amount=rate,
                is_percentage=True,
                start_age=start_age,
                end_age=end_age,
            )
            results[f"{rate * 100:.1f}%"] = result

        return results
