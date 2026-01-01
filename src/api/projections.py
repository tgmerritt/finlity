"""Monte Carlo projections API endpoints."""

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from typing import Optional

from src.database import Database
from src.projections.engine import (
    MonteCarloEngine,
    ProjectionParams,
    WithdrawalProjection,
    AccountBalances,
)

router = APIRouter(prefix="/api/projections", tags=["projections"])


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


@router.post("/monte-carlo", response_model=ProjectionResponse)
def run_monte_carlo(
    request: ProjectionRequest,
    db: Database = Depends(get_db),
) -> ProjectionResponse:
    """
    Run Monte Carlo simulation for retirement projection.

    Returns percentile bands showing the range of possible outcomes.
    Also saves results to database for dashboard metrics.

    Supports two modes:
    - Simple mode (default): Single pool of money with no tax considerations
    - Tax-aware mode: Tracks taxable, traditional, and Roth accounts separately
      with proper withdrawal ordering (taxable -> traditional -> Roth) and tax treatment
    """
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


@router.post("/sensitivity", response_model=SensitivityResponse)
def run_sensitivity_analysis(
    request: ProjectionRequest,
    db: Database = Depends(get_db),
) -> SensitivityResponse:
    """
    Run sensitivity analysis on projection parameters.

    Shows how changes in contribution, returns, and withdrawals affect outcomes.
    """
    # Get current balance from portfolio if not provided
    current_balance = request.current_balance
    if current_balance is None:
        summary = db.get_portfolio_summary()
        current_balance = summary["total_value"]

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
