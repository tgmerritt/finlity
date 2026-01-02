"""
Social Security benefit estimation.

Provides simplified PIA (Primary Insurance Amount) estimation based on
current income as a proxy for AIME (Average Indexed Monthly Earnings).
"""

from dataclasses import dataclass
from typing import Optional
from datetime import date


# 2024 Bend Points for PIA calculation
BEND_POINTS_2024 = {
    "first": 1174,   # 90% of first $1,174 of AIME
    "second": 7078,  # 32% of AIME from $1,174 to $7,078
    # 15% of AIME over $7,078
}

# Full Retirement Age by birth year
FRA_BY_BIRTH_YEAR = {
    1943: (66, 0),   # 66 years
    1944: (66, 0),
    1945: (66, 0),
    1946: (66, 0),
    1947: (66, 0),
    1948: (66, 0),
    1949: (66, 0),
    1950: (66, 0),
    1951: (66, 0),
    1952: (66, 0),
    1953: (66, 0),
    1954: (66, 0),
    1955: (66, 2),   # 66 years, 2 months
    1956: (66, 4),
    1957: (66, 6),
    1958: (66, 8),
    1959: (66, 10),
    1960: (67, 0),   # 67 years for 1960+
}

# Maximum taxable earnings by year (for historical AIME calculation)
MAX_TAXABLE_EARNINGS = {
    2024: 168600,
    2023: 160200,
    2022: 147000,
    2021: 142800,
    2020: 137700,
    2019: 132900,
    2018: 128400,
    2017: 127200,
    2016: 118500,
    2015: 118500,
}


@dataclass
class SocialSecurityEstimate:
    """Social Security benefit estimate details."""

    monthly_benefit_at_fra: float
    monthly_benefit_at_claiming: float
    claiming_age: int
    full_retirement_age: float  # In years (e.g., 66.5)
    early_reduction_percent: float
    delayed_credit_percent: float
    annual_benefit: float

    def to_dict(self) -> dict:
        """Convert to dictionary for API responses."""
        return {
            "monthly_benefit_at_fra": round(self.monthly_benefit_at_fra, 2),
            "monthly_benefit_at_claiming": round(self.monthly_benefit_at_claiming, 2),
            "claiming_age": self.claiming_age,
            "full_retirement_age": round(self.full_retirement_age, 1),
            "early_reduction_percent": round(self.early_reduction_percent, 2),
            "delayed_credit_percent": round(self.delayed_credit_percent, 2),
            "annual_benefit": round(self.annual_benefit, 2),
        }


def get_full_retirement_age(birth_year: int) -> float:
    """
    Get full retirement age for a given birth year.

    Args:
        birth_year: Year of birth

    Returns:
        Full retirement age in years (e.g., 66.5 for 66 years 6 months)
    """
    if birth_year <= 1937:
        return 65.0
    elif birth_year <= 1942:
        # Increases 2 months per year from 65 to 66
        months_over_65 = (birth_year - 1937) * 2
        return 65 + months_over_65 / 12
    elif birth_year <= 1954:
        return 66.0
    elif birth_year <= 1959:
        years, months = FRA_BY_BIRTH_YEAR.get(birth_year, (66, 0))
        return years + months / 12
    else:
        return 67.0


def calculate_pia(
    average_indexed_monthly_earnings: float,
    bend_points: Optional[dict] = None,
) -> float:
    """
    Calculate Primary Insurance Amount (PIA) using bend point formula.

    The PIA formula applies different percentages to different portions of AIME:
    - 90% of the first bend point
    - 32% from first to second bend point
    - 15% above second bend point

    Args:
        average_indexed_monthly_earnings: AIME in dollars
        bend_points: Optional custom bend points dict

    Returns:
        Monthly PIA (before claiming age adjustment)
    """
    bp = bend_points or BEND_POINTS_2024
    aime = average_indexed_monthly_earnings

    if aime <= 0:
        return 0.0

    first = bp["first"]
    second = bp["second"]

    if aime <= first:
        return aime * 0.90
    elif aime <= second:
        return first * 0.90 + (aime - first) * 0.32
    else:
        return first * 0.90 + (second - first) * 0.32 + (aime - second) * 0.15


def adjust_benefit_for_claiming_age(
    pia: float,
    claiming_age: int,
    full_retirement_age: float,
) -> tuple[float, float, float]:
    """
    Adjust PIA for early or delayed claiming.

    Early claiming (before FRA): Reduces benefit
    - First 36 months early: 5/9% per month (6.67% per year)
    - Additional months: 5/12% per month (5% per year)

    Delayed claiming (after FRA until 70): Increases benefit
    - 8% per year (2/3% per month) for those born 1943+

    Args:
        pia: Primary Insurance Amount at FRA
        claiming_age: Age at which benefits will be claimed
        full_retirement_age: Full retirement age in years

    Returns:
        Tuple of (adjusted_benefit, early_reduction_pct, delayed_credit_pct)
    """
    fra_months = int(full_retirement_age * 12)
    claiming_months = claiming_age * 12

    months_diff = claiming_months - fra_months

    if months_diff < 0:
        # Early claiming - reduce benefit
        months_early = abs(months_diff)

        # First 36 months: 5/9% per month
        first_36_reduction = min(months_early, 36) * (5 / 9 / 100)

        # Additional months: 5/12% per month
        additional_reduction = max(0, months_early - 36) * (5 / 12 / 100)

        total_reduction = first_36_reduction + additional_reduction
        adjusted = pia * (1 - total_reduction)

        return adjusted, total_reduction * 100, 0.0

    elif months_diff > 0 and claiming_age <= 70:
        # Delayed claiming - increase benefit (max until age 70)
        months_delayed = min(months_diff, (70 * 12) - fra_months)

        # 2/3% per month = 8% per year
        delayed_credit = months_delayed * (2 / 3 / 100)
        adjusted = pia * (1 + delayed_credit)

        return adjusted, 0.0, delayed_credit * 100

    else:
        # Claiming at FRA or after 70 (no additional credits after 70)
        return pia, 0.0, 0.0


def estimate_social_security_benefit(
    annual_income: float,
    current_age: int,
    claiming_age: int = 67,
    birth_year: Optional[int] = None,
    years_of_work: int = 35,
) -> SocialSecurityEstimate:
    """
    Estimate Social Security benefits based on current income.

    This is a simplified estimation that uses current income as a proxy
    for career-average earnings. For more accurate estimates, users should
    use the official SSA calculator at ssa.gov.

    Args:
        annual_income: Current annual gross income
        current_age: Current age
        claiming_age: Age at which to claim benefits (62-70)
        birth_year: Year of birth (calculated from current_age if not provided)
        years_of_work: Years of work history (affects averaging)

    Returns:
        SocialSecurityEstimate with benefit details
    """
    # Calculate birth year if not provided
    if birth_year is None:
        current_year = date.today().year
        birth_year = current_year - current_age

    # Get full retirement age
    fra = get_full_retirement_age(birth_year)

    # Estimate AIME from current income
    # SSA averages highest 35 years of indexed earnings
    # We use current income as a simplified proxy

    # Cap at Social Security taxable maximum
    ss_max = MAX_TAXABLE_EARNINGS.get(2024, 168600)
    capped_annual = min(annual_income, ss_max)
    aime = capped_annual / 12

    # Calculate PIA (benefit at full retirement age)
    pia = calculate_pia(aime)

    # Adjust for claiming age
    adjusted_benefit, early_reduction, delayed_credit = adjust_benefit_for_claiming_age(
        pia, claiming_age, fra
    )

    return SocialSecurityEstimate(
        monthly_benefit_at_fra=pia,
        monthly_benefit_at_claiming=adjusted_benefit,
        claiming_age=claiming_age,
        full_retirement_age=fra,
        early_reduction_percent=early_reduction,
        delayed_credit_percent=delayed_credit,
        annual_benefit=adjusted_benefit * 12,
    )


def calculate_breakeven_age(
    pia: float,
    full_retirement_age: float,
    early_claiming_age: int = 62,
    late_claiming_age: int = 70,
) -> Optional[int]:
    """
    Calculate the breakeven age for delayed claiming.

    This is the age at which the total cumulative benefits from delayed
    claiming exceed the cumulative benefits from early claiming.

    Args:
        pia: Primary Insurance Amount at FRA
        full_retirement_age: Full retirement age in years
        early_claiming_age: Earlier claiming age to compare
        late_claiming_age: Later claiming age to compare

    Returns:
        Breakeven age in years, or None if delayed never catches up
    """
    early_benefit, _, _ = adjust_benefit_for_claiming_age(
        pia, early_claiming_age, full_retirement_age
    )
    late_benefit, _, _ = adjust_benefit_for_claiming_age(
        pia, late_claiming_age, full_retirement_age
    )

    # Calculate annual benefits
    early_annual = early_benefit * 12
    late_annual = late_benefit * 12

    # Years of extra payments with early claiming
    years_diff = late_claiming_age - early_claiming_age

    # Cumulative early benefits by the time late claiming starts
    early_head_start = early_annual * years_diff

    # Annual advantage of late claiming
    annual_advantage = late_annual - early_annual

    if annual_advantage <= 0:
        return None  # Early claiming is always better (shouldn't happen normally)

    # Years after late claiming starts to break even
    years_to_breakeven = early_head_start / annual_advantage

    breakeven_age = late_claiming_age + int(years_to_breakeven)

    return breakeven_age if breakeven_age < 120 else None


def get_claiming_age_comparison(
    annual_income: float,
    current_age: int,
    birth_year: Optional[int] = None,
) -> list[dict]:
    """
    Compare benefits at different claiming ages.

    Args:
        annual_income: Current annual gross income
        current_age: Current age
        birth_year: Year of birth

    Returns:
        List of benefit estimates for ages 62-70
    """
    results = []

    for claiming_age in range(62, 71):
        estimate = estimate_social_security_benefit(
            annual_income=annual_income,
            current_age=current_age,
            claiming_age=claiming_age,
            birth_year=birth_year,
        )
        results.append({
            "claiming_age": claiming_age,
            "monthly_benefit": round(estimate.monthly_benefit_at_claiming, 2),
            "annual_benefit": round(estimate.annual_benefit, 2),
            "percent_of_fra": round(
                (estimate.monthly_benefit_at_claiming / estimate.monthly_benefit_at_fra) * 100, 1
            ) if estimate.monthly_benefit_at_fra > 0 else 0,
        })

    return results
