"""Stateless v2 projections endpoints.

No DB fallback: `current_balance` (and `account_balances` where relevant)
must be supplied by the caller — the request models make these fields
required rather than Optional (v1's auto-fill-from-portfolio behavior
requires a DB and is not available here).
"""

from typing import Any, Optional

from fastapi import APIRouter, Query, Request
from pydantic import BaseModel, Field

from src.api.projections import (
    AccountBalancesRequest,
    AccountBalancesByTypeResponse,
    FireResponse,
    ProjectionResponse,
    SensitivityResponse,
    WithdrawalResponse,
    WithdrawalYearResponse,
    TaxProjectionResponse,
    TaxYearProjectionResponse,
    TaxProjectionSummaryResponse,
    _compute_monte_carlo,
    _run_sensitivity_task,
    _run_tax_projection_task,
    compute_pre_retirement_income,
    is_hosted_environment,
)
from src.api.v2.payload import (
    PortfolioPayload,
    IncomeSourcePayload,
    DeductionPayload,
    TaxConfigPayload,
    payload_to_raw_positions,
)
from src.services.background_tasks import task_manager
from src.projections.engine import MonteCarloEngine, ProjectionParams, WithdrawalProjection

router = APIRouter(prefix="/api/v2/projections", tags=["v2-projections"])


def get_session_id(request: Request) -> str | None:
    sid = getattr(request.state, "session_id", None)
    return sid if isinstance(sid, str) else None


# ====================
# Monte Carlo
# ====================


class ProjectionRequestV2(BaseModel):
    """Same shape as v1's ProjectionRequest, but current_balance is required."""

    current_age: int = Field(..., ge=18, le=100)
    retirement_age: int = Field(..., ge=30, le=100)
    current_balance: float = Field(..., ge=0, description="Current portfolio balance (required in v2)")
    monthly_contribution: float = Field(..., ge=0)
    monthly_withdrawal: float = Field(..., ge=0)
    stock_allocation: float = Field(0.70, ge=0, le=1)
    bond_allocation: float = Field(0.25, ge=0, le=1)
    end_age: int = Field(95, ge=65, le=120)

    use_tax_aware_withdrawals: bool = Field(False)
    account_balances: Optional[AccountBalancesRequest] = Field(None)

    tax_rate_ordinary: float = Field(0.22, ge=0, le=0.50)
    tax_rate_capital_gains: float = Field(0.15, ge=0, le=0.30)
    tax_rate_state: float = Field(0.05, ge=0, le=0.15)
    cost_basis_ratio: float = Field(0.60, ge=0, le=1.0)

    contribution_traditional_pct: float = Field(0.60, ge=0, le=1.0)
    contribution_roth_pct: float = Field(0.25, ge=0, le=1.0)
    contribution_taxable_pct: float = Field(0.15, ge=0, le=1.0)

    market_config: Optional[dict] = Field(
        None,
        description=(
            "Optional overrides for MonteCarloEngine's market assumptions "
            "(stock/bond mean return & std dev, correlation, inflation). "
            "Keys match config.yaml's `market` section. Never triggers a "
            "server-side config/DB lookup: omitted keys use MonteCarloEngine's "
            "own class defaults, not load_config()."
        ),
    )
    monte_carlo_config: Optional[dict] = Field(
        None,
        description=(
            "Optional overrides for MonteCarloEngine's simulation parameters "
            "(num_simulations, black/golden swan probability & impact, "
            "t_distribution_df). Keys match config.yaml's `monte_carlo` "
            "section. num_simulations is capped at 10000 regardless of what "
            "the client requests."
        ),
    )


MAX_CLIENT_NUM_SIMULATIONS = 10_000


def _build_engine_config(market_config: Optional[dict], monte_carlo_config: Optional[dict]) -> dict:
    """Build an explicit `{"market": ..., "monte_carlo": ...}` config dict for
    MonteCarloEngine, always non-None so it never falls back to
    load_config() / the server's shared profile DB. Caps num_simulations so
    a client can't demand an arbitrarily expensive simulation."""
    mc = dict(monte_carlo_config or {})
    if "num_simulations" in mc:
        try:
            mc["num_simulations"] = min(int(mc["num_simulations"]), MAX_CLIENT_NUM_SIMULATIONS)
        except (TypeError, ValueError):
            mc.pop("num_simulations")
    return {"market": dict(market_config or {}), "monte_carlo": mc}


def _resolve_current_balance(request_dict: dict, current_balance: float) -> float:
    if request_dict.get("use_tax_aware_withdrawals") and request_dict.get("account_balances"):
        ab = request_dict["account_balances"]
        return ab.get("taxable", 0) + ab.get("traditional", 0) + ab.get("roth", 0)
    return current_balance


def _run_monte_carlo_task_v2(
    request_dict: dict, config: dict, progress_callback: Optional[Any] = None
) -> dict:
    """v2 background task: pure compute only, no DB save."""
    current_balance = _resolve_current_balance(request_dict, request_dict["current_balance"])
    return _compute_monte_carlo(request_dict, current_balance, progress_callback, config=config)


@router.post("/monte-carlo")
def run_monte_carlo(
    request: ProjectionRequestV2,
    http_request: Request,
    async_mode: bool = Query(default=None),
) -> Any:
    """Monte Carlo simulation. No DB save (unlike v1)."""
    use_async = async_mode if async_mode is not None else is_hosted_environment()

    request_dict = request.model_dump()
    if request.account_balances:
        request_dict["account_balances"] = request.account_balances.model_dump()

    engine_config = _build_engine_config(request.market_config, request.monte_carlo_config)

    if use_async:
        session_id = get_session_id(http_request)
        task_id = task_manager.submit(
            _run_monte_carlo_task_v2, request_dict, engine_config, session_id=session_id
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Monte Carlo simulation started. Poll GET /api/tasks/{task_id} for results.",
        }

    current_balance = _resolve_current_balance(request_dict, request.current_balance)
    result = _compute_monte_carlo(request_dict, current_balance, config=engine_config)

    return ProjectionResponse(
        ages=result["ages"],
        median_values=result["median_values"],
        percentile_10=result["percentile_10"],
        percentile_25=result["percentile_25"],
        percentile_75=result["percentile_75"],
        percentile_90=result["percentile_90"],
        success_rate=result["success_rate"],
        median_final_value=result["median_final_value"],
        worst_case_final=result["worst_case_final"],
        best_case_final=result["best_case_final"],
    )


# ====================
# Sensitivity
# ====================


@router.post("/sensitivity")
def run_sensitivity_analysis(
    request: ProjectionRequestV2,
    http_request: Request,
    async_mode: bool = Query(default=None),
) -> Any:
    """Sensitivity analysis. current_balance required (no DB fallback)."""
    use_async = async_mode if async_mode is not None else is_hosted_environment()
    current_balance = request.current_balance
    engine_config = _build_engine_config(request.market_config, request.monte_carlo_config)

    if use_async:
        request_dict = request.model_dump()
        session_id = get_session_id(http_request)
        task_id = task_manager.submit(
            _run_sensitivity_task, request_dict, current_balance, config=engine_config, session_id=session_id
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Sensitivity analysis started. Poll GET /api/tasks/{task_id} for results.",
        }

    params = ProjectionParams(
        current_age=request.current_age,
        retirement_age=request.retirement_age,
        current_balance=current_balance,
        monthly_contribution=request.monthly_contribution,
        monthly_withdrawal=request.monthly_withdrawal,
        stock_allocation=request.stock_allocation,
        bond_allocation=request.bond_allocation,
    )

    engine = MonteCarloEngine(config=engine_config)
    result = engine.run_sensitivity_analysis(params, end_age=request.end_age)

    return SensitivityResponse(
        contribution_impacts={f"${k:,.0f}": v for k, v in result.contribution_impacts.items()},
        return_impacts={f"{k*100:.0f}% stocks": v for k, v in result.return_impacts.items()},
        withdrawal_impacts={f"${k:,.0f}": v for k, v in result.withdrawal_impacts.items()},
    )


# ====================
# FIRE
# ====================


class FireRequestV2(BaseModel):
    annual_spending: float = Field(..., gt=0)
    withdrawal_rate: float = Field(0.04, gt=0, le=0.10)
    current_balance: float = Field(..., ge=0, description="Current balance (required in v2)")
    monthly_contribution: float = Field(..., ge=0)
    market_config: Optional[dict] = Field(None)
    monte_carlo_config: Optional[dict] = Field(None)


@router.post("/fire", response_model=FireResponse)
def calculate_fire(request: FireRequestV2) -> FireResponse:
    """FIRE metrics. current_balance required (no DB fallback).

    calculate_fire_number/estimate_years_to_fire don't read market/mc config
    themselves, but MonteCarloEngine's constructor does a load_config() (DB)
    call by default — pass an explicit config so construction never touches
    the server DB.
    """
    engine = MonteCarloEngine(
        config=_build_engine_config(request.market_config, request.monte_carlo_config)
    )

    fire_number = engine.calculate_fire_number(
        annual_spending=request.annual_spending,
        withdrawal_rate=request.withdrawal_rate,
    )

    years_to_fire = engine.estimate_years_to_fire(
        current_balance=request.current_balance,
        monthly_contribution=request.monthly_contribution,
        fire_number=fire_number,
    )

    progress_pct = (request.current_balance / fire_number * 100) if fire_number > 0 else 0

    return FireResponse(
        fire_number=fire_number,
        years_to_fire=years_to_fire,
        current_balance=request.current_balance,
        monthly_contribution=request.monthly_contribution,
        progress_pct=min(progress_pct, 100),
    )


# ====================
# Account balances by type
# ====================


TAX_CATEGORY_MAP = {
    "taxable": "taxable", "brokerage": "taxable", "checking": "taxable",
    "savings": "taxable", "hysa": "taxable", "529": "taxable", "treasury_direct": "taxable",
    "traditional_401k": "traditional", "traditional_ira": "traditional",
    "401k": "traditional", "ira": "traditional", "pension": "traditional", "hsa": "traditional",
    "roth_401k": "roth", "roth_ira": "roth", "roth": "roth",
}


@router.post("/account-balances-by-type", response_model=AccountBalancesByTypeResponse)
def get_account_balances_by_type(payload: PortfolioPayload) -> AccountBalancesByTypeResponse:
    """Balances grouped by tax treatment, from payload accounts/positions.

    Reuses the same TAX_CATEGORY_MAP bucketing as v1 (src/api/projections.py).
    """
    positions = payload_to_raw_positions(payload)

    totals = {"taxable": 0.0, "traditional": 0.0, "roth": 0.0}
    account_totals: dict[str, dict] = {}

    for pos in positions:
        value = pos["market_value"]
        if not value:
            continue

        account_type_raw = (pos["account_type"] or "").lower().replace(" ", "_").replace("-", "_")
        tax_category = TAX_CATEGORY_MAP.get(account_type_raw, "taxable")

        if pos["is_retirement_account"] and tax_category == "taxable":
            tax_category = "traditional"

        totals[tax_category] += value

        account_id = pos["account_id"] or pos["account_name"]
        if account_id not in account_totals:
            account_totals[account_id] = {
                "name": pos["account_name"],
                "type": pos["account_type"],
                "tax_category": tax_category,
                "value": 0.0,
            }
        account_totals[account_id]["value"] += value

    return AccountBalancesByTypeResponse(
        taxable=round(totals["taxable"], 2),
        traditional=round(totals["traditional"], 2),
        roth=round(totals["roth"], 2),
        total=round(sum(totals.values()), 2),
        by_account=list(account_totals.values()),
    )


# ====================
# Withdrawal projections (balance required in body)
# ====================


class WithdrawalRequestV2(BaseModel):
    starting_balance: float = Field(..., ge=0, description="Starting balance (required in v2)")
    withdrawal_rate_or_amount: float
    is_percentage: bool = True
    start_age: int = Field(65, ge=30, le=100)
    end_age: int = Field(100, ge=50, le=120)
    expected_return: float = Field(0.06, ge=0, le=0.20)
    inflation_rate: float = Field(0.03, ge=0, le=0.10)
    adjust_for_inflation: bool = True


@router.post("/withdrawal-table", response_model=WithdrawalResponse)
def get_withdrawal_table(request: WithdrawalRequestV2) -> WithdrawalResponse:
    """Year-by-year withdrawal projection table. starting_balance required."""
    projection = WithdrawalProjection(
        expected_return=request.expected_return,
        inflation_rate=request.inflation_rate,
    )

    result = projection.project_withdrawals(
        starting_balance=request.starting_balance,
        withdrawal_rate_or_amount=request.withdrawal_rate_or_amount,
        is_percentage=request.is_percentage,
        start_age=request.start_age,
        end_age=request.end_age,
        adjust_for_inflation=request.adjust_for_inflation,
    )

    safe_rate = projection.find_safe_withdrawal_rate(
        starting_balance=request.starting_balance,
        start_age=request.start_age,
        end_age=request.end_age,
    )

    return WithdrawalResponse(
        rows=[
            WithdrawalYearResponse(
                year=row.year, age=row.age,
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


class WithdrawalComparisonRequestV2(BaseModel):
    starting_balance: float = Field(..., ge=0, description="Starting balance (required in v2)")
    start_age: int = 65
    end_age: int = 100
    expected_return: float = 0.06


@router.post("/withdrawal-comparison")
def compare_withdrawal_rates(request: WithdrawalComparisonRequestV2) -> dict[str, Any]:
    """Compare withdrawal rate scenarios. starting_balance required in body."""
    starting_balance = request.starting_balance

    if starting_balance == 0:
        return {"starting_balance": 0, "scenarios": {}, "message": "No portfolio balance to project"}

    projection = WithdrawalProjection(expected_return=request.expected_return)
    scenarios = projection.compare_scenarios(
        starting_balance=starting_balance,
        start_age=request.start_age,
        end_age=request.end_age,
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

    safe_rate = projection.find_safe_withdrawal_rate(
        starting_balance=starting_balance,
        start_age=request.start_age,
        end_age=request.end_age,
    )

    return {
        "starting_balance": starting_balance,
        "start_age": request.start_age,
        "end_age": request.end_age,
        "expected_return": request.expected_return,
        "safe_withdrawal_rate": f"{safe_rate * 100:.2f}%",
        "scenarios": results,
    }


class QuickProjectionRequestV2(BaseModel):
    current_age: int
    retirement_age: int
    monthly_contribution: float
    monthly_withdrawal: float
    current_balance: float = Field(..., ge=0, description="Current balance (required in v2)")
    market_config: Optional[dict] = Field(None)
    monte_carlo_config: Optional[dict] = Field(None)


@router.post("/quick-projection")
def quick_projection(request: QuickProjectionRequestV2) -> dict[str, Any]:
    """Quick projection. current_balance required in body (v1 takes it as a query param + DB fallback)."""
    params = ProjectionParams(
        current_age=request.current_age,
        retirement_age=request.retirement_age,
        current_balance=request.current_balance,
        monthly_contribution=request.monthly_contribution,
        monthly_withdrawal=request.monthly_withdrawal,
    )

    engine = MonteCarloEngine(
        config=_build_engine_config(request.market_config, request.monte_carlo_config)
    )
    result = engine.run_projection(params)

    return {
        "current_balance": request.current_balance,
        "success_rate": f"{result.success_rate * 100:.1f}%",
        "median_at_retirement": result.median_values[request.retirement_age - request.current_age],
        "median_final": result.median_final_value,
        "worst_case": result.worst_case_final,
        "best_case": result.best_case_final,
    }


# ====================
# Tax projection
# ====================


class BudgetIncomeContext(BaseModel):
    income_sources: list[IncomeSourcePayload] = Field(default_factory=list)
    deductions: list[DeductionPayload] = Field(default_factory=list)
    tax_config: Optional[TaxConfigPayload] = None


class TaxProjectionRequestV2(BaseModel):
    current_age: int = Field(..., ge=18, le=100)
    retirement_age: int = Field(..., ge=30, le=100)
    end_age: int = Field(95, ge=50, le=120)

    taxable_balance: float = Field(..., ge=0, description="Required in v2 (no DB fallback)")
    traditional_balance: float = Field(..., ge=0, description="Required in v2 (no DB fallback)")
    roth_balance: float = Field(..., ge=0, description="Required in v2 (no DB fallback)")

    annual_spending: float = Field(..., gt=0)

    monthly_contribution: float = Field(0, ge=0)
    contribution_to_traditional_pct: float = Field(0.60, ge=0, le=1.0)
    contribution_to_roth_pct: float = Field(0.25, ge=0, le=1.0)
    contribution_to_taxable_pct: float = Field(0.15, ge=0, le=1.0)

    expected_return: float = Field(0.06, ge=0, le=0.20)
    inflation_rate: float = Field(0.03, ge=0, le=0.10)

    federal_tax_rate: float = Field(0.22, ge=0, le=0.50)
    state_tax_rate: float = Field(0.05, ge=0, le=0.15)
    capital_gains_rate: float = Field(0.15, ge=0, le=0.30)
    cost_basis_ratio: float = Field(0.60, ge=0, le=1.0)

    use_budget_income: bool = Field(
        False,
        description="When true, pulls income from the embedded `budget` payload instead of manual fields."
    )
    manual_pre_retirement_income: float = Field(0.0, ge=0)
    manual_pre_retirement_deductions: float = Field(0.0, ge=0)
    filing_status: str = Field("single")
    state: str = Field("CA")

    budget: Optional[BudgetIncomeContext] = Field(
        None,
        description="Income sources/deductions/tax_config to use when use_budget_income is true."
    )


@router.post("/tax-projection")
def run_tax_projection(
    request: TaxProjectionRequestV2,
    http_request: Request,
    async_mode: bool = Query(default=None),
) -> Any:
    """Year-by-year tax-aware withdrawal projection. Balances required in body.

    When use_budget_income is true, income/deductions/tax_config come from
    the embedded `budget` payload instead of the DB (see
    compute_pre_retirement_income in src/api/projections.py, which is
    duck-typed and shared with v1).
    """
    filing_status = request.filing_status
    state = request.state

    if request.use_budget_income and request.budget:
        deductions_by_source: dict[Optional[str], list] = {}
        for ded in request.budget.deductions:
            deductions_by_source.setdefault(ded.income_source_id, []).append(ded)

        pre_retirement_income, pre_retirement_deductions, filing_status, state = compute_pre_retirement_income(
            income_sources=[s for s in request.budget.income_sources if s.is_active],
            deductions_by_source=deductions_by_source,
            request_state=state,
            request_filing_status=filing_status,
            tax_config=request.budget.tax_config,
        )
    else:
        pre_retirement_income = request.manual_pre_retirement_income
        pre_retirement_deductions = request.manual_pre_retirement_deductions

    use_async = async_mode if async_mode is not None else is_hosted_environment()

    task_params = {
        "taxable": request.taxable_balance,
        "traditional": request.traditional_balance,
        "roth": request.roth_balance,
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
        session_id = get_session_id(http_request)
        task_id = task_manager.submit(
            _run_tax_projection_task, task_params, session_id=session_id
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Tax projection started. Poll GET /api/tasks/{task_id} for results.",
        }

    result = _run_tax_projection_task(task_params)

    return TaxProjectionResponse(
        years=[TaxYearProjectionResponse(**y) for y in result["years"]],
        summary=TaxProjectionSummaryResponse(**result["summary"]),
        chart_data=result["chart_data"],
    )
