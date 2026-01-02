"""
Payroll tax calculator with federal progressive brackets and FICA taxes.

Supports:
- Federal income tax with 2024/2025 progressive brackets
- Social Security tax (6.2% up to wage base)
- Medicare tax (1.45% + 0.9% additional over threshold)
- State income tax integration
"""

from dataclasses import dataclass
from typing import Optional
from .state_taxes import calculate_state_tax


# 2024 Federal Income Tax Brackets
FEDERAL_BRACKETS_2024 = {
    "single": [
        (11600, 0.10),
        (47150, 0.12),
        (100525, 0.22),
        (191950, 0.24),
        (243725, 0.32),
        (609350, 0.35),
        (float('inf'), 0.37),
    ],
    "married_joint": [
        (23200, 0.10),
        (94300, 0.12),
        (201050, 0.22),
        (383900, 0.24),
        (487450, 0.32),
        (731200, 0.35),
        (float('inf'), 0.37),
    ],
    "married_separate": [
        (11600, 0.10),
        (47150, 0.12),
        (100525, 0.22),
        (191950, 0.24),
        (243725, 0.32),
        (365600, 0.35),
        (float('inf'), 0.37),
    ],
    "head_household": [
        (16550, 0.10),
        (63100, 0.12),
        (100500, 0.22),
        (191950, 0.24),
        (243700, 0.32),
        (609350, 0.35),
        (float('inf'), 0.37),
    ],
}

# 2025 Federal Income Tax Brackets (inflation-adjusted estimates)
FEDERAL_BRACKETS_2025 = {
    "single": [
        (11925, 0.10),
        (48475, 0.12),
        (103350, 0.22),
        (197300, 0.24),
        (250525, 0.32),
        (626350, 0.35),
        (float('inf'), 0.37),
    ],
    "married_joint": [
        (23850, 0.10),
        (96950, 0.12),
        (206700, 0.22),
        (394600, 0.24),
        (501050, 0.32),
        (751600, 0.35),
        (float('inf'), 0.37),
    ],
    "married_separate": [
        (11925, 0.10),
        (48475, 0.12),
        (103350, 0.22),
        (197300, 0.24),
        (250525, 0.32),
        (375800, 0.35),
        (float('inf'), 0.37),
    ],
    "head_household": [
        (17000, 0.10),
        (64850, 0.12),
        (103350, 0.22),
        (197300, 0.24),
        (250500, 0.32),
        (626350, 0.35),
        (float('inf'), 0.37),
    ],
}

# Standard deductions by year and filing status
STANDARD_DEDUCTION = {
    2024: {
        "single": 14600,
        "married_joint": 29200,
        "married_separate": 14600,
        "head_household": 21900,
    },
    2025: {
        "single": 15000,
        "married_joint": 30000,
        "married_separate": 15000,
        "head_household": 22500,
    },
}

# FICA rates and limits
FICA_RATES = {
    2024: {
        "social_security_rate": 0.062,
        "social_security_wage_base": 168600,
        "medicare_rate": 0.0145,
        "additional_medicare_rate": 0.009,
        "additional_medicare_threshold_single": 200000,
        "additional_medicare_threshold_married": 250000,
    },
    2025: {
        "social_security_rate": 0.062,
        "social_security_wage_base": 176100,  # Estimated
        "medicare_rate": 0.0145,
        "additional_medicare_rate": 0.009,
        "additional_medicare_threshold_single": 200000,
        "additional_medicare_threshold_married": 250000,
    },
}

# Pay frequency to periods per year
PAY_FREQUENCIES = {
    "weekly": 52,
    "biweekly": 26,
    "semimonthly": 24,
    "monthly": 12,
    "annual": 1,
}


@dataclass
class PaycheckBreakdown:
    """Breakdown of a single paycheck's taxes and deductions."""

    gross: float

    # Federal taxes
    federal_income_tax: float
    social_security: float
    medicare: float
    additional_medicare: float

    # State taxes
    state_income_tax: float
    local_tax: float = 0.0

    # Pre-tax deductions
    pretax_401k: float = 0.0
    pretax_hsa: float = 0.0
    pretax_fsa: float = 0.0
    pretax_other: float = 0.0

    # Post-tax deductions
    post_tax_roth_401k: float = 0.0

    @property
    def total_fica(self) -> float:
        """Total FICA taxes (Social Security + Medicare)."""
        return self.social_security + self.medicare + self.additional_medicare

    @property
    def total_taxes(self) -> float:
        """Total taxes withheld."""
        return (
            self.federal_income_tax
            + self.total_fica
            + self.state_income_tax
            + self.local_tax
        )

    @property
    def total_pretax_deductions(self) -> float:
        """Total pre-tax deductions."""
        return self.pretax_401k + self.pretax_hsa + self.pretax_fsa + self.pretax_other

    @property
    def taxable_income(self) -> float:
        """Gross minus pre-tax deductions (for tax calculation purposes)."""
        return self.gross - self.total_pretax_deductions

    @property
    def net_pay(self) -> float:
        """Net pay after all taxes and deductions."""
        return (
            self.gross
            - self.total_taxes
            - self.total_pretax_deductions
            - self.post_tax_roth_401k
        )

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "gross": round(self.gross, 2),
            "federal_income_tax": round(self.federal_income_tax, 2),
            "social_security": round(self.social_security, 2),
            "medicare": round(self.medicare, 2),
            "additional_medicare": round(self.additional_medicare, 2),
            "state_income_tax": round(self.state_income_tax, 2),
            "local_tax": round(self.local_tax, 2),
            "total_fica": round(self.total_fica, 2),
            "total_taxes": round(self.total_taxes, 2),
            "pretax_401k": round(self.pretax_401k, 2),
            "pretax_hsa": round(self.pretax_hsa, 2),
            "pretax_fsa": round(self.pretax_fsa, 2),
            "pretax_other": round(self.pretax_other, 2),
            "total_pretax_deductions": round(self.total_pretax_deductions, 2),
            "post_tax_roth_401k": round(self.post_tax_roth_401k, 2),
            "net_pay": round(self.net_pay, 2),
        }


class PayrollTaxCalculator:
    """
    Calculate payroll taxes for employment income.

    Supports federal income tax with progressive brackets, FICA taxes
    (Social Security and Medicare), and state income tax integration.
    """

    def __init__(
        self,
        filing_status: str = "single",
        state: str = "CA",
        tax_year: int = 2024,
    ):
        """
        Initialize the calculator.

        Args:
            filing_status: One of 'single', 'married_joint', 'married_separate', 'head_household'
            state: Two-letter state code (e.g., 'CA', 'NY', 'TX')
            tax_year: Tax year for bracket lookup (2024 or 2025)
        """
        self.filing_status = filing_status.lower().replace(" ", "_")
        self.state = state.upper()
        self.tax_year = tax_year

        # Get appropriate brackets and rates
        if tax_year >= 2025:
            self.brackets = FEDERAL_BRACKETS_2025.get(
                self.filing_status, FEDERAL_BRACKETS_2025["single"]
            )
            self.standard_deduction = STANDARD_DEDUCTION[2025].get(
                self.filing_status, STANDARD_DEDUCTION[2025]["single"]
            )
            self.fica = FICA_RATES[2025]
        else:
            self.brackets = FEDERAL_BRACKETS_2024.get(
                self.filing_status, FEDERAL_BRACKETS_2024["single"]
            )
            self.standard_deduction = STANDARD_DEDUCTION[2024].get(
                self.filing_status, STANDARD_DEDUCTION[2024]["single"]
            )
            self.fica = FICA_RATES[2024]

    def calculate_federal_income_tax(
        self,
        annual_gross: float,
        pretax_deductions: float = 0,
        use_standard_deduction: bool = True,
        itemized_deduction: float = 0,
    ) -> float:
        """
        Calculate federal income tax using progressive brackets.

        Args:
            annual_gross: Annual gross income
            pretax_deductions: Pre-tax deductions (401k, HSA, etc.)
            use_standard_deduction: Whether to use standard deduction
            itemized_deduction: Itemized deduction amount if not using standard

        Returns:
            Annual federal income tax
        """
        # Calculate taxable income
        deduction = self.standard_deduction if use_standard_deduction else itemized_deduction
        taxable_income = max(0, annual_gross - pretax_deductions - deduction)

        if taxable_income <= 0:
            return 0.0

        # Apply progressive brackets
        tax = 0.0
        prev_bracket = 0

        for bracket_max, rate in self.brackets:
            if taxable_income <= prev_bracket:
                break

            taxable_in_bracket = min(taxable_income, bracket_max) - prev_bracket
            tax += taxable_in_bracket * rate
            prev_bracket = bracket_max

        return tax

    def calculate_fica(
        self,
        annual_gross: float,
        ytd_gross: float = 0,
    ) -> tuple[float, float, float]:
        """
        Calculate FICA taxes (Social Security and Medicare).

        Args:
            annual_gross: Annual gross income
            ytd_gross: Year-to-date gross income (for wage base tracking)

        Returns:
            Tuple of (social_security, medicare, additional_medicare)
        """
        # Social Security (capped at wage base)
        wage_base = self.fica["social_security_wage_base"]
        remaining_base = max(0, wage_base - ytd_gross)
        ss_taxable = min(annual_gross, remaining_base)
        social_security = ss_taxable * self.fica["social_security_rate"]

        # Medicare (no cap)
        medicare = annual_gross * self.fica["medicare_rate"]

        # Additional Medicare (over threshold)
        if "married" in self.filing_status:
            threshold = self.fica["additional_medicare_threshold_married"]
        else:
            threshold = self.fica["additional_medicare_threshold_single"]

        total_income = ytd_gross + annual_gross
        additional_medicare = 0.0
        if total_income > threshold:
            # Calculate additional Medicare on income over threshold
            excess = total_income - threshold
            # Only tax the portion of this income that's over threshold
            taxable_excess = min(annual_gross, excess)
            additional_medicare = taxable_excess * self.fica["additional_medicare_rate"]

        return social_security, medicare, additional_medicare

    def calculate_state_tax(
        self,
        annual_gross: float,
        pretax_deductions: float = 0,
    ) -> float:
        """
        Calculate state income tax.

        Args:
            annual_gross: Annual gross income
            pretax_deductions: Pre-tax deductions

        Returns:
            Annual state income tax
        """
        taxable = annual_gross - pretax_deductions
        return calculate_state_tax(taxable, self.state, self.filing_status)

    def calculate_paycheck(
        self,
        gross_per_period: float,
        pay_frequency: str = "biweekly",
        pretax_deductions: Optional[dict] = None,
        ytd_gross: float = 0,
    ) -> PaycheckBreakdown:
        """
        Calculate a single paycheck's tax breakdown.

        Args:
            gross_per_period: Gross pay for this pay period
            pay_frequency: One of 'weekly', 'biweekly', 'semimonthly', 'monthly', 'annual'
            pretax_deductions: Dict with keys '401k', 'hsa', 'fsa', 'other', 'roth_401k'
            ytd_gross: Year-to-date gross income for wage base tracking

        Returns:
            PaycheckBreakdown with all tax and deduction details
        """
        periods_per_year = PAY_FREQUENCIES.get(pay_frequency.lower(), 26)
        annual_gross = gross_per_period * periods_per_year

        # Handle pre-tax deductions
        deductions = pretax_deductions or {}
        pretax_401k = deductions.get("401k", 0)
        pretax_hsa = deductions.get("hsa", 0)
        pretax_fsa = deductions.get("fsa", 0)
        pretax_other = deductions.get("other", 0)
        roth_401k = deductions.get("roth_401k", 0)

        total_pretax = pretax_401k + pretax_hsa + pretax_fsa + pretax_other
        annual_pretax = total_pretax * periods_per_year

        # Calculate annual taxes
        annual_federal = self.calculate_federal_income_tax(
            annual_gross, pretax_deductions=annual_pretax
        )
        ss, medicare, add_medicare = self.calculate_fica(annual_gross, ytd_gross)
        annual_state = self.calculate_state_tax(annual_gross, annual_pretax)

        # Convert to per-period amounts
        return PaycheckBreakdown(
            gross=gross_per_period,
            federal_income_tax=annual_federal / periods_per_year,
            social_security=ss / periods_per_year,
            medicare=medicare / periods_per_year,
            additional_medicare=add_medicare / periods_per_year,
            state_income_tax=annual_state / periods_per_year,
            local_tax=0.0,  # TODO: Add local tax support
            pretax_401k=pretax_401k,
            pretax_hsa=pretax_hsa,
            pretax_fsa=pretax_fsa,
            pretax_other=pretax_other,
            post_tax_roth_401k=roth_401k,
        )

    def calculate_annual_summary(
        self,
        annual_gross: float,
        pretax_deductions: Optional[dict] = None,
    ) -> dict:
        """
        Calculate annual tax summary.

        Args:
            annual_gross: Annual gross income
            pretax_deductions: Annual pre-tax deductions

        Returns:
            Dictionary with annual tax breakdown
        """
        deductions = pretax_deductions or {}
        total_pretax = sum(deductions.values())

        federal = self.calculate_federal_income_tax(annual_gross, total_pretax)
        ss, medicare, add_medicare = self.calculate_fica(annual_gross)
        state = self.calculate_state_tax(annual_gross, total_pretax)

        total_fica = ss + medicare + add_medicare
        total_taxes = federal + total_fica + state
        net_income = annual_gross - total_taxes - total_pretax

        return {
            "gross_income": round(annual_gross, 2),
            "federal_income_tax": round(federal, 2),
            "social_security": round(ss, 2),
            "medicare": round(medicare, 2),
            "additional_medicare": round(add_medicare, 2),
            "total_fica": round(total_fica, 2),
            "state_income_tax": round(state, 2),
            "total_taxes": round(total_taxes, 2),
            "pretax_deductions": round(total_pretax, 2),
            "net_income": round(net_income, 2),
            "effective_tax_rate": round((total_taxes / annual_gross) * 100, 2) if annual_gross > 0 else 0,
            "marginal_tax_rate": self._get_marginal_rate(annual_gross - total_pretax - self.standard_deduction),
        }

    def _get_marginal_rate(self, taxable_income: float) -> float:
        """Get the marginal federal tax rate for a given taxable income."""
        if taxable_income <= 0:
            return 0.0

        for bracket_max, rate in self.brackets:
            if taxable_income <= bracket_max:
                return rate * 100

        return self.brackets[-1][1] * 100  # Top bracket
