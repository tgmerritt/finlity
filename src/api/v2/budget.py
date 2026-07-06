"""Stateless v2 budget endpoints.

v1's calculate-paycheck and social-security handlers are already pure (no
DB access) — v2 delegates to the same calculator functions directly.
calculate-annual and paycheck-chart-data call the pure functions extracted
from v1 (src/api/budget.py: compute_annual_summary, compute_paycheck_chart_data)
over payload-supplied arrays instead of DB-queried ORM rows.
"""

from typing import Optional

from fastapi import APIRouter
from pydantic import BaseModel

from src.api.budget import (
    PaycheckRequest,
    SocialSecurityRequest,
    compute_annual_summary,
    compute_paycheck_chart_data,
)
from src.api.v2.payload import IncomeSourcePayload, ExpensePayload, DeductionPayload, TaxConfigPayload
from src.budget.tax_calculator import PayrollTaxCalculator
from src.budget.social_security import estimate_social_security_benefit, get_claiming_age_comparison

router = APIRouter(prefix="/api/v2/budget", tags=["v2-budget"])


@router.post("/calculate-paycheck")
async def calculate_paycheck(data: PaycheckRequest) -> dict:
    """Single paycheck tax breakdown. Identical to v1 — already pure, no DB."""
    calculator = PayrollTaxCalculator(
        filing_status=data.filing_status,
        state=data.state,
        tax_year=2024,
    )

    pretax_deductions = {
        "401k": data.pretax_401k,
        "hsa": data.pretax_hsa,
        "fsa": data.pretax_fsa,
        "other": data.pretax_other,
        "roth_401k": data.roth_401k,
    }

    breakdown = calculator.calculate_paycheck(
        gross_per_period=data.gross_per_period,
        pay_frequency=data.pay_frequency,
        pretax_deductions=pretax_deductions,
    )

    return breakdown.to_dict()


@router.post("/social-security")
async def calculate_social_security(data: SocialSecurityRequest) -> dict:
    """Social Security estimate. Identical to v1 — already pure, no DB."""
    estimate = estimate_social_security_benefit(
        annual_income=data.annual_income,
        current_age=data.current_age,
        claiming_age=data.claiming_age,
        birth_year=data.birth_year,
    )

    comparison = get_claiming_age_comparison(
        annual_income=data.annual_income,
        current_age=data.current_age,
        birth_year=data.birth_year,
    )

    return {
        "estimate": estimate.to_dict(),
        "comparison_by_age": comparison,
    }


class CalculateAnnualRequest(BaseModel):
    income_sources: list[IncomeSourcePayload]
    expenses: list[ExpensePayload]
    deductions: list[DeductionPayload]
    filing_status: str = "single"
    tax_year: int = 2024


@router.post("/calculate-annual")
async def calculate_annual_summary(data: CalculateAnnualRequest) -> dict:
    """Annual budget summary from payload-supplied income/expenses/deductions."""
    active_income = [s for s in data.income_sources if s.is_active]
    active_expenses = [e for e in data.expenses if e.is_active]

    return compute_annual_summary(
        income_sources=active_income,
        expenses=active_expenses,
        deductions=data.deductions,
        filing_status=data.filing_status,
        tax_year=data.tax_year,
    )


class IncomeTransitionRequestV2(BaseModel):
    current_age: int
    retirement_age: int
    ss_claiming_age: int = 67
    end_age: int = 95
    ss_benefit_override: Optional[float] = None
    income_sources: list[IncomeSourcePayload]
    expenses: list[ExpensePayload]


@router.post("/income-transition")
async def get_income_transition(data: IncomeTransitionRequestV2) -> dict:
    """Retirement income transition projection from payload income/expenses.

    Ports v1's src/api/budget.py:get_income_transition body over
    payload-supplied sources/expenses instead of DB-queried ones.
    """
    sources = [s for s in data.income_sources if s.is_active]
    total_annual_income: float = float(sum(s.gross_annual for s in sources))

    expenses = [e for e in data.expenses if e.is_active]
    freq_to_annual = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "annual": 1}
    annual_expenses: float = float(sum(
        e.amount * freq_to_annual.get(e.frequency, 12)
        for e in expenses
    ))

    ss_estimate = estimate_social_security_benefit(
        annual_income=total_annual_income,
        current_age=data.current_age,
        claiming_age=data.ss_claiming_age,
    )

    monthly_ss = data.ss_benefit_override if data.ss_benefit_override else ss_estimate.monthly_benefit_at_claiming
    annual_ss = monthly_ss * 12

    years = []
    inflation_rate = 0.025

    for age in range(data.current_age, data.end_age + 1):
        years_from_now = age - data.current_age
        inflation_factor = (1 + inflation_rate) ** years_from_now

        employment_income: float
        ss_income: float
        withdrawal_needed: float
        if age < data.retirement_age:
            employment_income = total_annual_income * inflation_factor
            ss_income = 0.0
            withdrawal_needed = 0.0
        else:
            employment_income = 0.0
            if age >= data.ss_claiming_age:
                ss_income = annual_ss * inflation_factor
            else:
                ss_income = 0.0
            target_spending = annual_expenses * inflation_factor
            withdrawal_needed = max(0.0, target_spending - ss_income)

        total_income = employment_income + ss_income + withdrawal_needed

        years.append({
            "age": age,
            "employment_income": round(employment_income, 2),
            "ss_income": round(ss_income, 2),
            "withdrawal_needed": round(withdrawal_needed, 2),
            "total_income": round(total_income, 2),
            "is_retired": age >= data.retirement_age,
            "receiving_ss": age >= data.ss_claiming_age,
        })

    ss_comparison = get_claiming_age_comparison(
        annual_income=total_annual_income,
        current_age=data.current_age,
    )

    return {
        "years": years,
        "ss_comparison": ss_comparison,
        "assumptions": {
            "current_income": round(total_annual_income, 2),
            "annual_expenses": round(annual_expenses, 2),
            "estimated_ss_monthly": round(monthly_ss, 2),
            "inflation_rate": inflation_rate,
        }
    }


class PaycheckChartDataRequest(BaseModel):
    income_sources: list[IncomeSourcePayload]
    deductions: list[DeductionPayload]
    expenses: list[ExpensePayload]
    tax_config: Optional[TaxConfigPayload] = None


class _SourceLike:
    """Adapts an IncomeSourcePayload to attribute access compute_paycheck_chart_data expects."""

    def __init__(self, s: IncomeSourcePayload):
        self.id = s.id
        self.gross_annual = s.gross_annual
        self.pay_frequency = s.pay_frequency
        self.state = s.state


@router.post("/paycheck-chart-data")
async def get_paycheck_chart_data(data: PaycheckChartDataRequest) -> dict:
    """Cumulative YTD paycheck chart data from payload income/deductions/expenses."""
    active_sources = [s for s in data.income_sources if s.is_active]
    if not active_sources:
        return {"periods": [], "data": []}

    source = _SourceLike(active_sources[0])

    deductions = [d for d in data.deductions if d.income_source_id == source.id]
    expenses = [e for e in data.expenses if e.is_active and not e.is_pretax]

    filing_status = data.tax_config.filing_status if data.tax_config else "single"
    state = data.tax_config.state if data.tax_config else "CA"

    return compute_paycheck_chart_data(
        source=source,
        deductions=deductions,
        expenses=expenses,
        filing_status=filing_status,
        state=state,
    )
