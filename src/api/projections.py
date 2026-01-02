"""Monte Carlo projections API endpoints."""

import os
from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from typing import Optional

from src.database import Database
from src.services.background_tasks import task_manager
from src.database.models import BudgetIncomeSource, BudgetPretaxDeduction, BudgetTaxConfig
from src.budget.tax_calculator import PAY_FREQUENCIES
from src.projections.engine import (
    MonteCarloEngine,
    ProjectionParams,
    WithdrawalProjection,
    AccountBalances,
    TaxAwareWithdrawalStrategy,
)

router = APIRouter(prefix="/api/projections", tags=["projections"])


def is_hosted_environment() -> bool:
    """Check if running on Heroku or similar platform with request timeouts."""
    # DYNO is set on Heroku, PORT is set but may also be set locally
    return bool(os.environ.get("DYNO"))


def get_db() -> Database:
    """Dependency to get database instance (profile-aware)."""
    from src.database import get_database
    return get_database()


class AccountBalancesRequest(BaseModel):
    """Account balances by type for tax-aware projections."""
    taxable: float = Field(0, ge=0, description="Taxable brokerage account balance")
    traditional: float = Field(0, ge=0, description="Traditional IRA/401k balance (pre-tax)")
    roth: float = Field(0, ge=0, description="Roth IRA/401k balance (post-tax)")


class ProjectionRequest(BaseModel):
    """Request model for Monte Carlo projection."""
    current_age: int = Field(..., ge=18, le=100, description="Current age")
    retirement_age: int = Field(..., ge=30, le=100, description="Target retirement age")
    current_balance: Optional[float] = Field(None, ge=0, description="Current portfolio balance (auto-filled if not provided)")
    monthly_contribution: float = Field(..., ge=0, description="Monthly contribution amount")
    monthly_withdrawal: float = Field(..., ge=0, description="Monthly withdrawal in retirement")
    stock_allocation: float = Field(0.70, ge=0, le=1, description="Stock allocation (0-1)")
    bond_allocation: float = Field(0.25, ge=0, le=1, description="Bond allocation (0-1)")
    end_age: int = Field(95, ge=65, le=120, description="End age for projection")

    # Tax-aware withdrawal parameters
    use_tax_aware_withdrawals: bool = Field(
        False,
        description="Enable tax-aware withdrawal ordering (taxable -> traditional -> Roth)"
    )
    account_balances: Optional[AccountBalancesRequest] = Field(
        None,
        description="Account balances by type (required if use_tax_aware_withdrawals is True)"
    )

    # Tax rates
    tax_rate_ordinary: float = Field(
        0.22, ge=0, le=0.50,
        description="Federal marginal tax rate for ordinary income (traditional withdrawals)"
    )
    tax_rate_capital_gains: float = Field(
        0.15, ge=0, le=0.30,
        description="Long-term capital gains tax rate"
    )
    tax_rate_state: float = Field(
        0.05, ge=0, le=0.15,
        description="State income tax rate"
    )
    cost_basis_ratio: float = Field(
        0.60, ge=0, le=1.0,
        description="Portion of taxable account that is cost basis (not taxed on withdrawal)"
    )

    # Contribution allocation (how monthly contributions are split)
    contribution_traditional_pct: float = Field(
        0.60, ge=0, le=1.0,
        description="Percentage of contributions to traditional 401k/IRA"
    )
    contribution_roth_pct: float = Field(
        0.25, ge=0, le=1.0,
        description="Percentage of contributions to Roth 401k/IRA"
    )
    contribution_taxable_pct: float = Field(
        0.15, ge=0, le=1.0,
        description="Percentage of contributions to taxable brokerage"
    )


class ProjectionResponse(BaseModel):
    """Response model for Monte Carlo projection."""
    ages: list[int]
    median_values: list[float]
    percentile_10: list[float]
    percentile_25: list[float]
    percentile_75: list[float]
    percentile_90: list[float]
    success_rate: float
    median_final_value: float
    worst_case_final: float
    best_case_final: float


class FireRequest(BaseModel):
    """Request for FIRE calculation."""
    annual_spending: float = Field(..., gt=0, description="Annual spending in retirement")
    withdrawal_rate: float = Field(0.04, gt=0, le=0.10, description="Safe withdrawal rate")
    current_balance: Optional[float] = Field(None, ge=0, description="Current balance (auto-filled if not provided)")
    monthly_contribution: float = Field(..., ge=0, description="Monthly contribution")


class FireResponse(BaseModel):
    """Response for FIRE calculation."""
    fire_number: float
    years_to_fire: float
    current_balance: float
    monthly_contribution: float
    progress_pct: float


class SensitivityResponse(BaseModel):
    """Sensitivity analysis response."""
    contribution_impacts: dict[str, float]
    return_impacts: dict[str, float]
    withdrawal_impacts: dict[str, float]


def _run_monte_carlo_task(
    request_dict: dict,
    db_path: str,
) -> dict:
    """
    Background task function for Monte Carlo simulation.

    This is separated so it can be run in a background thread.
    Returns a dict that can be converted to ProjectionResponse.
    """
    # Recreate database connection in background thread
    from src.database import Database

    db = Database(db_path)

    # Recreate request from dict
    current_balance = request_dict.get("current_balance")
    if current_balance is None:
        summary = db.get_portfolio_summary()
        current_balance = summary["total_value"]

    # Validate allocations
    stock_allocation = request_dict.get("stock_allocation", 0.70)
    bond_allocation = request_dict.get("bond_allocation", 0.25)
    cash_allocation = 1.0 - stock_allocation - bond_allocation
    if cash_allocation < 0:
        cash_allocation = 0
        total = stock_allocation + bond_allocation
        stock_alloc = stock_allocation / total
        bond_alloc = bond_allocation / total
    else:
        stock_alloc = stock_allocation
        bond_alloc = bond_allocation

    # Build account balances if tax-aware mode is enabled
    account_balances = None
    if request_dict.get("use_tax_aware_withdrawals") and request_dict.get("account_balances"):
        ab = request_dict["account_balances"]
        account_balances = AccountBalances(
            taxable=ab.get("taxable", 0),
            traditional=ab.get("traditional", 0),
            roth=ab.get("roth", 0),
        )
        current_balance = account_balances.total

    params = ProjectionParams(
        current_age=request_dict["current_age"],
        retirement_age=request_dict["retirement_age"],
        current_balance=current_balance,
        monthly_contribution=request_dict["monthly_contribution"],
        monthly_withdrawal=request_dict["monthly_withdrawal"],
        stock_allocation=stock_alloc,
        bond_allocation=bond_alloc,
        cash_allocation=cash_allocation,
        use_tax_aware_withdrawals=request_dict.get("use_tax_aware_withdrawals", False),
        account_balances=account_balances,
        tax_rate_ordinary=request_dict.get("tax_rate_ordinary", 0.22),
        tax_rate_capital_gains=request_dict.get("tax_rate_capital_gains", 0.15),
        tax_rate_state=request_dict.get("tax_rate_state", 0.05),
        cost_basis_ratio=request_dict.get("cost_basis_ratio", 0.60),
        contribution_traditional_pct=request_dict.get("contribution_traditional_pct", 0.60),
        contribution_roth_pct=request_dict.get("contribution_roth_pct", 0.25),
        contribution_taxable_pct=request_dict.get("contribution_taxable_pct", 0.15),
    )

    engine = MonteCarloEngine()
    end_age = request_dict.get("end_age", 95)
    result = engine.run_projection(params, end_age=end_age)

    # Extract projected portfolio value at retirement age
    retirement_index = request_dict["retirement_age"] - request_dict["current_age"]
    projected_value_at_retirement = None
    conservative_value_at_retirement = None

    if 0 <= retirement_index < len(result.median_values):
        projected_value_at_retirement = result.median_values[retirement_index]
        conservative_value_at_retirement = result.percentile_25[retirement_index]

    # Calculate earliest retirement age
    earliest_retirement_age = None
    if request_dict["monthly_withdrawal"] > 0:
        earliest_retirement_age = _find_earliest_retirement_age(
            engine=engine,
            current_age=request_dict["current_age"],
            current_balance=current_balance,
            monthly_contribution=request_dict["monthly_contribution"],
            monthly_withdrawal=request_dict["monthly_withdrawal"],
            stock_allocation=stock_alloc,
            bond_allocation=bond_alloc,
            end_age=end_age,
            target_success_rate=0.80,
        )

    # Save results to database
    db.save_monte_carlo_result(
        current_age=request_dict["current_age"],
        retirement_age=request_dict["retirement_age"],
        portfolio_balance=current_balance,
        success_rate=result.success_rate,
        monthly_contribution=request_dict["monthly_contribution"],
        monthly_withdrawal=request_dict["monthly_withdrawal"],
        median_final_value=result.median_final_value,
        worst_case_final=result.worst_case_final,
        best_case_final=result.best_case_final,
        earliest_retirement_age=earliest_retirement_age,
        projected_value_at_retirement=projected_value_at_retirement,
        conservative_value_at_retirement=conservative_value_at_retirement,
    )

    return {
        "ages": result.ages,
        "median_values": result.median_values,
        "percentile_10": result.percentile_10,
        "percentile_25": result.percentile_25,
        "percentile_75": result.percentile_75,
        "percentile_90": result.percentile_90,
        "success_rate": result.success_rate,
        "median_final_value": result.median_final_value,
        "worst_case_final": result.worst_case_final,
        "best_case_final": result.best_case_final,
    }


@router.post("/monte-carlo")
def run_monte_carlo(
    request: ProjectionRequest,
    async_mode: bool = Query(
        default=None,
        description="Run in background and return task_id. Defaults to True on Heroku, False locally."
    ),
    db: Database = Depends(get_db),
):
    """
    Run Monte Carlo simulation for retirement projection.

    Returns percentile bands showing the range of possible outcomes.
    Also saves results to database for dashboard metrics.

    On hosted platforms (Heroku), this runs asynchronously by default to avoid
    30-second request timeouts. Use `async_mode=false` to force synchronous execution.

    When async_mode is True:
    - Returns `{"task_id": "..."}` immediately
    - Poll `GET /api/tasks/{task_id}` for results

    Supports two modes:
    - Simple mode (default): Single pool of money with no tax considerations
    - Tax-aware mode: Tracks taxable, traditional, and Roth accounts separately
      with proper withdrawal ordering (taxable -> traditional -> Roth) and tax treatment
    """
    # Determine if we should run async
    use_async = async_mode if async_mode is not None else is_hosted_environment()

    if use_async:
        # Convert request to dict for background task
        request_dict = request.model_dump()
        if request.account_balances:
            request_dict["account_balances"] = request.account_balances.model_dump()

        # Get database path for background thread
        db_path = db.db_path

        # Submit to background task manager
        task_id = task_manager.submit(
            _run_monte_carlo_task,
            request_dict,
            db_path,
        )

        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Monte Carlo simulation started. Poll GET /api/tasks/{task_id} for results.",
        }

    # Synchronous execution (local development)
    # Get current balance from portfolio if not provided
    current_balance = request.current_balance
    if current_balance is None:
        summary = db.get_portfolio_summary()
        current_balance = summary["total_value"]

    # Validate allocations
    cash_allocation = 1.0 - request.stock_allocation - request.bond_allocation
    if cash_allocation < 0:
        cash_allocation = 0
        # Normalize
        total = request.stock_allocation + request.bond_allocation
        stock_alloc = request.stock_allocation / total
        bond_alloc = request.bond_allocation / total
    else:
        stock_alloc = request.stock_allocation
        bond_alloc = request.bond_allocation

    # Build account balances if tax-aware mode is enabled
    account_balances = None
    if request.use_tax_aware_withdrawals and request.account_balances:
        account_balances = AccountBalances(
            taxable=request.account_balances.taxable,
            traditional=request.account_balances.traditional,
            roth=request.account_balances.roth,
        )
        # Use total from account balances as current balance
        current_balance = account_balances.total

    params = ProjectionParams(
        current_age=request.current_age,
        retirement_age=request.retirement_age,
        current_balance=current_balance,
        monthly_contribution=request.monthly_contribution,
        monthly_withdrawal=request.monthly_withdrawal,
        stock_allocation=stock_alloc,
        bond_allocation=bond_alloc,
        cash_allocation=cash_allocation,
        # Tax-aware parameters
        use_tax_aware_withdrawals=request.use_tax_aware_withdrawals,
        account_balances=account_balances,
        tax_rate_ordinary=request.tax_rate_ordinary,
        tax_rate_capital_gains=request.tax_rate_capital_gains,
        tax_rate_state=request.tax_rate_state,
        cost_basis_ratio=request.cost_basis_ratio,
        contribution_traditional_pct=request.contribution_traditional_pct,
        contribution_roth_pct=request.contribution_roth_pct,
        contribution_taxable_pct=request.contribution_taxable_pct,
    )

    engine = MonteCarloEngine()
    result = engine.run_projection(params, end_age=request.end_age)

    # Extract projected portfolio value at retirement age
    # The arrays are indexed by (age - current_age)
    retirement_index = request.retirement_age - request.current_age
    projected_value_at_retirement = None
    conservative_value_at_retirement = None

    if 0 <= retirement_index < len(result.median_values):
        projected_value_at_retirement = result.median_values[retirement_index]
        # Use 25th percentile as conservative estimate (roughly 1 std below median)
        conservative_value_at_retirement = result.percentile_25[retirement_index]

    # Calculate earliest retirement age (where 80%+ success rate is achievable)
    earliest_retirement_age = None
    if request.monthly_withdrawal > 0:
        earliest_retirement_age = _find_earliest_retirement_age(
            engine=engine,
            current_age=request.current_age,
            current_balance=current_balance,
            monthly_contribution=request.monthly_contribution,
            monthly_withdrawal=request.monthly_withdrawal,
            stock_allocation=stock_alloc,
            bond_allocation=bond_alloc,
            end_age=request.end_age,
            target_success_rate=0.80,
        )

    # Save results to database for dashboard metrics
    db.save_monte_carlo_result(
        current_age=request.current_age,
        retirement_age=request.retirement_age,
        portfolio_balance=current_balance,
        success_rate=result.success_rate,
        monthly_contribution=request.monthly_contribution,
        monthly_withdrawal=request.monthly_withdrawal,
        median_final_value=result.median_final_value,
        worst_case_final=result.worst_case_final,
        best_case_final=result.best_case_final,
        earliest_retirement_age=earliest_retirement_age,
        projected_value_at_retirement=projected_value_at_retirement,
        conservative_value_at_retirement=conservative_value_at_retirement,
    )

    return ProjectionResponse(
        ages=result.ages,
        median_values=result.median_values,
        percentile_10=result.percentile_10,
        percentile_25=result.percentile_25,
        percentile_75=result.percentile_75,
        percentile_90=result.percentile_90,
        success_rate=result.success_rate,
        median_final_value=result.median_final_value,
        worst_case_final=result.worst_case_final,
        best_case_final=result.best_case_final,
    )


def _find_earliest_retirement_age(
    engine: MonteCarloEngine,
    current_age: int,
    current_balance: float,
    monthly_contribution: float,
    monthly_withdrawal: float,
    stock_allocation: float,
    bond_allocation: float,
    end_age: int,
    target_success_rate: float = 0.80,
) -> Optional[int]:
    """Find the earliest age where retirement with target success rate is achievable.

    Binary search to find the youngest retirement age where success rate >= target.
    """
    min_age = current_age + 1
    max_age = end_age - 5  # Need at least 5 years of retirement

    best_age = None

    # Binary search for earliest viable retirement age
    while min_age <= max_age:
        test_age = (min_age + max_age) // 2

        params = ProjectionParams(
            current_age=current_age,
            retirement_age=test_age,
            current_balance=current_balance,
            monthly_contribution=monthly_contribution,
            monthly_withdrawal=monthly_withdrawal,
            stock_allocation=stock_allocation,
            bond_allocation=bond_allocation,
        )

        result = engine.run_projection(params, end_age=end_age)

        if result.success_rate >= target_success_rate:
            best_age = test_age
            max_age = test_age - 1  # Try to find earlier age
        else:
            min_age = test_age + 1  # Need later retirement

    return best_age


@router.post("/fire", response_model=FireResponse)
def calculate_fire(
    request: FireRequest,
    db: Database = Depends(get_db),
) -> FireResponse:
    """
    Calculate FIRE (Financial Independence, Retire Early) metrics.

    Returns:
    - FIRE number: Amount needed to retire
    - Years to FIRE: Estimated years to reach FIRE number
    - Progress: Current progress toward FIRE
    """
    # Get current balance from portfolio if not provided
    current_balance = request.current_balance
    if current_balance is None:
        summary = db.get_portfolio_summary()
        current_balance = summary["total_value"]

    engine = MonteCarloEngine()

    fire_number = engine.calculate_fire_number(
        annual_spending=request.annual_spending,
        withdrawal_rate=request.withdrawal_rate,
    )

    years_to_fire = engine.estimate_years_to_fire(
        current_balance=current_balance,
        monthly_contribution=request.monthly_contribution,
        fire_number=fire_number,
    )

    progress_pct = (current_balance / fire_number * 100) if fire_number > 0 else 0

    return FireResponse(
        fire_number=fire_number,
        years_to_fire=years_to_fire,
        current_balance=current_balance,
        monthly_contribution=request.monthly_contribution,
        progress_pct=min(progress_pct, 100),  # Cap at 100%
    )


class AccountBalancesByTypeResponse(BaseModel):
    """Response with account balances grouped by tax treatment."""
    taxable: float = Field(..., description="Total in taxable brokerage accounts")
    traditional: float = Field(..., description="Total in traditional IRA/401k (pre-tax)")
    roth: float = Field(..., description="Total in Roth IRA/401k (post-tax)")
    total: float = Field(..., description="Grand total across all accounts")
    by_account: list[dict] = Field(..., description="Breakdown by individual account")


@router.get("/account-balances-by-type", response_model=AccountBalancesByTypeResponse)
def get_account_balances_by_type(
    db: Database = Depends(get_db),
) -> AccountBalancesByTypeResponse:
    """
    Get current portfolio balances grouped by tax treatment.

    Returns balances for:
    - Taxable: Regular brokerage accounts (capital gains tax on gains)
    - Traditional: Traditional IRA/401k (ordinary income tax on withdrawal)
    - Roth: Roth IRA/401k (tax-free withdrawals)

    Use this to populate the account_balances field for tax-aware projections.
    """
    accounts = db.get_all_accounts()
    positions = db.get_all_positions()

    # Map account_type to tax category
    TAX_CATEGORY_MAP = {
        # Taxable accounts
        "taxable": "taxable",
        "brokerage": "taxable",
        "checking": "taxable",
        "savings": "taxable",
        "hysa": "taxable",
        "529": "taxable",  # 529 has special tax treatment but treat as taxable for simplicity
        "treasury_direct": "taxable",

        # Traditional (pre-tax)
        "traditional_401k": "traditional",
        "traditional_ira": "traditional",
        "401k": "traditional",
        "ira": "traditional",
        "pension": "traditional",
        "hsa": "traditional",  # HSA is actually better than traditional but close enough

        # Roth (post-tax, tax-free growth)
        "roth_401k": "roth",
        "roth_ira": "roth",
        "roth": "roth",
    }

    # Create account lookup
    account_map = {a.id: a for a in accounts}

    # Aggregate by tax category
    totals = {"taxable": 0.0, "traditional": 0.0, "roth": 0.0}
    by_account = []

    account_totals = {}
    for pos in positions:
        if not pos.current_price:
            continue

        value = pos.shares * pos.current_price
        account = account_map.get(pos.account_id)
        if not account:
            continue

        # Determine tax category
        account_type = account.account_type.lower().replace(" ", "_").replace("-", "_")
        tax_category = TAX_CATEGORY_MAP.get(account_type, "taxable")

        # Check for retirement flag override
        if account.is_retirement and tax_category == "taxable":
            # If marked as retirement but unrecognized type, default to traditional
            tax_category = "traditional"

        totals[tax_category] += value

        # Track by account
        if account.id not in account_totals:
            account_totals[account.id] = {
                "name": account.name,
                "type": account.account_type,
                "tax_category": tax_category,
                "value": 0.0,
            }
        account_totals[account.id]["value"] += value

    by_account = list(account_totals.values())

    return AccountBalancesByTypeResponse(
        taxable=round(totals["taxable"], 2),
        traditional=round(totals["traditional"], 2),
        roth=round(totals["roth"], 2),
        total=round(sum(totals.values()), 2),
        by_account=by_account,
    )


def _run_sensitivity_task(request_dict: dict, current_balance: float) -> dict:
    """Background task for sensitivity analysis."""
    params = ProjectionParams(
        current_age=request_dict["current_age"],
        retirement_age=request_dict["retirement_age"],
        current_balance=current_balance,
        monthly_contribution=request_dict["monthly_contribution"],
        monthly_withdrawal=request_dict["monthly_withdrawal"],
        stock_allocation=request_dict.get("stock_allocation", 0.70),
        bond_allocation=request_dict.get("bond_allocation", 0.25),
    )

    engine = MonteCarloEngine()
    result = engine.run_sensitivity_analysis(params, end_age=request_dict.get("end_age", 95))

    return {
        "contribution_impacts": {f"${k:,.0f}": v for k, v in result.contribution_impacts.items()},
        "return_impacts": {f"{k*100:.0f}% stocks": v for k, v in result.return_impacts.items()},
        "withdrawal_impacts": {f"${k:,.0f}": v for k, v in result.withdrawal_impacts.items()},
    }


@router.post("/sensitivity")
def run_sensitivity_analysis(
    request: ProjectionRequest,
    async_mode: bool = Query(
        default=None,
        description="Run in background. Defaults to True on Heroku, False locally."
    ),
    db: Database = Depends(get_db),
):
    """
    Run sensitivity analysis on projection parameters.

    Shows how changes in contribution, returns, and withdrawals affect outcomes.
    Runs multiple Monte Carlo simulations, so supports async mode for hosted platforms.
    """
    # Get current balance from portfolio if not provided
    current_balance = request.current_balance
    if current_balance is None:
        summary = db.get_portfolio_summary()
        current_balance = summary["total_value"]

    # Determine if we should run async
    use_async = async_mode if async_mode is not None else is_hosted_environment()

    if use_async:
        request_dict = request.model_dump()
        task_id = task_manager.submit(
            _run_sensitivity_task,
            request_dict,
            current_balance,
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Sensitivity analysis started. Poll GET /api/tasks/{task_id} for results.",
        }

    # Synchronous execution
    params = ProjectionParams(
        current_age=request.current_age,
        retirement_age=request.retirement_age,
        current_balance=current_balance,
        monthly_contribution=request.monthly_contribution,
        monthly_withdrawal=request.monthly_withdrawal,
        stock_allocation=request.stock_allocation,
        bond_allocation=request.bond_allocation,
    )

    engine = MonteCarloEngine()
    result = engine.run_sensitivity_analysis(params, end_age=request.end_age)

    # Convert dict keys to strings for JSON serialization
    return SensitivityResponse(
        contribution_impacts={f"${k:,.0f}": v for k, v in result.contribution_impacts.items()},
        return_impacts={f"{k*100:.0f}% stocks": v for k, v in result.return_impacts.items()},
        withdrawal_impacts={f"${k:,.0f}": v for k, v in result.withdrawal_impacts.items()},
    )


@router.get("/quick-projection")
def quick_projection(
    current_age: int,
    retirement_age: int,
    monthly_contribution: float,
    monthly_withdrawal: float,
    db: Database = Depends(get_db),
):
    """
    Quick projection endpoint with minimal parameters.

    Uses current portfolio balance and default allocations.
    """
    summary = db.get_portfolio_summary()
    current_balance = summary["total_value"]

    params = ProjectionParams(
        current_age=current_age,
        retirement_age=retirement_age,
        current_balance=current_balance,
        monthly_contribution=monthly_contribution,
        monthly_withdrawal=monthly_withdrawal,
    )

    engine = MonteCarloEngine()
    result = engine.run_projection(params)

    return {
        "current_balance": current_balance,
        "success_rate": f"{result.success_rate * 100:.1f}%",
        "median_at_retirement": result.median_values[retirement_age - current_age],
        "median_final": result.median_final_value,
        "worst_case": result.worst_case_final,
        "best_case": result.best_case_final,
    }


# ====================
# Withdrawal Projection Endpoints
# ====================

class WithdrawalRequest(BaseModel):
    """Request model for withdrawal projection."""
    starting_balance: Optional[float] = Field(
        None, ge=0,
        description="Starting balance (auto-filled from portfolio if not provided)"
    )
    withdrawal_rate_or_amount: float = Field(
        ...,
        description="Withdrawal rate (0-1) or fixed dollar amount"
    )
    is_percentage: bool = Field(
        True,
        description="True if withdrawal_rate_or_amount is a percentage"
    )
    start_age: int = Field(
        65, ge=30, le=100,
        description="Age to begin withdrawals"
    )
    end_age: int = Field(
        100, ge=50, le=120,
        description="Maximum age to project"
    )
    expected_return: float = Field(
        0.06, ge=0, le=0.20,
        description="Expected annual return (default 6%)"
    )
    inflation_rate: float = Field(
        0.03, ge=0, le=0.10,
        description="Expected inflation rate (default 3%)"
    )
    adjust_for_inflation: bool = Field(
        True,
        description="Whether to adjust withdrawals for inflation"
    )


class WithdrawalYearResponse(BaseModel):
    """Single year in withdrawal table."""
    year: int
    age: int
    beginning_balance: float
    withdrawal_amount: float
    investment_return: float
    ending_balance: float
    cumulative_withdrawn: float


class WithdrawalResponse(BaseModel):
    """Response model for withdrawal projection."""
    rows: list[WithdrawalYearResponse]
    total_withdrawn: float
    final_balance: float
    depletion_year: Optional[int]
    depletion_age: Optional[int]
    success: bool
    safe_withdrawal_rate: Optional[float] = None


@router.post("/withdrawal-table", response_model=WithdrawalResponse)
def get_withdrawal_table(
    request: WithdrawalRequest,
    db: Database = Depends(get_db),
) -> WithdrawalResponse:
    """
    Generate year-by-year withdrawal projection table.

    Shows beginning balance, withdrawal amount, investment return,
    and ending balance for each year from start_age to end_age.
    """
    # Get starting balance from portfolio if not provided
    starting_balance = request.starting_balance
    if starting_balance is None:
        summary = db.get_portfolio_summary()
        starting_balance = summary["total_value"]

    projection = WithdrawalProjection(
        expected_return=request.expected_return,
        inflation_rate=request.inflation_rate,
    )

    result = projection.project_withdrawals(
        starting_balance=starting_balance,
        withdrawal_rate_or_amount=request.withdrawal_rate_or_amount,
        is_percentage=request.is_percentage,
        start_age=request.start_age,
        end_age=request.end_age,
        adjust_for_inflation=request.adjust_for_inflation,
    )

    # Also calculate safe withdrawal rate
    safe_rate = projection.find_safe_withdrawal_rate(
        starting_balance=starting_balance,
        start_age=request.start_age,
        end_age=request.end_age,
    )

    return WithdrawalResponse(
        rows=[
            WithdrawalYearResponse(
                year=row.year,
                age=row.age,
                beginning_balance=row.beginning_balance,
                withdrawal_amount=row.withdrawal_amount,
                investment_return=row.investment_return,
                ending_balance=row.ending_balance,
                cumulative_withdrawn=row.cumulative_withdrawn,
            )
            for row in result.rows
        ],
        total_withdrawn=result.total_withdrawn,
        final_balance=result.final_balance,
        depletion_year=result.depletion_year,
        depletion_age=result.depletion_age,
        success=result.success,
        safe_withdrawal_rate=safe_rate,
    )


@router.get("/withdrawal-comparison")
def compare_withdrawal_rates(
    start_age: int = 65,
    end_age: int = 100,
    expected_return: float = 0.06,
    db: Database = Depends(get_db),
):
    """
    Compare multiple withdrawal rate scenarios.

    Returns summary for 3%, 3.5%, 4%, 4.5%, and 5% withdrawal rates.
    """
    summary = db.get_portfolio_summary()
    starting_balance = summary["total_value"]

    if starting_balance == 0:
        return {
            "starting_balance": 0,
            "scenarios": {},
            "message": "No portfolio balance to project",
        }

    projection = WithdrawalProjection(expected_return=expected_return)
    scenarios = projection.compare_scenarios(
        starting_balance=starting_balance,
        start_age=start_age,
        end_age=end_age,
    )

    results = {}
    for rate_label, result in scenarios.items():
        results[rate_label] = {
            "annual_withdrawal": result.rows[0].withdrawal_amount if result.rows else 0,
            "total_withdrawn": result.total_withdrawn,
            "final_balance": result.final_balance,
            "depletion_age": result.depletion_age,
            "success": result.success,
        }

    # Calculate safe withdrawal rate
    safe_rate = projection.find_safe_withdrawal_rate(
        starting_balance=starting_balance,
        start_age=start_age,
        end_age=end_age,
    )

    return {
        "starting_balance": starting_balance,
        "start_age": start_age,
        "end_age": end_age,
        "expected_return": expected_return,
        "safe_withdrawal_rate": f"{safe_rate * 100:.2f}%",
        "scenarios": results,
    }


# ====================
# Tax Projection Endpoints
# ====================

class TaxProjectionRequest(BaseModel):
    """Request model for tax-aware year-by-year projection."""
    current_age: int = Field(..., ge=18, le=100, description="Current age")
    retirement_age: int = Field(..., ge=30, le=100, description="Age to begin withdrawals")
    end_age: int = Field(95, ge=50, le=120, description="Maximum age to project")

    # Account balances - can be provided or auto-filled
    taxable_balance: Optional[float] = Field(
        None, ge=0,
        description="Taxable brokerage account balance (auto-filled if not provided)"
    )
    traditional_balance: Optional[float] = Field(
        None, ge=0,
        description="Traditional IRA/401k balance (auto-filled if not provided)"
    )
    roth_balance: Optional[float] = Field(
        None, ge=0,
        description="Roth IRA/401k balance (auto-filled if not provided)"
    )

    # Spending
    annual_spending: float = Field(
        ..., gt=0,
        description="Annual spending need in retirement (will be inflation-adjusted)"
    )

    # Contributions during accumulation phase (before retirement)
    monthly_contribution: float = Field(
        0, ge=0,
        description="Monthly contribution during accumulation phase (before retirement)"
    )
    contribution_to_traditional_pct: float = Field(
        0.60, ge=0, le=1.0,
        description="Percentage of contributions going to traditional accounts"
    )
    contribution_to_roth_pct: float = Field(
        0.25, ge=0, le=1.0,
        description="Percentage of contributions going to Roth accounts"
    )
    contribution_to_taxable_pct: float = Field(
        0.15, ge=0, le=1.0,
        description="Percentage of contributions going to taxable accounts"
    )

    # Return assumptions
    expected_return: float = Field(
        0.06, ge=0, le=0.20,
        description="Expected annual investment return"
    )
    inflation_rate: float = Field(
        0.03, ge=0, le=0.10,
        description="Expected annual inflation rate"
    )

    # Tax rates
    federal_tax_rate: float = Field(
        0.22, ge=0, le=0.50,
        description="Federal marginal tax rate for ordinary income"
    )
    state_tax_rate: float = Field(
        0.05, ge=0, le=0.15,
        description="State income tax rate"
    )
    capital_gains_rate: float = Field(
        0.15, ge=0, le=0.30,
        description="Long-term capital gains tax rate"
    )
    cost_basis_ratio: float = Field(
        0.60, ge=0, le=1.0,
        description="Portion of taxable account that is cost basis"
    )

    # Pre-retirement income settings
    use_budget_income: bool = Field(
        True,
        description="Pull income from Expenses & Income page for pre-retirement taxes"
    )
    # Manual income override (used only if use_budget_income is False)
    manual_pre_retirement_income: float = Field(
        0.0, ge=0,
        description="Manual annual gross income (only used if use_budget_income is False)"
    )
    manual_pre_retirement_deductions: float = Field(
        0.0, ge=0,
        description="Manual annual pre-tax deductions (only used if use_budget_income is False)"
    )
    filing_status: str = Field(
        "single",
        description="Tax filing status: single, married_joint, married_separate, head_household"
    )
    state: str = Field(
        "CA",
        description="Two-letter state code for state taxes"
    )


class TaxYearProjectionResponse(BaseModel):
    """Single year in tax projection."""
    year: int
    age: int
    taxable_balance: float
    traditional_balance: float
    roth_balance: float
    total_balance: float
    rmd_amount: float
    from_taxable: float
    from_traditional: float
    from_roth: float
    gross_withdrawal: float
    federal_tax: float
    state_tax: float
    total_tax: float
    effective_rate: float
    net_withdrawal: float
    investment_return: float
    # Phase tracking
    phase: str = "withdrawal"  # "accumulation" or "withdrawal"
    income_source: str = "withdrawal"  # "salary" or "withdrawal"


class TaxProjectionSummaryResponse(BaseModel):
    """Summary statistics for tax projection."""
    total_federal_tax: float
    total_state_tax: float
    total_tax: float
    average_effective_rate: float
    total_withdrawn: float  # Net (after-tax)
    total_gross_withdrawn: float  # Gross (before-tax)
    final_balance: float
    depletion_age: Optional[int]
    # Pre-retirement (accumulation phase) tax totals
    pre_retirement_federal_tax: float = 0.0
    pre_retirement_state_tax: float = 0.0
    pre_retirement_total_tax: float = 0.0
    pre_retirement_avg_effective_rate: float = 0.0
    # Post-retirement (withdrawal phase) tax totals
    post_retirement_federal_tax: float = 0.0
    post_retirement_state_tax: float = 0.0
    post_retirement_total_tax: float = 0.0


class TaxProjectionResponse(BaseModel):
    """Response model for tax-aware projection."""
    years: list[TaxYearProjectionResponse]
    summary: TaxProjectionSummaryResponse
    # Chart-ready data arrays
    chart_data: dict


def _run_tax_projection_task(params: dict) -> dict:
    """Background task for tax projection."""
    initial_balances = AccountBalances(
        taxable=params["taxable"],
        traditional=params["traditional"],
        roth=params["roth"],
    )

    strategy = TaxAwareWithdrawalStrategy(
        tax_rate_ordinary=params["federal_tax_rate"],
        tax_rate_capital_gains=params["capital_gains_rate"],
        tax_rate_state=params["state_tax_rate"],
        cost_basis_ratio=params["cost_basis_ratio"],
    )

    result = strategy.project_year_by_year(
        current_age=params["current_age"],
        retirement_age=params["retirement_age"],
        end_age=params["end_age"],
        initial_balances=initial_balances,
        annual_spending=params["annual_spending"],
        expected_return=params["expected_return"],
        inflation_rate=params["inflation_rate"],
        monthly_contribution=params["monthly_contribution"],
        contribution_to_traditional_pct=params["contribution_to_traditional_pct"],
        contribution_to_roth_pct=params["contribution_to_roth_pct"],
        contribution_to_taxable_pct=params["contribution_to_taxable_pct"],
        pre_retirement_income=params["pre_retirement_income"],
        pre_retirement_deductions=params["pre_retirement_deductions"],
        filing_status=params["filing_status"],
        state=params["state"],
        tax_year=2024,
    )

    # Convert to dict for JSON serialization
    years_data = [
        {
            "year": y.year,
            "age": y.age,
            "taxable_balance": y.taxable_balance,
            "traditional_balance": y.traditional_balance,
            "roth_balance": y.roth_balance,
            "total_balance": y.total_balance,
            "rmd_amount": y.rmd_amount,
            "from_taxable": y.from_taxable,
            "from_traditional": y.from_traditional,
            "from_roth": y.from_roth,
            "gross_withdrawal": y.gross_withdrawal,
            "federal_tax": y.federal_tax,
            "state_tax": y.state_tax,
            "total_tax": y.total_tax,
            "effective_rate": y.effective_rate,
            "net_withdrawal": y.net_withdrawal,
            "investment_return": y.investment_return,
            "phase": y.phase,
            "income_source": y.income_source,
        }
        for y in result.years
    ]

    summary_data = {
        "total_federal_tax": result.summary.total_federal_tax,
        "total_state_tax": result.summary.total_state_tax,
        "total_tax": result.summary.total_tax,
        "average_effective_rate": result.summary.average_effective_rate,
        "total_withdrawn": result.summary.total_withdrawn,
        "total_gross_withdrawn": result.summary.total_gross_withdrawn,
        "final_balance": result.summary.final_balance,
        "depletion_age": result.summary.depletion_age,
        "pre_retirement_federal_tax": result.summary.pre_retirement_federal_tax,
        "pre_retirement_state_tax": result.summary.pre_retirement_state_tax,
        "pre_retirement_total_tax": result.summary.pre_retirement_total_tax,
        "pre_retirement_avg_effective_rate": result.summary.pre_retirement_avg_effective_rate,
        "post_retirement_federal_tax": result.summary.post_retirement_federal_tax,
        "post_retirement_state_tax": result.summary.post_retirement_state_tax,
        "post_retirement_total_tax": result.summary.post_retirement_total_tax,
    }

    chart_data = {
        "ages": [y.age for y in result.years],
        "federal_taxes": [y.federal_tax for y in result.years],
        "state_taxes": [y.state_tax for y in result.years],
        "effective_rates": [y.effective_rate for y in result.years],
        "taxable_balances": [y.taxable_balance for y in result.years],
        "traditional_balances": [y.traditional_balance for y in result.years],
        "roth_balances": [y.roth_balance for y in result.years],
        "total_balances": [y.total_balance for y in result.years],
        "from_taxable": [y.from_taxable for y in result.years],
        "from_traditional": [y.from_traditional for y in result.years],
        "from_roth": [y.from_roth for y in result.years],
        "rmd_amounts": [y.rmd_amount for y in result.years],
        "phases": [y.phase for y in result.years],
        "income_sources": [y.income_source for y in result.years],
    }

    return {
        "years": years_data,
        "summary": summary_data,
        "chart_data": chart_data,
    }


@router.post("/tax-projection")
def run_tax_projection(
    request: TaxProjectionRequest,
    async_mode: bool = Query(
        default=None,
        description="Run in background. Defaults to True on Heroku, False locally."
    ),
    db: Database = Depends(get_db),
):
    """
    Run year-by-year tax-aware withdrawal projection.

    Returns detailed breakdown of:
    - Account balances over time (taxable, traditional, Roth)
    - Taxes paid each year (federal vs state)
    - Effective tax rate over time
    - Withdrawal sources (which accounts are drawn from)
    - RMD amounts when applicable

    This endpoint is specifically designed to power the Taxes dashboard tab
    with two main visualizations:
    1. Tax burden over time (stacked bar + effective rate line)
    2. Account balances over time (multi-line chart)

    Supports async mode for hosted platforms with request timeouts.
    """
    # Get account balances from portfolio if not provided
    taxable = request.taxable_balance
    traditional = request.traditional_balance
    roth = request.roth_balance

    if taxable is None or traditional is None or roth is None:
        # Fetch from portfolio
        balances_response = get_account_balances_by_type(db)
        if taxable is None:
            taxable = balances_response.taxable
        if traditional is None:
            traditional = balances_response.traditional
        if roth is None:
            roth = balances_response.roth

    # Fetch pre-retirement income from database if requested
    pre_retirement_income = 0.0
    pre_retirement_deductions = 0.0
    filing_status = request.filing_status
    state = request.state

    if request.use_budget_income:
        # Fetch income sources from database
        session = db.get_session()
        try:
            income_sources = session.query(BudgetIncomeSource).filter(
                BudgetIncomeSource.is_active.is_(True)
            ).all()

            # Sum up all active income sources
            for source in income_sources:
                pre_retirement_income += source.gross_annual
                # Use the first source's state if not specified
                if state == "CA" and source.state:
                    state = source.state

            # Fetch pre-tax deductions linked to income sources
            for source in income_sources:
                deductions = session.query(BudgetPretaxDeduction).filter(
                    BudgetPretaxDeduction.income_source_id == source.id
                ).all()
                for ded in deductions:
                    # Convert per-period to annual
                    periods_per_year = PAY_FREQUENCIES.get(source.pay_frequency, 26)
                    if ded.is_percentage:
                        # Deduction is a percentage of gross
                        annual_ded = source.gross_annual * (ded.amount_per_period / 100)
                    else:
                        annual_ded = ded.amount_per_period * periods_per_year
                    pre_retirement_deductions += annual_ded

            # Fetch tax config for filing status
            tax_config = session.query(BudgetTaxConfig).first()
            if tax_config:
                filing_status = tax_config.filing_status
                if tax_config.state:
                    state = tax_config.state
        finally:
            session.close()
    else:
        # Use manual values
        pre_retirement_income = request.manual_pre_retirement_income
        pre_retirement_deductions = request.manual_pre_retirement_deductions

    # Determine if we should run async
    use_async = async_mode if async_mode is not None else is_hosted_environment()

    # Prepare params for both sync and async execution
    task_params = {
        "taxable": taxable,
        "traditional": traditional,
        "roth": roth,
        "current_age": request.current_age,
        "retirement_age": request.retirement_age,
        "end_age": request.end_age,
        "annual_spending": request.annual_spending,
        "expected_return": request.expected_return,
        "inflation_rate": request.inflation_rate,
        "monthly_contribution": request.monthly_contribution,
        "contribution_to_traditional_pct": request.contribution_to_traditional_pct,
        "contribution_to_roth_pct": request.contribution_to_roth_pct,
        "contribution_to_taxable_pct": request.contribution_to_taxable_pct,
        "federal_tax_rate": request.federal_tax_rate,
        "capital_gains_rate": request.capital_gains_rate,
        "state_tax_rate": request.state_tax_rate,
        "cost_basis_ratio": request.cost_basis_ratio,
        "pre_retirement_income": pre_retirement_income,
        "pre_retirement_deductions": pre_retirement_deductions,
        "filing_status": filing_status,
        "state": state,
    }

    if use_async:
        task_id = task_manager.submit(_run_tax_projection_task, task_params)
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Tax projection started. Poll GET /api/tasks/{task_id} for results.",
        }

    # Synchronous execution - run the task function directly
    result = _run_tax_projection_task(task_params)

    # Convert dict result to response model
    return TaxProjectionResponse(
        years=[TaxYearProjectionResponse(**y) for y in result["years"]],
        summary=TaxProjectionSummaryResponse(**result["summary"]),
        chart_data=result["chart_data"],
    )
