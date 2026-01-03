"""
Budget API endpoints for income and expense tracking.

Provides endpoints for:
- Income source management (CRUD)
- Expense management (CRUD)
- Tax configuration
- Paycheck calculations
- Annual budget summary
- Income transition projections
"""

from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import joinedload

from src.database import get_database
from src.database.models import (
    BudgetIncomeSource,
    BudgetTaxConfig,
    BudgetExpenseCategory,
    BudgetExpense,
    BudgetPretaxDeduction,
)
from src.budget.tax_calculator import PayrollTaxCalculator, PAY_FREQUENCIES
from src.budget.state_taxes import get_all_states
from src.budget.social_security import (
    estimate_social_security_benefit,
    get_claiming_age_comparison,
)
from src.budget.models import DEFAULT_EXPENSE_CATEGORIES

router = APIRouter(prefix="/api/budget", tags=["budget"])


# =============================================================================
# Request/Response Models
# =============================================================================


class IncomeSourceCreate(BaseModel):
    """Request model for creating an income source."""
    name: str
    income_type: str = "employment"
    gross_annual: float
    pay_frequency: str = "biweekly"
    state: str = "CA"
    is_active: bool = True


class IncomeSourceUpdate(BaseModel):
    """Request model for updating an income source."""
    name: Optional[str] = None
    income_type: Optional[str] = None
    gross_annual: Optional[float] = None
    pay_frequency: Optional[str] = None
    state: Optional[str] = None
    is_active: Optional[bool] = None


class TaxConfigUpdate(BaseModel):
    """Request model for updating tax configuration."""
    tax_year: Optional[int] = None
    filing_status: Optional[str] = None
    state: Optional[str] = None
    ss_benefit_override: Optional[float] = None
    additional_withholding: Optional[float] = None
    itemized_deduction: Optional[float] = None


class ExpenseCreate(BaseModel):
    """Request model for creating an expense."""
    category_id: str
    name: str
    amount: float
    frequency: str = "monthly"
    is_pretax: bool = False
    is_mortgage: bool = False
    principal_portion: Optional[float] = None
    interest_portion: Optional[float] = None
    is_active: bool = True


class ExpenseUpdate(BaseModel):
    """Request model for updating an expense."""
    category_id: Optional[str] = None
    name: Optional[str] = None
    amount: Optional[float] = None
    frequency: Optional[str] = None
    is_pretax: Optional[bool] = None
    is_mortgage: Optional[bool] = None
    principal_portion: Optional[float] = None
    interest_portion: Optional[float] = None
    is_active: Optional[bool] = None


class DeductionCreate(BaseModel):
    """Request model for creating a pre-tax deduction."""
    income_source_id: Optional[str] = None
    label: Optional[str] = None  # User-friendly label (e.g., "John's 401k")
    deduction_type: str = "401k"
    amount_per_period: float
    employer_match: float = 0
    is_percentage: bool = False
    max_annual: Optional[float] = None


class DeductionUpdate(BaseModel):
    """Request model for updating a pre-tax deduction."""
    income_source_id: Optional[str] = None
    label: Optional[str] = None
    deduction_type: Optional[str] = None
    amount_per_period: Optional[float] = None
    employer_match: Optional[float] = None
    is_percentage: Optional[bool] = None
    max_annual: Optional[float] = None


class PaycheckRequest(BaseModel):
    """Request model for paycheck calculation."""
    gross_per_period: float
    pay_frequency: str = "biweekly"
    filing_status: str = "single"
    state: str = "CA"
    pretax_401k: float = 0
    pretax_hsa: float = 0
    pretax_fsa: float = 0
    pretax_other: float = 0
    roth_401k: float = 0


class AnnualSummaryRequest(BaseModel):
    """Request model for annual summary calculation."""
    filing_status: str = "single"
    state: str = "CA"
    tax_year: int = 2024


class SocialSecurityRequest(BaseModel):
    """Request model for Social Security estimation."""
    annual_income: float
    current_age: int
    claiming_age: int = 67
    birth_year: Optional[int] = None


class IncomeTransitionRequest(BaseModel):
    """Request model for retirement income transition projection."""
    current_age: int
    retirement_age: int
    ss_claiming_age: int = 67
    end_age: int = 95
    ss_benefit_override: Optional[float] = None


# =============================================================================
# Income Source Endpoints
# =============================================================================


@router.get("/income")
async def list_income_sources():
    """List all income sources."""
    db = get_database()
    session = db.get_session()
    try:
        sources = session.query(BudgetIncomeSource).filter(
            BudgetIncomeSource.is_active.is_(True)
        ).order_by(BudgetIncomeSource.name).all()

        return [
            {
                "id": s.id,
                "name": s.name,
                "income_type": s.income_type,
                "gross_annual": s.gross_annual,
                "pay_frequency": s.pay_frequency,
                "state": s.state,
                "is_active": s.is_active,
                "gross_per_period": s.gross_annual / PAY_FREQUENCIES.get(s.pay_frequency, 26),
            }
            for s in sources
        ]
    finally:
        session.close()


@router.post("/income")
async def create_income_source(data: IncomeSourceCreate):
    """Create a new income source."""
    db = get_database()
    session = db.get_session()
    try:
        source = BudgetIncomeSource(
            name=data.name,
            income_type=data.income_type,
            gross_annual=data.gross_annual,
            pay_frequency=data.pay_frequency,
            state=data.state,
            is_active=data.is_active,
        )
        session.add(source)
        session.commit()

        return {
            "id": source.id,
            "name": source.name,
            "income_type": source.income_type,
            "gross_annual": source.gross_annual,
            "pay_frequency": source.pay_frequency,
            "state": source.state,
            "is_active": source.is_active,
        }
    finally:
        session.close()


@router.put("/income/{income_id}")
async def update_income_source(income_id: str, data: IncomeSourceUpdate):
    """Update an income source."""
    db = get_database()
    session = db.get_session()
    try:
        source = session.query(BudgetIncomeSource).filter(
            BudgetIncomeSource.id == income_id
        ).first()

        if not source:
            raise HTTPException(status_code=404, detail="Income source not found")

        if data.name is not None:
            source.name = data.name
        if data.income_type is not None:
            source.income_type = data.income_type
        if data.gross_annual is not None:
            source.gross_annual = data.gross_annual
        if data.pay_frequency is not None:
            source.pay_frequency = data.pay_frequency
        if data.state is not None:
            source.state = data.state
        if data.is_active is not None:
            source.is_active = data.is_active

        session.commit()

        return {"updated": True, "id": income_id}
    finally:
        session.close()


@router.delete("/income/{income_id}")
async def delete_income_source(income_id: str):
    """Delete an income source."""
    db = get_database()
    session = db.get_session()
    try:
        source = session.query(BudgetIncomeSource).filter(
            BudgetIncomeSource.id == income_id
        ).first()

        if not source:
            raise HTTPException(status_code=404, detail="Income source not found")

        session.delete(source)
        session.commit()

        return {"deleted": True, "id": income_id}
    finally:
        session.close()


# =============================================================================
# Tax Configuration Endpoints
# =============================================================================


@router.get("/tax-config")
async def get_tax_config():
    """Get current tax configuration."""
    db = get_database()
    session = db.get_session()
    try:
        config = session.query(BudgetTaxConfig).first()

        if not config:
            # Return defaults if no config exists
            return {
                "id": None,
                "tax_year": 2024,
                "filing_status": "single",
                "state": "CA",
                "ss_benefit_override": None,
                "additional_withholding": 0,
                "itemized_deduction": None,
                "use_standard_deduction": True,
            }

        return {
            "id": config.id,
            "tax_year": int(config.tax_year),
            "filing_status": config.filing_status,
            "state": config.state,
            "ss_benefit_override": config.ss_benefit_override,
            "additional_withholding": config.additional_withholding,
            "itemized_deduction": config.itemized_deduction,
            "use_standard_deduction": config.itemized_deduction is None,
        }
    finally:
        session.close()


@router.put("/tax-config")
async def update_tax_config(data: TaxConfigUpdate):
    """Update tax configuration."""
    db = get_database()
    session = db.get_session()
    try:
        config = session.query(BudgetTaxConfig).first()

        if not config:
            # Create new config
            config = BudgetTaxConfig(
                tax_year=data.tax_year or 2024,
                filing_status=data.filing_status or "single",
                state=data.state or "CA",
                ss_benefit_override=data.ss_benefit_override,
                additional_withholding=data.additional_withholding or 0,
                itemized_deduction=data.itemized_deduction,
            )
            session.add(config)
        else:
            if data.tax_year is not None:
                config.tax_year = data.tax_year
            if data.filing_status is not None:
                config.filing_status = data.filing_status
            if data.state is not None:
                config.state = data.state
            if data.ss_benefit_override is not None:
                config.ss_benefit_override = data.ss_benefit_override
            if data.additional_withholding is not None:
                config.additional_withholding = data.additional_withholding
            # Allow setting itemized_deduction to None
            if "itemized_deduction" in data.model_dump(exclude_unset=True):
                config.itemized_deduction = data.itemized_deduction

        session.commit()

        return {"updated": True}
    finally:
        session.close()


@router.get("/states")
async def list_states():
    """Get list of all states with tax info."""
    return get_all_states()


# =============================================================================
# Expense Category Endpoints
# =============================================================================


@router.get("/expense-categories")
async def list_expense_categories():
    """List all expense categories."""
    db = get_database()
    session = db.get_session()
    try:
        categories = session.query(BudgetExpenseCategory).order_by(
            BudgetExpenseCategory.sort_order
        ).all()

        if not categories:
            # Seed default categories if none exist
            for cat in DEFAULT_EXPENSE_CATEGORIES:
                db_cat = BudgetExpenseCategory(
                    name=cat.name,
                    icon=cat.icon,
                    color=cat.color,
                    sort_order=cat.sort_order,
                )
                session.add(db_cat)
            session.commit()

            categories = session.query(BudgetExpenseCategory).order_by(
                BudgetExpenseCategory.sort_order
            ).all()

        return [
            {
                "id": c.id,
                "name": c.name,
                "icon": c.icon,
                "color": c.color,
                "sort_order": c.sort_order,
            }
            for c in categories
        ]
    finally:
        session.close()


# =============================================================================
# Expense Endpoints
# =============================================================================


@router.get("/expenses")
async def list_expenses():
    """List all expenses."""
    db = get_database()
    session = db.get_session()
    try:
        # Eagerly load category relationship to avoid lazy loading issues
        expenses = session.query(BudgetExpense).options(
            joinedload(BudgetExpense.category)
        ).filter(
            BudgetExpense.is_active.is_(True)
        ).all()

        # Frequency to annual multiplier
        freq_multiplier = {
            "weekly": 52,
            "biweekly": 26,
            "monthly": 12,
            "quarterly": 4,
            "annual": 1,
            "one_time": 0,
        }

        result = []
        for e in expenses:
            mult = freq_multiplier.get(e.frequency, 12)
            annual = e.amount * mult if mult > 0 else e.amount

            result.append({
                "id": e.id,
                "category_id": e.category_id,
                "category_name": e.category.name if e.category else "Unknown",
                "name": e.name,
                "amount": e.amount,
                "frequency": e.frequency,
                "is_pretax": e.is_pretax,
                "is_mortgage": e.is_mortgage,
                "principal_portion": e.principal_portion,
                "interest_portion": e.interest_portion,
                "is_active": e.is_active,
                "annual_amount": annual,
                "monthly_amount": annual / 12,
            })

        return result
    finally:
        session.close()


@router.post("/expenses")
async def create_expense(data: ExpenseCreate):
    """Create a new expense."""
    db = get_database()
    session = db.get_session()
    try:
        expense = BudgetExpense(
            category_id=data.category_id,
            name=data.name,
            amount=data.amount,
            frequency=data.frequency,
            is_pretax=data.is_pretax,
            is_mortgage=data.is_mortgage,
            principal_portion=data.principal_portion,
            interest_portion=data.interest_portion,
            is_active=data.is_active,
        )
        session.add(expense)
        session.commit()

        return {
            "id": expense.id,
            "name": expense.name,
            "amount": expense.amount,
            "frequency": expense.frequency,
        }
    finally:
        session.close()


@router.put("/expenses/{expense_id}")
async def update_expense(expense_id: str, data: ExpenseUpdate):
    """Update an expense."""
    db = get_database()
    session = db.get_session()
    try:
        expense = session.query(BudgetExpense).filter(
            BudgetExpense.id == expense_id
        ).first()

        if not expense:
            raise HTTPException(status_code=404, detail="Expense not found")

        if data.category_id is not None:
            expense.category_id = data.category_id
        if data.name is not None:
            expense.name = data.name
        if data.amount is not None:
            expense.amount = data.amount
        if data.frequency is not None:
            expense.frequency = data.frequency
        if data.is_pretax is not None:
            expense.is_pretax = data.is_pretax
        if data.is_mortgage is not None:
            expense.is_mortgage = data.is_mortgage
        if data.principal_portion is not None:
            expense.principal_portion = data.principal_portion
        if data.interest_portion is not None:
            expense.interest_portion = data.interest_portion
        if data.is_active is not None:
            expense.is_active = data.is_active

        session.commit()

        return {"updated": True, "id": expense_id}
    finally:
        session.close()


@router.delete("/expenses/{expense_id}")
async def delete_expense(expense_id: str):
    """Delete an expense."""
    db = get_database()
    session = db.get_session()
    try:
        expense = session.query(BudgetExpense).filter(
            BudgetExpense.id == expense_id
        ).first()

        if not expense:
            raise HTTPException(status_code=404, detail="Expense not found")

        session.delete(expense)
        session.commit()

        return {"deleted": True, "id": expense_id}
    finally:
        session.close()


# =============================================================================
# Pre-tax Deduction Endpoints
# =============================================================================


@router.get("/deductions")
async def list_deductions():
    """List all pre-tax deductions."""
    db = get_database()
    session = db.get_session()
    try:
        deductions = session.query(BudgetPretaxDeduction).all()

        return [
            {
                "id": d.id,
                "income_source_id": d.income_source_id,
                "label": d.label,
                "deduction_type": d.deduction_type,
                "amount_per_period": d.amount_per_period,
                "employer_match": d.employer_match,
                "is_percentage": d.is_percentage,
                "max_annual": d.max_annual,
            }
            for d in deductions
        ]
    finally:
        session.close()


@router.post("/deductions")
async def create_deduction(data: DeductionCreate):
    """Create a new pre-tax deduction."""
    db = get_database()
    session = db.get_session()
    try:
        deduction = BudgetPretaxDeduction(
            income_source_id=data.income_source_id,
            label=data.label,
            deduction_type=data.deduction_type,
            amount_per_period=data.amount_per_period,
            employer_match=data.employer_match,
            is_percentage=data.is_percentage,
            max_annual=data.max_annual,
        )
        session.add(deduction)
        session.commit()

        return {
            "id": deduction.id,
            "label": deduction.label,
            "deduction_type": deduction.deduction_type,
            "amount_per_period": deduction.amount_per_period,
        }
    finally:
        session.close()


@router.put("/deductions/{deduction_id}")
async def update_deduction(deduction_id: str, data: DeductionUpdate):
    """Update a pre-tax deduction."""
    db = get_database()
    session = db.get_session()
    try:
        deduction = session.query(BudgetPretaxDeduction).filter(
            BudgetPretaxDeduction.id == deduction_id
        ).first()

        if not deduction:
            raise HTTPException(status_code=404, detail="Deduction not found")

        # Update fields if provided
        if data.income_source_id is not None:
            deduction.income_source_id = data.income_source_id
        if data.label is not None:
            deduction.label = data.label
        if data.deduction_type is not None:
            deduction.deduction_type = data.deduction_type
        if data.amount_per_period is not None:
            deduction.amount_per_period = data.amount_per_period
        if data.employer_match is not None:
            deduction.employer_match = data.employer_match
        if data.is_percentage is not None:
            deduction.is_percentage = data.is_percentage
        if data.max_annual is not None:
            deduction.max_annual = data.max_annual

        session.commit()

        return {
            "id": deduction.id,
            "income_source_id": deduction.income_source_id,
            "label": deduction.label,
            "deduction_type": deduction.deduction_type,
            "amount_per_period": deduction.amount_per_period,
            "employer_match": deduction.employer_match,
            "is_percentage": deduction.is_percentage,
            "max_annual": deduction.max_annual,
        }
    finally:
        session.close()


@router.delete("/deductions/{deduction_id}")
async def delete_deduction(deduction_id: str):
    """Delete a pre-tax deduction."""
    db = get_database()
    session = db.get_session()
    try:
        deduction = session.query(BudgetPretaxDeduction).filter(
            BudgetPretaxDeduction.id == deduction_id
        ).first()

        if not deduction:
            raise HTTPException(status_code=404, detail="Deduction not found")

        session.delete(deduction)
        session.commit()

        return {"deleted": True, "id": deduction_id}
    finally:
        session.close()


# =============================================================================
# Calculation Endpoints
# =============================================================================


@router.post("/calculate-paycheck")
async def calculate_paycheck(data: PaycheckRequest):
    """Calculate a single paycheck's tax breakdown."""
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


@router.post("/calculate-annual")
async def calculate_annual_summary(data: AnnualSummaryRequest):
    """Calculate annual budget summary from stored income and expenses."""
    db = get_database()
    session = db.get_session()
    try:
        # Get all active income sources
        income_sources = session.query(BudgetIncomeSource).filter(
            BudgetIncomeSource.is_active.is_(True)
        ).all()

        if not income_sources:
            return {
                "gross_income": 0,
                "total_income_sources": 0,
                "total_taxes": 0,
                "net_income": 0,
                "total_expenses": 0,
                "net_savings": 0,
                "savings_rate": 0,
            }

        # Get all active expenses
        expenses = session.query(BudgetExpense).filter(
            BudgetExpense.is_active.is_(True)
        ).all()

        # Get deductions
        deductions = session.query(BudgetPretaxDeduction).all()

        # Calculate totals
        total_gross = sum(s.gross_annual for s in income_sources)

        # Calculate taxes for each income source
        total_federal = 0
        total_state = 0
        total_ss = 0
        total_medicare = 0
        total_pretax = 0

        for source in income_sources:
            # Get deductions for this source
            source_deductions = [d for d in deductions if d.income_source_id == source.id]
            pretax_amount = sum(
                d.amount_per_period * PAY_FREQUENCIES.get(source.pay_frequency, 26)
                for d in source_deductions
            )
            total_pretax += pretax_amount

            calculator = PayrollTaxCalculator(
                filing_status=data.filing_status,
                state=source.state,
                tax_year=data.tax_year,
            )

            summary = calculator.calculate_annual_summary(
                annual_gross=source.gross_annual,
                pretax_deductions={"total": pretax_amount},
            )

            total_federal += summary["federal_income_tax"]
            total_state += summary["state_income_tax"]
            total_ss += summary["social_security"]
            total_medicare += summary["medicare"] + summary["additional_medicare"]

        total_taxes = total_federal + total_state + total_ss + total_medicare
        net_income = total_gross - total_taxes - total_pretax

        # Calculate expenses by category
        freq_multiplier = {
            "weekly": 52,
            "biweekly": 26,
            "monthly": 12,
            "quarterly": 4,
            "annual": 1,
            "one_time": 0,
        }

        expenses_by_category = {}
        total_expenses = 0

        for expense in expenses:
            if expense.is_pretax:
                continue  # Don't count pretax items as expenses

            mult = freq_multiplier.get(expense.frequency, 12)
            annual = expense.amount * mult if mult > 0 else expense.amount
            total_expenses += annual

            cat_name = expense.category.name if expense.category else "Other"
            expenses_by_category[cat_name] = expenses_by_category.get(cat_name, 0) + annual

        net_savings = net_income - total_expenses
        savings_rate = (net_savings / total_gross * 100) if total_gross > 0 else 0

        return {
            "gross_income": round(total_gross, 2),
            "total_income_sources": len(income_sources),
            "federal_income_tax": round(total_federal, 2),
            "state_income_tax": round(total_state, 2),
            "social_security_tax": round(total_ss, 2),
            "medicare_tax": round(total_medicare, 2),
            "total_taxes": round(total_taxes, 2),
            "total_pretax_deductions": round(total_pretax, 2),
            "net_income": round(net_income, 2),
            "total_expenses": round(total_expenses, 2),
            "expenses_by_category": {k: round(v, 2) for k, v in expenses_by_category.items()},
            "net_savings": round(net_savings, 2),
            "savings_rate": round(savings_rate, 2),
            "effective_tax_rate": round((total_taxes / total_gross * 100) if total_gross > 0 else 0, 2),
            "monthly_gross": round(total_gross / 12, 2),
            "monthly_net": round(net_income / 12, 2),
            "monthly_expenses": round(total_expenses / 12, 2),
            "monthly_savings": round(net_savings / 12, 2),
        }
    finally:
        session.close()


@router.post("/social-security")
async def calculate_social_security(data: SocialSecurityRequest):
    """Estimate Social Security benefits."""
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


@router.post("/income-transition")
async def get_income_transition(data: IncomeTransitionRequest):
    """Project income transition from working to retirement.

    Shows year-by-year income from:
    - Employment income (pre-retirement)
    - Social Security benefits (post-SS claiming age)
    - Required portfolio withdrawals to maintain lifestyle
    """
    db = get_database()
    session = db.get_session()
    try:
        # Get current income sources
        sources = session.query(BudgetIncomeSource).filter(
            BudgetIncomeSource.is_active.is_(True)
        ).all()

        total_annual_income = sum(s.gross_annual for s in sources)

        # Get expenses for retirement spending target
        expenses = session.query(BudgetExpense).filter(
            BudgetExpense.is_active.is_(True)
        ).all()

        freq_to_annual = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "annual": 1}
        annual_expenses = sum(
            e.amount * freq_to_annual.get(e.frequency, 12)
            for e in expenses
        )

        # Estimate Social Security benefit
        ss_estimate = estimate_social_security_benefit(
            annual_income=total_annual_income,
            current_age=data.current_age,
            claiming_age=data.ss_claiming_age,
        )

        # Use override if provided
        monthly_ss = data.ss_benefit_override if data.ss_benefit_override else ss_estimate.monthly_benefit
        annual_ss = monthly_ss * 12

        # Generate year-by-year projection
        years = []
        inflation_rate = 0.025  # 2.5% annual inflation

        for age in range(data.current_age, data.end_age + 1):
            years_from_now = age - data.current_age
            inflation_factor = (1 + inflation_rate) ** years_from_now

            # Determine income sources based on age
            if age < data.retirement_age:
                # Still working
                employment_income = total_annual_income * inflation_factor
                ss_income = 0
                withdrawal_needed = 0
            else:
                # Retired
                employment_income = 0

                if age >= data.ss_claiming_age:
                    # Receiving Social Security (with COLA adjustments)
                    ss_income = annual_ss * inflation_factor
                else:
                    ss_income = 0

                # Calculate withdrawal needed to cover inflation-adjusted expenses
                target_spending = annual_expenses * inflation_factor
                withdrawal_needed = max(0, target_spending - ss_income)

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

        # Get SS claiming age comparison
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
    finally:
        session.close()


@router.get("/paycheck-chart-data")
async def get_paycheck_chart_data():
    """Get cumulative YTD data for paycheck stacked bar chart.

    Returns cumulative (running total) amounts for each pay period,
    with proper FICA wage cap handling - Social Security stops
    accumulating once the wage base is reached.
    """
    db = get_database()
    session = db.get_session()
    try:
        # Get tax config
        config = session.query(BudgetTaxConfig).first()
        filing_status = config.filing_status if config else "single"
        state = config.state if config else "CA"

        # Get income sources
        sources = session.query(BudgetIncomeSource).filter(
            BudgetIncomeSource.is_active.is_(True)
        ).all()

        if not sources:
            return {"periods": [], "data": []}

        # Use primary income source (first one)
        source = sources[0]
        periods_per_year = PAY_FREQUENCIES.get(source.pay_frequency, 26)
        gross_per_period = source.gross_annual / periods_per_year

        # Get deductions for this source
        deductions = session.query(BudgetPretaxDeduction).filter(
            BudgetPretaxDeduction.income_source_id == source.id
        ).all()

        pretax_per_period = {
            "401k": sum(d.amount_per_period for d in deductions if d.deduction_type == "401k"),
            "hsa": sum(d.amount_per_period for d in deductions if d.deduction_type == "hsa"),
            "fsa": sum(d.amount_per_period for d in deductions if d.deduction_type == "fsa"),
            "other": sum(d.amount_per_period for d in deductions if d.deduction_type == "other"),
        }
        total_pretax_per_period = sum(pretax_per_period.values())

        # Get expenses and convert to per-period
        expenses = session.query(BudgetExpense).filter(
            BudgetExpense.is_active.is_(True),
            BudgetExpense.is_pretax.is_(False),
        ).all()

        freq_to_annual = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4, "annual": 1}
        total_annual_expenses = sum(
            e.amount * freq_to_annual.get(e.frequency, 12)
            for e in expenses
        )
        expenses_per_period = total_annual_expenses / periods_per_year

        calculator = PayrollTaxCalculator(
            filing_status=filing_status,
            state=state,
            tax_year=2024,
        )

        # Tax rates and limits for manual per-period calculation
        ss_rate = 0.062  # 6.2%
        medicare_rate = 0.0145  # 1.45%
        additional_medicare_rate = 0.009  # 0.9%
        ss_wage_base = 168600  # 2024
        medicare_threshold = 250000 if "married" in filing_status else 200000

        # Annual contribution limits (2024)
        limit_401k = 23000
        limit_hsa = 4150 if filing_status == "single" else 8300
        limit_fsa = 3200

        # Per-period calculation with YTD tracking
        periods = []

        # Cumulative totals (YTD)
        ytd_gross = 0.0
        ytd_federal_tax = 0.0
        ytd_state_tax = 0.0
        ytd_ss_tax = 0.0
        ytd_medicare_tax = 0.0
        ytd_pretax = 0.0
        ytd_takehome = 0.0
        ytd_expenses = 0.0
        ytd_savings = 0.0

        # Track YTD contributions for limits
        ytd_401k = 0.0
        ytd_hsa = 0.0
        ytd_fsa = 0.0

        # Arrays for cumulative chart data
        gross_amounts = []
        federal_taxes = []
        state_taxes = []
        ss_taxes = []
        medicare_taxes = []
        pretax_deductions = []
        takehome_amounts = []
        expense_amounts = []
        savings_amounts = []

        for period in range(1, periods_per_year + 1):
            periods.append(period)

            # Add gross for this period
            ytd_gross += gross_per_period

            # Calculate pre-tax deductions with annual limits
            period_401k = min(pretax_per_period["401k"], max(0, limit_401k - ytd_401k))
            period_hsa = min(pretax_per_period["hsa"], max(0, limit_hsa - ytd_hsa))
            period_fsa = min(pretax_per_period["fsa"], max(0, limit_fsa - ytd_fsa))
            period_other = pretax_per_period["other"]
            period_pretax = period_401k + period_hsa + period_fsa + period_other

            ytd_401k += period_401k
            ytd_hsa += period_hsa
            ytd_fsa += period_fsa
            ytd_pretax += period_pretax

            # Calculate Social Security with wage cap
            prev_ytd_gross = ytd_gross - gross_per_period
            if prev_ytd_gross >= ss_wage_base:
                # Already at cap, no more SS tax
                period_ss = 0
            elif ytd_gross > ss_wage_base:
                # Partial period hits cap
                taxable_ss = ss_wage_base - prev_ytd_gross
                period_ss = taxable_ss * ss_rate
            else:
                # Full period taxable
                period_ss = gross_per_period * ss_rate
            ytd_ss_tax += period_ss

            # Calculate Medicare (no cap, but additional Medicare over threshold)
            period_medicare = gross_per_period * medicare_rate
            if ytd_gross > medicare_threshold:
                # Additional Medicare on income over threshold
                if prev_ytd_gross >= medicare_threshold:
                    # All of this period is over threshold
                    period_medicare += gross_per_period * additional_medicare_rate
                else:
                    # Partial period over threshold
                    excess = ytd_gross - medicare_threshold
                    period_medicare += excess * additional_medicare_rate
            ytd_medicare_tax += period_medicare

            # Calculate federal and state taxes (use calculator for brackets)
            # Approximate per-period by calculating annual and dividing
            annual_federal = calculator.calculate_federal_income_tax(
                source.gross_annual,
                pretax_deductions=total_pretax_per_period * periods_per_year
            )
            annual_state = calculator.calculate_state_tax(
                source.gross_annual,
                total_pretax_per_period * periods_per_year
            )

            # Prorate to this point in year
            ytd_federal_tax = (annual_federal / periods_per_year) * period
            ytd_state_tax = (annual_state / periods_per_year) * period

            # Calculate take-home
            period_takehome = (gross_per_period -
                              (annual_federal / periods_per_year) -
                              (annual_state / periods_per_year) -
                              period_ss - period_medicare - period_pretax)
            ytd_takehome += period_takehome

            # Expenses and savings
            ytd_expenses += expenses_per_period
            remaining = period_takehome - expenses_per_period
            ytd_savings += max(0, remaining)

            # Store cumulative values
            gross_amounts.append(round(ytd_gross, 2))
            federal_taxes.append(round(ytd_federal_tax, 2))
            state_taxes.append(round(ytd_state_tax, 2))
            ss_taxes.append(round(ytd_ss_tax, 2))
            medicare_taxes.append(round(ytd_medicare_tax, 2))
            pretax_deductions.append(round(ytd_pretax, 2))
            takehome_amounts.append(round(ytd_takehome, 2))
            expense_amounts.append(round(ytd_expenses, 2))
            savings_amounts.append(round(ytd_savings, 2))

        # Combined FICA for backwards compatibility
        fica_taxes = [round(ss + med, 2) for ss, med in zip(ss_taxes, medicare_taxes)]

        return {
            "periods": periods,
            "pay_frequency": source.pay_frequency,
            "gross_per_period": round(gross_per_period, 2),
            "cumulative": True,  # Flag indicating cumulative data
            "gross": gross_amounts,
            "federal_tax": federal_taxes,
            "state_tax": state_taxes,
            "social_security": ss_taxes,
            "medicare": medicare_taxes,
            "fica": fica_taxes,
            "pretax": pretax_deductions,
            "takehome": takehome_amounts,
            "expenses": expense_amounts,
            "savings": savings_amounts,
            # Limits info for display
            "limits": {
                "ss_wage_base": ss_wage_base,
                "limit_401k": limit_401k,
                "limit_hsa": limit_hsa,
                "limit_fsa": limit_fsa,
            }
        }
    finally:
        session.close()
