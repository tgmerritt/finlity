"""Analysis API endpoints."""

import os
from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import TYPE_CHECKING, Optional

if TYPE_CHECKING:
    from src.services.advisor_analysis import AdvisorAnalysisService

from src.database import Database
from src.services.background_tasks import task_manager
from src.models import Portfolio, Account as PydanticAccount, Position as PydanticPosition
from src.models import AccountType, Brokerage
from src.analysis.performance import PerformanceAnalyzer
from src.analysis.risk import RiskAnalyzer
from src.analysis.allocation import AllocationAnalyzer
from src.analysis.correlation import CorrelationAnalyzer

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


def is_hosted_environment() -> bool:
    """Check if running on Heroku or similar platform with request timeouts."""
    return bool(os.environ.get("DYNO"))


def get_session_id(request: Request) -> str | None:
    """Get session ID from request state (set by SessionMiddleware)."""
    return getattr(request.state, "session_id", None)


def get_db() -> Database:
    """Dependency to get database instance (profile-aware)."""
    from src.database import get_database
    return get_database()


def check_demo_mode_write():
    """Check if demo data modifications are protected.

    Uses centralized check from demo_mode service.
    Only blocks when BOTH demo mode AND PROTECT_DEMO_DATA env var are enabled.
    """
    from src.services.demo_mode import check_demo_data_protection
    check_demo_data_protection()


def db_to_portfolio(db: Database) -> Portfolio:
    """Convert database data to Portfolio model for analysis."""
    accounts = []

    for db_account in db.get_all_accounts():
        positions = []
        for db_pos in db.get_positions_by_account(db_account.id):
            # Skip positions without prices
            if not db_pos.current_price:
                continue

            positions.append(PydanticPosition(
                ticker=db_pos.ticker,
                name=db_pos.name or db_pos.ticker,
                shares=db_pos.shares,
                current_price=db_pos.current_price,
                cost_basis=db_pos.cost_basis,
                account_name=db_account.name,
                brokerage=Brokerage(db_account.brokerage) if db_account.brokerage in [b.value for b in Brokerage] else Brokerage.OTHER,
                sector=db_pos.sector,
                is_fund=db_pos.is_fund,
            ))

        if positions:
            # Map account type
            account_type_map = {
                "roth_ira": AccountType.ROTH_IRA,
                "traditional_ira": AccountType.TRADITIONAL_IRA,
                "traditional_401k": AccountType.TRADITIONAL_401K,
                "roth_401k": AccountType.ROTH_401K,
                "taxable": AccountType.TAXABLE,
                "hsa": AccountType.HSA,
            }
            account_type = account_type_map.get(db_account.account_type, AccountType.TAXABLE)

            accounts.append(PydanticAccount(
                name=db_account.name,
                account_type=account_type,
                brokerage=Brokerage(db_account.brokerage) if db_account.brokerage in [b.value for b in Brokerage] else Brokerage.OTHER,
                positions=positions,
            ))

    return Portfolio(accounts=accounts)


class PerformanceResponse(BaseModel):
    """Performance metrics response."""
    total_value: float
    total_cost_basis: Optional[float]
    total_gain_loss: Optional[float]
    total_gain_loss_pct: Optional[float]
    ytd_return: float
    one_year_return: float
    benchmark_ytd: float
    benchmark_one_year: float
    alpha_ytd: float
    alpha_one_year: float


class RiskResponse(BaseModel):
    """Risk metrics response."""
    volatility: float
    sharpe_ratio: float
    sortino_ratio: float
    max_drawdown: float
    beta: float
    var_95: float
    cvar_95: float
    diversification_ratio: float


class AllocationResponse(BaseModel):
    """Allocation analysis response."""
    by_asset_class: dict[str, float]
    by_sector: dict[str, float]
    by_account_type: dict[str, float]
    by_brokerage: dict[str, float]
    concentration_top5: float
    concentration_top10: float


class CorrelationEntry(BaseModel):
    """Single correlation entry."""
    ticker1: str
    ticker2: str
    correlation: float


class CorrelationResponse(BaseModel):
    """Correlation matrix response."""
    tickers: list[str]
    matrix: list[list[float]]
    high_correlations: list[CorrelationEntry]
    low_correlations: list[CorrelationEntry]


def _sanitize_float(value: float, default: float = 0.0) -> float:
    """Sanitize float values for JSON serialization (handle NaN, Inf)."""
    import math
    if value is None or math.isnan(value) or math.isinf(value):
        return default
    return value


def _run_performance_task(portfolio_dict: dict, benchmark: str) -> dict:
    """Background task for performance analysis."""
    import math

    def sanitize(value, default=0.0):
        if value is None or math.isnan(value) or math.isinf(value):
            return default
        return value

    # Reconstruct portfolio from dict
    portfolio = Portfolio(
        accounts=[
            PydanticAccount(
                id=a["id"],
                name=a["name"],
                account_type=AccountType(a["account_type"]),
                brokerage=Brokerage(a["brokerage"]) if a.get("brokerage") else None,
                positions=[
                    PydanticPosition(**p) for p in a.get("positions", [])
                ]
            )
            for a in portfolio_dict["accounts"]
        ]
    )

    analyzer = PerformanceAnalyzer()
    perf = analyzer.get_portfolio_performance(portfolio, benchmark)

    return {
        "total_value": sanitize(perf.total_value),
        "total_cost_basis": perf.total_cost_basis if perf.total_cost_basis is not None else None,
        "total_gain_loss": perf.total_gain_loss if perf.total_gain_loss is not None else None,
        "total_gain_loss_pct": sanitize(perf.total_gain_loss_pct) if perf.total_gain_loss_pct is not None else None,
        "ytd_return": sanitize(perf.ytd_return),
        "one_year_return": sanitize(perf.one_year_return),
        "benchmark_ytd": sanitize(perf.benchmark_ytd),
        "benchmark_one_year": sanitize(perf.benchmark_one_year),
        "alpha_ytd": sanitize(perf.alpha_ytd),
        "alpha_one_year": sanitize(perf.alpha_one_year),
    }


@router.get("/performance")
def get_performance(
    request: Request,
    benchmark: str = "SPY",
    async_mode: bool = Query(
        default=None,
        description="Run in background. Defaults to True on Heroku, False locally."
    ),
    db: Database = Depends(get_db),
):
    """Get portfolio performance metrics. Supports async mode for hosted platforms."""
    portfolio = db_to_portfolio(db)

    if not portfolio.accounts:
        return PerformanceResponse(
            total_value=0,
            total_cost_basis=None,
            total_gain_loss=None,
            total_gain_loss_pct=None,
            ytd_return=0,
            one_year_return=0,
            benchmark_ytd=0,
            benchmark_one_year=0,
            alpha_ytd=0,
            alpha_one_year=0,
        )

    # Determine if we should run async
    use_async = async_mode if async_mode is not None else is_hosted_environment()

    if use_async:
        # Convert portfolio to dict for background task
        portfolio_dict = {
            "accounts": [
                {
                    "name": a.name,
                    "account_type": a.account_type.value,
                    "brokerage": a.brokerage.value if a.brokerage else None,
                    "positions": [p.model_dump() for p in a.positions]
                }
                for a in portfolio.accounts
            ]
        }
        session_id = get_session_id(request)
        task_id = task_manager.submit(
            _run_performance_task, portfolio_dict, benchmark, session_id=session_id
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Performance analysis started. Poll GET /api/tasks/{task_id} for results.",
        }

    # Synchronous execution
    analyzer = PerformanceAnalyzer()
    perf = analyzer.get_portfolio_performance(portfolio, benchmark)

    return PerformanceResponse(
        total_value=_sanitize_float(perf.total_value),
        total_cost_basis=perf.total_cost_basis if perf.total_cost_basis is not None else None,
        total_gain_loss=perf.total_gain_loss if perf.total_gain_loss is not None else None,
        total_gain_loss_pct=_sanitize_float(perf.total_gain_loss_pct) if perf.total_gain_loss_pct is not None else None,
        ytd_return=_sanitize_float(perf.ytd_return),
        one_year_return=_sanitize_float(perf.one_year_return),
        benchmark_ytd=_sanitize_float(perf.benchmark_ytd),
        benchmark_one_year=_sanitize_float(perf.benchmark_one_year),
        alpha_ytd=_sanitize_float(perf.alpha_ytd),
        alpha_one_year=_sanitize_float(perf.alpha_one_year),
    )


def _run_risk_task(portfolio_dict: dict, benchmark: str) -> dict:
    """Background task for risk analysis."""
    import math

    def sanitize(value, default=0.0):
        if value is None or math.isnan(value) or math.isinf(value):
            return default
        return value

    # Reconstruct portfolio from dict
    portfolio = Portfolio(
        accounts=[
            PydanticAccount(
                id=a["id"],
                name=a["name"],
                account_type=AccountType(a["account_type"]),
                brokerage=Brokerage(a["brokerage"]) if a.get("brokerage") else None,
                positions=[
                    PydanticPosition(**p) for p in a.get("positions", [])
                ]
            )
            for a in portfolio_dict["accounts"]
        ]
    )

    analyzer = RiskAnalyzer()
    risk = analyzer.get_portfolio_risk(portfolio, benchmark)

    return {
        "volatility": sanitize(risk.volatility),
        "sharpe_ratio": sanitize(risk.sharpe_ratio),
        "sortino_ratio": sanitize(risk.sortino_ratio),
        "max_drawdown": sanitize(risk.max_drawdown),
        "beta": sanitize(risk.beta, 1.0),
        "var_95": sanitize(risk.var_95),
        "cvar_95": sanitize(risk.cvar_95),
        "diversification_ratio": sanitize(risk.diversification_ratio, 1.0),
    }


@router.get("/risk")
def get_risk(
    request: Request,
    benchmark: str = "SPY",
    async_mode: bool = Query(
        default=None,
        description="Run in background. Defaults to True on Heroku, False locally."
    ),
    db: Database = Depends(get_db),
):
    """Get portfolio risk metrics. Supports async mode for hosted platforms."""
    portfolio = db_to_portfolio(db)

    if not portfolio.accounts:
        return RiskResponse(
            volatility=0,
            sharpe_ratio=0,
            sortino_ratio=0,
            max_drawdown=0,
            beta=0,
            var_95=0,
            cvar_95=0,
            diversification_ratio=1.0,
        )

    # Determine if we should run async
    use_async = async_mode if async_mode is not None else is_hosted_environment()

    if use_async:
        # Convert portfolio to dict for background task
        portfolio_dict = {
            "accounts": [
                {
                    "name": a.name,
                    "account_type": a.account_type.value,
                    "brokerage": a.brokerage.value if a.brokerage else None,
                    "positions": [p.model_dump() for p in a.positions]
                }
                for a in portfolio.accounts
            ]
        }
        session_id = get_session_id(request)
        task_id = task_manager.submit(
            _run_risk_task, portfolio_dict, benchmark, session_id=session_id
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Risk analysis started. Poll GET /api/tasks/{task_id} for results.",
        }

    # Synchronous execution
    analyzer = RiskAnalyzer()
    risk = analyzer.get_portfolio_risk(portfolio, benchmark)

    return RiskResponse(
        volatility=_sanitize_float(risk.volatility),
        sharpe_ratio=_sanitize_float(risk.sharpe_ratio),
        sortino_ratio=_sanitize_float(risk.sortino_ratio),
        max_drawdown=_sanitize_float(risk.max_drawdown),
        beta=_sanitize_float(risk.beta, 1.0),
        var_95=_sanitize_float(risk.var_95),
        cvar_95=_sanitize_float(risk.cvar_95),
        diversification_ratio=_sanitize_float(risk.diversification_ratio, 1.0),
    )


@router.get("/allocation", response_model=AllocationResponse)
def get_allocation(db: Database = Depends(get_db)) -> AllocationResponse:
    """Get portfolio allocation breakdown."""
    portfolio = db_to_portfolio(db)

    if not portfolio.accounts:
        return AllocationResponse(
            by_asset_class={},
            by_sector={},
            by_account_type={},
            by_brokerage={},
            concentration_top5=0,
            concentration_top10=0,
        )

    # Get allocations
    by_asset_class = {k.value: v * 100 for k, v in portfolio.get_allocation_by_asset_class().items()}
    by_sector = {k: v * 100 for k, v in portfolio.get_allocation_by_sector().items()}
    by_brokerage = {k.value: v * 100 for k, v in portfolio.get_allocation_by_brokerage().items()}

    # Account type allocation
    by_account_type = {}
    total = portfolio.total_value
    if total > 0:
        for account in portfolio.accounts:
            at = account.account_type.value
            by_account_type[at] = by_account_type.get(at, 0) + (account.total_value / total * 100)

    # Concentration
    position_values = sorted(
        [p.market_value for p in portfolio.all_positions],
        reverse=True,
    )
    top5 = sum(position_values[:5]) / total * 100 if total > 0 and position_values else 0
    top10 = sum(position_values[:10]) / total * 100 if total > 0 and position_values else 0

    return AllocationResponse(
        by_asset_class=by_asset_class,
        by_sector=by_sector,
        by_account_type=by_account_type,
        by_brokerage=by_brokerage,
        concentration_top5=top5,
        concentration_top10=top10,
    )


@router.get("/correlation", response_model=CorrelationResponse)
def get_correlation(
    min_positions: int = 2,
    db: Database = Depends(get_db),
) -> CorrelationResponse:
    """Get correlation matrix for portfolio positions."""
    portfolio = db_to_portfolio(db)

    # Get unique tickers
    tickers = list(set(p.ticker for p in portfolio.all_positions))

    if len(tickers) < min_positions:
        return CorrelationResponse(
            tickers=tickers,
            matrix=[],
            high_correlations=[],
            low_correlations=[],
        )

    analyzer = CorrelationAnalyzer()
    # Use calculate_correlation_matrix which takes portfolio object
    corr_result = analyzer.calculate_correlation_matrix(portfolio, period="1y", min_weight=0.01)

    if corr_result is None:
        return CorrelationResponse(
            tickers=tickers[:20],
            matrix=[],
            high_correlations=[],
            low_correlations=[],
        )

    # Convert to response format
    matrix_list = corr_result.matrix
    tickers_in_matrix = corr_result.tickers

    # Find high and low correlations
    high_corr = []
    low_corr = []

    for i, t1 in enumerate(tickers_in_matrix):
        for j, t2 in enumerate(tickers_in_matrix):
            if i < j:  # Only upper triangle
                corr = matrix_list[i][j]
                entry = CorrelationEntry(ticker1=t1, ticker2=t2, correlation=round(corr, 3))
                if corr > 0.7:
                    high_corr.append(entry)
                elif corr < 0.0:
                    low_corr.append(entry)

    # Sort by correlation
    high_corr.sort(key=lambda x: x.correlation, reverse=True)
    low_corr.sort(key=lambda x: x.correlation)

    return CorrelationResponse(
        tickers=tickers_in_matrix,
        matrix=matrix_list,
        high_correlations=high_corr[:10],
        low_correlations=low_corr[:10],
    )


@router.get("/suggestions")
def get_rebalancing_suggestions(db: Database = Depends(get_db)):
    """Get rebalancing suggestions based on target allocations."""
    portfolio = db_to_portfolio(db)

    if not portfolio.accounts:
        return {"suggestions": [], "message": "No positions to analyze"}

    analyzer = AllocationAnalyzer()
    suggestions = analyzer.get_rebalancing_suggestions(portfolio)

    return {
        "suggestions": [
            {
                "ticker": s.ticker,
                "current_allocation": s.current_pct,
                "target_allocation": s.target_pct,
                "deviation": s.deviation,
                "action": s.action,
                "amount": s.amount,
            }
            for s in suggestions
        ],
        "total_value": portfolio.total_value,
    }


# ====================
# Detailed Allocation API (matching xlsm format)
# ====================

class AllocationRow(BaseModel):
    """Single row in allocation table."""
    name: str
    stocks_bonds: float  # Individual stocks/bonds value
    funds: float  # ETFs/mutual funds value
    total: float
    current_pct: float
    target_pct: Optional[float] = None
    deviation: Optional[float] = None


class DetailedAllocationResponse(BaseModel):
    """Detailed allocation breakdown matching xlsm format."""
    total_value: float
    by_sector: list[AllocationRow]
    by_geography: list[AllocationRow]
    by_cap: list[AllocationRow]
    by_style: list[AllocationRow]
    by_asset_class: list[AllocationRow]
    by_position_type: list[AllocationRow]
    cash_allocation: float
    invested_allocation: float


@router.get("/allocation/detailed", response_model=DetailedAllocationResponse)
def get_detailed_allocation(db: Database = Depends(get_db)) -> DetailedAllocationResponse:
    """Get detailed allocation breakdown matching xlsm format.

    Returns allocations broken down by:
    - Sector (Technology, Healthcare, etc.)
    - Geography (US, Foreign Developed, Emerging Markets)
    - Market Cap (Giant, Large, Mid, Small, Micro)
    - Style (Growth, Value, Blend)
    - Asset Class (Equity, Fixed Income, Cash, Alternative)
    - Position Type (Stocks, Funds, Cash, CDs, Bonds)
    """
    from src.services.fund_data import FundDataService
    from src.services.secrets import SecretsManager

    positions = db.get_all_positions()
    total_value = sum(
        (p.shares * p.current_price) if p.current_price else 0
        for p in positions
    )

    if total_value == 0:
        return DetailedAllocationResponse(
            total_value=0,
            by_sector=[],
            by_geography=[],
            by_cap=[],
            by_style=[],
            by_asset_class=[],
            by_position_type=[],
            cash_allocation=0,
            invested_allocation=0,
        )

    # Initialize fund data service with optional API keys for data enrichment
    secrets = SecretsManager(db)
    fmp_key = secrets.get_api_key(secrets.FMP_API_KEY)
    fund_service = FundDataService(cache_path="funds.yaml", fmp_api_key=fmp_key)

    # Build position list for weighted allocation calculation
    position_list = []
    asset_class_values = {}
    position_type_values = {}
    cash_value = 0
    stock_sector_values = {}  # For individual stocks
    stock_value = 0
    fund_value = 0

    for pos in positions:
        value = (pos.shares * pos.current_price) if pos.current_price else 0
        is_fund = pos.is_fund or (pos.position_type == "fund")
        pos_type = pos.position_type or "equity"

        # Track by position type
        position_type_values[pos_type] = position_type_values.get(pos_type, 0) + value

        # Track cash separately
        if pos_type == "cash" or pos.ticker == "CASH":
            cash_value += value
            continue

        # Track by asset class
        asset_class = pos.asset_class or "equity"
        asset_class_values[asset_class] = asset_class_values.get(asset_class, 0) + value

        # Track stock vs fund values
        if is_fund:
            fund_value += value
        else:
            stock_value += value
            # Track stock sectors
            sector = pos.sector or "Other"
            stock_sector_values[sector] = stock_sector_values.get(sector, 0) + value

        # Add to position list for fund allocation calculation
        position_list.append((pos.ticker, value, is_fund))

    # Calculate weighted allocations using fund data
    sector_allocation = fund_service.calculate_weighted_allocation(position_list, 'sector')
    geography_allocation = fund_service.calculate_weighted_allocation(position_list, 'geography')
    cap_allocation = fund_service.calculate_weighted_allocation(position_list, 'cap')

    # Build sector rows (combining weighted fund data with stock sectors)
    def build_allocation_rows(allocation: dict, total: float) -> list[AllocationRow]:
        """Build allocation rows from allocation dict."""
        rows = []
        for category, value in sorted(allocation.items(), key=lambda x: x[1], reverse=True):
            if value <= 0:
                continue
            pct = (value / total * 100) if total > 0 else 0
            rows.append(AllocationRow(
                name=category,
                stocks_bonds=0,  # We'll calculate this separately if needed
                funds=value,
                total=value,
                current_pct=round(pct, 2),
            ))
        return rows

    # Build sector rows
    sector_rows = build_allocation_rows(sector_allocation, total_value)

    # Build geography rows
    geography_rows = build_allocation_rows(geography_allocation, total_value)

    # Build market cap rows
    cap_rows = build_allocation_rows(cap_allocation, total_value)

    # Calculate style allocation based on fund metadata
    style_allocation = {}
    for ticker, value, is_fund in position_list:
        if value <= 0 or not is_fund:
            continue
        fund_data = fund_service.get_fund_raw_data(ticker)
        if fund_data:
            style = fund_data.get('style', 'blend') or 'blend'
            style_allocation[style.title()] = style_allocation.get(style.title(), 0) + value
        else:
            style_allocation['Blend'] = style_allocation.get('Blend', 0) + value

    # Add individual stocks to style (assume blend)
    if stock_value > 0:
        style_allocation['Blend'] = style_allocation.get('Blend', 0) + stock_value

    style_rows = build_allocation_rows(style_allocation, total_value)

    # Asset class rows
    asset_class_rows = []
    for ac, value in sorted(asset_class_values.items(), key=lambda x: x[1], reverse=True):
        pct = (value / total_value * 100) if total_value > 0 else 0
        asset_class_rows.append(AllocationRow(
            name=ac.replace("_", " ").title(),
            stocks_bonds=value if ac != "equity" else stock_value,
            funds=fund_value if ac == "equity" else 0,
            total=value,
            current_pct=round(pct, 2),
        ))

    # Position type rows
    pos_type_rows = []
    for pt, value in sorted(position_type_values.items(), key=lambda x: x[1], reverse=True):
        pct = (value / total_value * 100) if total_value > 0 else 0
        pos_type_rows.append(AllocationRow(
            name=pt.title(),
            stocks_bonds=value,
            funds=0,
            total=value,
            current_pct=round(pct, 2),
        ))

    invested_value = total_value - cash_value

    return DetailedAllocationResponse(
        total_value=total_value,
        by_sector=sector_rows,
        by_geography=geography_rows,
        by_cap=cap_rows,
        by_style=style_rows,
        by_asset_class=asset_class_rows,
        by_position_type=pos_type_rows,
        cash_allocation=round((cash_value / total_value * 100) if total_value > 0 else 0, 2),
        invested_allocation=round((invested_value / total_value * 100) if total_value > 0 else 0, 2),
    )


# ====================
# Trigger API Endpoints
# ====================

class TriggerRequest(BaseModel):
    """Request model for creating a trigger."""
    name: str
    condition_type: str
    operator: str
    threshold: float
    ticker: Optional[str] = None
    account_type: Optional[str] = None
    sector: Optional[str] = None


class TriggerResponse(BaseModel):
    """Response model for a trigger."""
    id: str
    name: str
    condition_type: str
    operator: str
    threshold: float
    ticker: Optional[str] = None
    account_type: Optional[str] = None
    sector: Optional[str] = None
    is_active: bool


class TriggerResultResponse(BaseModel):
    """Response model for trigger evaluation result."""
    trigger_id: str
    trigger_name: str
    triggered: bool
    current_value: float
    threshold: float
    operator: str
    condition_description: str
    message: str


@router.get("/triggers/types")
def get_trigger_types():
    """Get available trigger condition types."""
    from src.services.triggers import CONDITION_TYPES, TriggerEvaluator
    return {
        "condition_types": CONDITION_TYPES,
        "operators": TriggerEvaluator.get_operators(),
    }


@router.get("/triggers", response_model=list[TriggerResponse])
def get_triggers(active_only: bool = False, db: Database = Depends(get_db)):
    """Get all configured triggers."""
    triggers = db.get_all_triggers(active_only=active_only)
    return [
        TriggerResponse(
            id=t.id,
            name=t.name,
            condition_type=t.condition_type,
            operator=t.operator,
            threshold=t.threshold,
            ticker=t.ticker,
            account_type=t.account_type,
            sector=t.sector,
            is_active=t.is_active,
        )
        for t in triggers
    ]


@router.post("/triggers", response_model=TriggerResponse)
def create_trigger(request: TriggerRequest, db: Database = Depends(get_db)):
    """Create a new allocation trigger."""
    check_demo_mode_write()
    trigger = db.create_trigger(
        name=request.name,
        condition_type=request.condition_type,
        operator=request.operator,
        threshold=request.threshold,
        ticker=request.ticker,
        account_type=request.account_type,
        sector=request.sector,
    )
    return TriggerResponse(
        id=trigger.id,
        name=trigger.name,
        condition_type=trigger.condition_type,
        operator=trigger.operator,
        threshold=trigger.threshold,
        ticker=trigger.ticker,
        account_type=trigger.account_type,
        sector=trigger.sector,
        is_active=trigger.is_active,
    )


@router.delete("/triggers/{trigger_id}")
def delete_trigger(trigger_id: str, db: Database = Depends(get_db)):
    """Delete a trigger."""
    check_demo_mode_write()
    if db.delete_trigger(trigger_id):
        return {"message": "Trigger deleted"}
    from fastapi import HTTPException
    raise HTTPException(status_code=404, detail="Trigger not found")


@router.put("/triggers/{trigger_id}/toggle")
def toggle_trigger(trigger_id: str, db: Database = Depends(get_db)):
    """Toggle a trigger's active status."""
    check_demo_mode_write()
    trigger = db.get_trigger_by_id(trigger_id)
    if not trigger:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Trigger not found")

    updated = db.update_trigger(trigger_id, is_active=not trigger.is_active)
    return {"id": updated.id, "is_active": updated.is_active}


@router.get("/triggers/evaluate", response_model=list[TriggerResultResponse])
def evaluate_triggers(active_only: bool = True, db: Database = Depends(get_db)):
    """Evaluate all triggers and return results."""
    from src.services.triggers import TriggerEvaluator

    evaluator = TriggerEvaluator(db)
    results = evaluator.evaluate_all(active_only=active_only)

    return [
        TriggerResultResponse(
            trigger_id=r.trigger_id,
            trigger_name=r.trigger_name,
            triggered=r.triggered,
            current_value=r.current_value,
            threshold=r.threshold,
            operator=r.operator,
            condition_description=r.condition_description,
            message=r.message,
        )
        for r in results
    ]


@router.get("/triggers/triggered", response_model=list[TriggerResultResponse])
def get_triggered_alerts(db: Database = Depends(get_db)):
    """Get only triggers that are currently triggered (alerts)."""
    from src.services.triggers import TriggerEvaluator

    evaluator = TriggerEvaluator(db)
    results = evaluator.get_triggered()

    return [
        TriggerResultResponse(
            trigger_id=r.trigger_id,
            trigger_name=r.trigger_name,
            triggered=r.triggered,
            current_value=r.current_value,
            threshold=r.threshold,
            operator=r.operator,
            condition_description=r.condition_description,
            message=r.message,
        )
        for r in results
    ]


# ====================
# Fund Analysis API (Claude Integration)
# ====================

class FundAnalysisRequest(BaseModel):
    """Request model for fund analysis."""
    ticker: str
    use_claude: bool = True


class FundAnalysisResponse(BaseModel):
    """Response model for fund analysis."""
    ticker: str
    name: str
    morningstar_category: Optional[str] = None
    style: Optional[str] = None
    market_cap: Optional[str] = None
    region: Optional[str] = None
    expense_ratio: Optional[float] = None
    sector_breakdown: dict[str, float] = {}
    data_source: str
    claude_available: bool


@router.get("/fund/status")
def get_claude_status(db: Database = Depends(get_db)):
    """Check if Claude API is available for fund analysis."""
    from src.services.secrets import SecretsManager

    secrets = SecretsManager(db)
    has_key = secrets.has_api_key(secrets.ANTHROPIC_API_KEY)
    source = secrets.get_key_source(secrets.ANTHROPIC_API_KEY) if has_key else None

    return {
        "claude_available": has_key,
        "api_key_source": source,
        "features": {
            "fund_analysis": has_key,
            "sector_breakdown": has_key,
            "style_classification": has_key,
        }
    }


@router.post("/fund/analyze", response_model=FundAnalysisResponse)
def analyze_fund(request: FundAnalysisRequest, db: Database = Depends(get_db)):
    """Analyze a fund using yfinance and optionally Claude API."""
    from src.services.secrets import SecretsManager
    from src.services.fund_data import FundDataService

    # Get API keys if available
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY) if request.use_claude else None
    fmp_key = secrets.get_api_key(secrets.FMP_API_KEY)

    # Create fund data service
    fund_service = FundDataService(
        cache_path="funds.yaml",
        claude_api_key=claude_key,
        fmp_api_key=fmp_key,
    )

    # Get fund composition
    composition = fund_service.get_fund_composition(
        request.ticker,
        use_claude=request.use_claude and claude_key is not None,
    )

    if not composition:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=404,
            detail=f"Could not find data for ticker {request.ticker}"
        )

    return FundAnalysisResponse(
        ticker=composition.ticker,
        name=composition.name,
        morningstar_category=composition.morningstar_category,
        style=composition.style,
        market_cap=composition.market_cap,
        region=composition.region,
        expense_ratio=composition.expense_ratio,
        sector_breakdown=composition.sector_breakdown,
        data_source=composition.data_source,
        claude_available=claude_key is not None,
    )


@router.get("/fund/{ticker}", response_model=FundAnalysisResponse)
def get_fund_analysis(ticker: str, use_claude: bool = True, db: Database = Depends(get_db)):
    """Get fund analysis (GET endpoint for convenience)."""
    return analyze_fund(FundAnalysisRequest(ticker=ticker, use_claude=use_claude), db)


@router.post("/fund/analyze-portfolio")
def analyze_portfolio_funds(db: Database = Depends(get_db)):
    """Analyze all funds in the portfolio using Claude API."""
    from src.services.secrets import SecretsManager
    from src.services.fund_data import FundDataService

    # Get all positions
    positions = db.get_all_positions()

    # Get unique fund tickers (where is_fund=True)
    fund_tickers = list(set(
        p.ticker.upper() for p in positions
        if p.is_fund and p.ticker
    ))

    if not fund_tickers:
        return {"analyzed": [], "message": "No funds found in portfolio"}

    # Get API keys
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY)
    fmp_key = secrets.get_api_key(secrets.FMP_API_KEY)

    # Create fund data service
    fund_service = FundDataService(
        cache_path="funds.yaml",
        claude_api_key=claude_key,
        fmp_api_key=fmp_key,
    )

    # Analyze each fund and update positions with sector data
    results = []
    positions_updated = 0

    for ticker in fund_tickers[:10]:  # Limit to 10 funds to avoid rate limits
        try:
            composition = fund_service.get_fund_composition(
                ticker,
                use_claude=claude_key is not None,
            )
            if composition:
                # Determine primary sector from breakdown or category
                primary_sector = None
                if composition.sector_breakdown:
                    # Get the largest sector
                    primary_sector = max(
                        composition.sector_breakdown.items(),
                        key=lambda x: x[1]
                    )[0]
                elif composition.morningstar_category:
                    # Map category to sector (simplified)
                    category_lower = composition.morningstar_category.lower()
                    if "technology" in category_lower:
                        primary_sector = "Technology"
                    elif "healthcare" in category_lower or "health" in category_lower:
                        primary_sector = "Healthcare"
                    elif "financial" in category_lower:
                        primary_sector = "Financials"
                    elif "energy" in category_lower:
                        primary_sector = "Energy"
                    elif "real estate" in category_lower:
                        primary_sector = "Real Estate"
                    elif "consumer" in category_lower:
                        primary_sector = "Consumer"
                    elif "industrial" in category_lower:
                        primary_sector = "Industrials"
                    elif "blend" in category_lower or "growth" in category_lower or "value" in category_lower:
                        # Market index funds - use "Diversified"
                        primary_sector = "Diversified"

                # Update positions in database with sector info
                if primary_sector:
                    updated = db.update_positions_sector(ticker, primary_sector)
                    positions_updated += updated

                results.append({
                    "ticker": composition.ticker,
                    "name": composition.name,
                    "morningstar_category": composition.morningstar_category,
                    "style": composition.style,
                    "region": composition.region,
                    "sector_breakdown": composition.sector_breakdown,
                    "primary_sector": primary_sector,
                    "data_source": composition.data_source,
                })
        except Exception as e:
            results.append({
                "ticker": ticker,
                "error": str(e),
            })

    return {
        "analyzed": results,
        "total_funds": len(fund_tickers),
        "positions_updated": positions_updated,
        "claude_used": claude_key is not None,
    }


def _get_sector_from_yfinance(ticker: str) -> Optional[str]:
    """Try to get sector from yfinance."""
    try:
        import yfinance as yf
        stock = yf.Ticker(ticker)
        info = stock.info

        sector = info.get("sector")
        if sector:
            return sector

        # For ETFs/funds, try to determine from category
        category = info.get("category", "")
        if category:
            if "Technology" in category or "Tech" in category:
                return "Technology"
            elif "Health" in category:
                return "Healthcare"
            elif "Financial" in category or "Finance" in category:
                return "Financials"
            elif "Energy" in category:
                return "Energy"
            elif "Real Estate" in category or "REIT" in category:
                return "Real Estate"
            elif "Consumer" in category:
                return "Consumer"
            elif "Industrial" in category:
                return "Industrials"
            elif "Utilities" in category:
                return "Utilities"
            elif "Communication" in category or "Telecom" in category:
                return "Communication"
            elif "Materials" in category or "Basic" in category:
                return "Materials"
            elif "Blend" in category or "Index" in category or "Total" in category:
                return "Diversified"
            elif "Bond" in category or "Fixed" in category:
                return "Fixed Income"
            elif "International" in category or "Foreign" in category:
                return "International"
        return None
    except Exception:
        return None


def _get_sector_from_finnhub(ticker: str, api_key: str) -> Optional[str]:
    """Try to get sector from Finnhub company profile."""
    import requests
    try:
        url = "https://finnhub.io/api/v1/stock/profile2"
        params = {"symbol": ticker, "token": api_key}
        resp = requests.get(url, params=params, timeout=10)

        if resp.status_code == 429:
            return None  # Rate limited, let caller try another source

        if resp.status_code != 200:
            return None

        data = resp.json()
        sector = data.get("finnhubIndustry")
        if sector:
            # Map Finnhub industry to our sector categories
            sector_lower = sector.lower()
            if "technology" in sector_lower or "software" in sector_lower or "semiconductor" in sector_lower:
                return "Technology"
            elif "health" in sector_lower or "biotech" in sector_lower or "pharma" in sector_lower:
                return "Healthcare"
            elif "financial" in sector_lower or "bank" in sector_lower or "insurance" in sector_lower:
                return "Financials"
            elif "energy" in sector_lower or "oil" in sector_lower:
                return "Energy"
            elif "real estate" in sector_lower or "reit" in sector_lower:
                return "Real Estate"
            elif "consumer" in sector_lower or "retail" in sector_lower:
                return "Consumer"
            elif "industrial" in sector_lower or "manufacturing" in sector_lower:
                return "Industrials"
            elif "utility" in sector_lower or "utilities" in sector_lower:
                return "Utilities"
            elif "communication" in sector_lower or "media" in sector_lower or "telecom" in sector_lower:
                return "Communication"
            elif "material" in sector_lower or "chemical" in sector_lower or "mining" in sector_lower:
                return "Materials"
            else:
                return sector.title()  # Return as-is
        return None
    except Exception:
        return None


def _get_sector_from_alphavantage(ticker: str, api_key: str) -> Optional[str]:
    """Try to get sector from Alpha Vantage company overview."""
    import requests
    try:
        url = "https://www.alphavantage.co/query"
        params = {
            "function": "OVERVIEW",
            "symbol": ticker,
            "apikey": api_key,
        }
        resp = requests.get(url, params=params, timeout=10)

        if resp.status_code != 200:
            return None

        data = resp.json()

        # Check for rate limit message
        if "Note" in data:
            return None

        sector = data.get("Sector")
        if sector and sector != "None":
            return sector
        return None
    except Exception:
        return None


def _get_sector_multi_source(ticker: str, db: Database) -> tuple[Optional[str], str]:
    """
    Try multiple sources to get sector data.
    Returns (sector, source_name) or (None, "none").
    """
    from src.services.secrets import SecretsManager
    import os

    # Try yfinance first (no API key required)
    sector = _get_sector_from_yfinance(ticker)
    if sector:
        return sector, "yfinance"

    # Get API keys for other sources
    secrets = SecretsManager(db)

    # Try Finnhub
    finnhub_key = os.environ.get("FINNHUB_API_KEY") or secrets.get_api_key("finnhub")
    if finnhub_key:
        sector = _get_sector_from_finnhub(ticker, finnhub_key)
        if sector:
            return sector, "finnhub"

    # Try Alpha Vantage
    av_key = os.environ.get("ALPHA_VANTAGE_API_KEY") or secrets.get_api_key("alpha_vantage")
    if av_key:
        sector = _get_sector_from_alphavantage(ticker, av_key)
        if sector:
            return sector, "alphavantage"

    return None, "none"


@router.post("/positions/update-sectors")
def update_position_sectors(db: Database = Depends(get_db)):
    """Update sector data for all positions using multiple data sources."""
    check_demo_mode_write()
    positions = db.get_all_positions()

    # Get unique tickers that don't have sectors and are tradeable
    tickers_to_update = []
    for p in positions:
        if (
            p.ticker
            and not p.sector
            and not p.ticker.startswith(("CD-", "BOND-", "TBILL-", "IBOND-"))
            and p.ticker not in ("CASH", "CD", "MONEY", "RE")
        ):
            ticker = p.ticker.upper().replace("/", "-")
            if ticker not in tickers_to_update:
                tickers_to_update.append(ticker)

    if not tickers_to_update:
        return {"message": "All positions already have sectors", "updated": 0}

    results = []
    positions_updated = 0

    # Process in batches
    for ticker in tickers_to_update[:20]:  # Limit to 20 to avoid rate limits
        sector, source = _get_sector_multi_source(ticker, db)

        if sector:
            # Restore original ticker format for database update
            original_ticker = ticker.replace("-", "/") if "/" not in ticker else ticker
            # Try both formats
            updated = db.update_positions_sector(ticker, sector)
            if updated == 0:
                updated = db.update_positions_sector(original_ticker, sector)
            positions_updated += updated

            results.append({
                "ticker": ticker,
                "sector": sector,
                "source": source,
                "positions_updated": updated,
            })
        else:
            results.append({
                "ticker": ticker,
                "sector": None,
                "error": "Could not determine sector from any source",
            })

    return {
        "analyzed": results,
        "total_tickers": len(tickers_to_update),
        "positions_updated": positions_updated,
    }


# ====================
# Advisor Analysis API (Enhanced Claude Integration)
# ====================

class AdvisorAnalysisRequest(BaseModel):
    """Request model for advisor analysis."""
    ticker: str
    fund_name: Optional[str] = None
    investor_age: Optional[int] = None
    risk_tolerance: Optional[str] = None  # conservative, moderate, aggressive


class AdvisorAnalysisResponse(BaseModel):
    """Response model for advisor analysis."""
    ticker: str
    name: str
    summary: str
    advisor_commentary: str
    portfolio_fit: str
    overlaps: list[dict]
    tax_considerations: str
    risk_notes: str
    recommendations: list[str]
    data_source: str


class ChatRequest(BaseModel):
    """Request model for advisor chat."""
    message: str
    ticker: Optional[str] = None
    include_portfolio: bool = True


class ChatResponse(BaseModel):
    """Response model for advisor chat."""
    response: str
    history: list[dict]


class PageVisibleData(BaseModel):
    """Data visible on the current page."""
    portfolio_summary: Optional[dict] = None
    positions: Optional[list[dict]] = None
    allocation: Optional[dict] = None
    performance: Optional[dict] = None
    risk: Optional[dict] = None
    triggered_alerts: Optional[list[dict]] = None
    monte_carlo_params: Optional[dict] = None
    monte_carlo_results: Optional[dict] = None
    tax_projection: Optional[dict] = None


class PageContext(BaseModel):
    """Context from the current page/tab the user is viewing."""
    active_tab: str
    visible_data: PageVisibleData = PageVisibleData()
    selected_ticker: Optional[str] = None


class EnhancedChatRequest(BaseModel):
    """Request model for context-aware advisor chat."""
    message: str
    ticker: Optional[str] = None
    include_portfolio: bool = True
    page_context: Optional[PageContext] = None


@router.post("/advisor/analyze", response_model=AdvisorAnalysisResponse)
def get_advisor_analysis(request: AdvisorAnalysisRequest, db: Database = Depends(get_db)):
    """Get financial advisor-style analysis of a fund.

    This provides comprehensive analysis from a financial advisor's perspective,
    including portfolio fit, overlaps with existing holdings, tax considerations,
    and actionable recommendations.
    """
    from src.services.secrets import SecretsManager
    from src.services.advisor_analysis import AdvisorAnalysisService

    # Get Claude API key
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY)

    if not claude_key:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=400,
            detail="Claude API key not configured. Please add your API key in Settings."
        )

    # Create advisor service
    advisor = AdvisorAnalysisService(claude_api_key=claude_key, db=db)

    # Get analysis
    analysis = advisor.analyze_fund(
        ticker=request.ticker,
        fund_name=request.fund_name or "",
        investor_age=request.investor_age,
        risk_tolerance=request.risk_tolerance,
    )

    if not analysis:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=500,
            detail="Could not generate advisor analysis. Please try again."
        )

    return AdvisorAnalysisResponse(
        ticker=analysis.ticker,
        name=analysis.name,
        summary=analysis.summary,
        advisor_commentary=analysis.advisor_commentary,
        portfolio_fit=analysis.portfolio_fit,
        overlaps=analysis.overlaps,
        tax_considerations=analysis.tax_considerations,
        risk_notes=analysis.risk_notes,
        recommendations=analysis.recommendations,
        data_source=analysis.data_source,
    )


# Store chat service instances per session (simple in-memory for now)
_chat_services: dict[str, "AdvisorAnalysisService"] = {}
_chat_api_keys: dict[str, str] = {}  # Track which API key was used


@router.post("/advisor/chat", response_model=ChatResponse)
def chat_with_advisor(request: ChatRequest, db: Database = Depends(get_db)):
    """Have a conversation with the AI advisor about investments.

    The advisor has context about your portfolio and can answer follow-up
    questions about funds, allocation, and investment strategy.
    """
    from src.services.secrets import SecretsManager
    from src.services.advisor_analysis import AdvisorAnalysisService

    # Get Claude API key
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY)

    if not claude_key:
        return ChatResponse(
            response="Claude API key not configured. Please add your API key in Settings to use the advisor chat.",
            history=[],
        )

    # Get or create chat service (using a simple session key for now)
    # Recreate service if the API key changed (e.g., user added key after first attempt)
    session_key = "default"
    if session_key not in _chat_services or _chat_api_keys.get(session_key) != claude_key:
        _chat_services[session_key] = AdvisorAnalysisService(
            claude_api_key=claude_key, db=db
        )
        _chat_api_keys[session_key] = claude_key

    advisor = _chat_services[session_key]

    # Get response
    response = advisor.chat(
        user_message=request.message,
        ticker=request.ticker,
        include_portfolio=request.include_portfolio,
    )

    return ChatResponse(
        response=response,
        history=advisor.get_chat_history(),
    )


@router.post("/advisor/chat/stream")
def chat_with_advisor_stream(request: ChatRequest, db: Database = Depends(get_db)):
    """Stream a conversation with the AI advisor about investments.

    Returns a Server-Sent Events stream with text chunks as they arrive.
    """
    from src.services.secrets import SecretsManager
    from src.services.advisor_analysis import AdvisorAnalysisService

    # Get Claude API key
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY)

    if not claude_key:
        def error_stream():
            yield "data: Claude API key not configured. Please add your API key in Settings to use the advisor chat.\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream")

    # Get or create chat service
    session_key = "default"
    if session_key not in _chat_services or _chat_api_keys.get(session_key) != claude_key:
        _chat_services[session_key] = AdvisorAnalysisService(
            claude_api_key=claude_key, db=db
        )
        _chat_api_keys[session_key] = claude_key

    advisor = _chat_services[session_key]

    def generate():
        """Generate SSE stream from advisor response."""
        try:
            for chunk in advisor.chat_stream(
                user_message=request.message,
                ticker=request.ticker,
                include_portfolio=request.include_portfolio,
            ):
                # Escape newlines for SSE format
                escaped = chunk.replace("\n", "\\n")
                yield f"data: {escaped}\n\n"
            yield "data: [DONE]\n\n"
        except Exception as e:
            yield f"data: Error: {str(e)}\n\n"
            yield "data: [DONE]\n\n"

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


@router.post("/advisor/chat/clear")
def clear_chat_history():
    """Clear the advisor chat history."""
    global _chat_services
    _chat_services = {}
    return {"message": "Chat history cleared"}


@router.post("/advisor/chat/stream/v2")
def chat_with_advisor_stream_v2(request: EnhancedChatRequest, db: Database = Depends(get_db)):
    """Enhanced streaming chat with tool support and page context.

    This endpoint provides context-aware chat that:
    - Knows what page/tab the user is viewing
    - Has access to visible data on that page
    - Can call tools to query the database for more information

    Returns Server-Sent Events with different event types:
    - data: {"type": "text", "content": "..."} - Text chunks
    - data: {"type": "tool_start", "name": "...", "id": "..."} - Tool call starting
    - data: {"type": "tool_result", "name": "...", "result": {...}} - Tool result
    - data: {"type": "done"} - Stream complete
    - data: {"type": "error", "message": "..."} - Error
    """
    import json
    from src.services.secrets import SecretsManager
    from src.services.advisor_analysis import AdvisorAnalysisService

    # Get Claude API key
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY)

    if not claude_key:
        def error_stream():
            yield f'data: {json.dumps({"type": "error", "message": "Claude API key not configured. Please add your API key in Settings."})}\n\n'
        return StreamingResponse(error_stream(), media_type="text/event-stream")

    # Get or create chat service
    session_key = "default"
    if session_key not in _chat_services or _chat_api_keys.get(session_key) != claude_key:
        _chat_services[session_key] = AdvisorAnalysisService(
            claude_api_key=claude_key, db=db
        )
        _chat_api_keys[session_key] = claude_key

    advisor = _chat_services[session_key]

    # Convert PageContext to dict for the service
    page_context_dict = None
    if request.page_context:
        page_context_dict = {
            "active_tab": request.page_context.active_tab,
            "visible_data": request.page_context.visible_data.model_dump() if request.page_context.visible_data else {},
            "selected_ticker": request.page_context.selected_ticker,
        }

    def generate():
        """Generate SSE stream from advisor response with tool support."""
        try:
            for event in advisor.chat_stream_with_tools(
                user_message=request.message,
                ticker=request.ticker,
                include_portfolio=request.include_portfolio,
                page_context=page_context_dict,
            ):
                yield f"data: {json.dumps(event)}\n\n"
        except Exception as e:
            yield f'data: {json.dumps({"type": "error", "message": str(e)})}\n\n'

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )


# ====================
# Plugin Analysis API
# ====================

@router.get("/plugins")
def run_plugin_analysis(db: Database = Depends(get_db)):
    """
    Run all enabled analysis plugins on the current portfolio.

    This endpoint fetches portfolio data from the database and runs all
    enabled analysis plugins (Tax-Loss Harvester, Dividend Tracker, etc.)
    """
    from src.plugins import get_plugin_registry, get_analysis_pipeline

    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_analysis_pipeline()

    # Get portfolio data from database
    positions = []
    accounts = []

    for db_account in db.get_all_accounts():
        # Add account info
        accounts.append({
            "id": db_account.id,
            "name": db_account.name,
            "account_type": db_account.account_type,
            "brokerage": db_account.brokerage,
            "is_retirement": db_account.account_type in [
                "traditional_401k", "roth_401k", "traditional_ira", "roth_ira",
                "hsa", "pension", "sep_ira", "simple_ira",
            ],
        })

        # Add positions for this account
        for db_pos in db.get_positions_by_account(db_account.id):
            positions.append({
                "ticker": db_pos.ticker,
                "name": db_pos.name,
                "shares": db_pos.shares,
                "current_price": db_pos.current_price,
                "cost_basis": db_pos.cost_basis,
                "is_fund": db_pos.is_fund,
                "sector": db_pos.sector,
                "account_id": db_account.id,
                "account_name": db_account.name,
                "account_type": db_account.account_type,
            })

    # Run analysis plugins
    result = pipeline.run_all(positions, accounts)

    # Deduplicate plugin results by plugin_id
    seen_plugins = set()
    deduplicated_plugins = []
    for pr in result.plugin_results:
        if pr.plugin_id not in seen_plugins:
            seen_plugins.add(pr.plugin_id)
            deduplicated_plugins.append({
                "plugin_id": pr.plugin_id,
                "plugin_name": pr.plugin_name,
                "success": pr.result.success,
                "metrics": pr.result.metrics,
                "insights": pr.result.insights,
            })

    return {
        "success": result.success,
        "metrics": result.all_metrics,
        "insights": result.all_insights,
        "errors": result.errors,
        "plugins": deduplicated_plugins,
        "position_count": len(positions),
        "account_count": len(accounts),
    }


@router.get("/plugins/{plugin_id}")
def run_single_plugin_analysis(plugin_id: str, db: Database = Depends(get_db)):
    """
    Run a specific analysis plugin on the current portfolio.

    Args:
        plugin_id: ID of the analysis plugin to run (e.g., "tax-loss-harvester")
    """
    from src.plugins import get_plugin_registry, get_analysis_pipeline
    from fastapi import HTTPException

    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_analysis_pipeline()

    # Get portfolio data from database
    positions = []
    accounts = []

    for db_account in db.get_all_accounts():
        accounts.append({
            "id": db_account.id,
            "name": db_account.name,
            "account_type": db_account.account_type,
            "brokerage": db_account.brokerage,
            "is_retirement": db_account.account_type in [
                "traditional_401k", "roth_401k", "traditional_ira", "roth_ira",
                "hsa", "pension", "sep_ira", "simple_ira",
            ],
        })

        for db_pos in db.get_positions_by_account(db_account.id):
            positions.append({
                "ticker": db_pos.ticker,
                "name": db_pos.name,
                "shares": db_pos.shares,
                "current_price": db_pos.current_price,
                "cost_basis": db_pos.cost_basis,
                "is_fund": db_pos.is_fund,
                "sector": db_pos.sector,
                "account_id": db_account.id,
                "account_name": db_account.name,
                "account_type": db_account.account_type,
            })

    # Run specific plugin
    result = pipeline.run_plugin(plugin_id, positions, accounts)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Analysis plugin not found: {plugin_id}"
        )

    return {
        "plugin_id": plugin_id,
        "success": result.success,
        "metrics": result.metrics,
        "insights": result.insights,
        "warnings": result.warnings,
        "errors": result.errors,
    }


@router.get("/widgets")
def render_widgets(db: Database = Depends(get_db)):
    """
    Render all enabled widget plugins with current portfolio data.

    This endpoint fetches portfolio data from the database and renders all
    enabled widget plugins (Correlation Heatmap, Sector Treemap, etc.)
    """
    from src.plugins import get_plugin_registry, get_widget_pipeline
    from src.services.fund_data import FundDataService
    from src.services.secrets import SecretsManager

    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_widget_pipeline()

    # Initialize fund data service for sector enrichment
    secrets = SecretsManager(db)
    fmp_key = secrets.get_api_key(secrets.FMP_API_KEY)
    fund_service = FundDataService(cache_path="funds.yaml", fmp_api_key=fmp_key)

    # Get portfolio data from database
    positions = []
    accounts = []

    for db_account in db.get_all_accounts():
        # Add account info
        accounts.append({
            "id": db_account.id,
            "name": db_account.name,
            "account_type": db_account.account_type,
            "brokerage": db_account.brokerage,
            "is_retirement": db_account.account_type in [
                "traditional_401k", "roth_401k", "traditional_ira", "roth_ira",
                "hsa", "pension", "sep_ira", "simple_ira",
            ],
        })

        # Add positions with sector enrichment (using only fast cached lookups)
        for db_pos in db.get_positions_by_account(db_account.id):
            sector = db_pos.sector or "Other"
            # For funds with no sector, try FundDataService cache (fast local lookup)
            if sector.lower() == "other" and db_pos.is_fund:
                fund_data = fund_service.get_fund_raw_data(db_pos.ticker)
                if fund_data:
                    sector_breakdown = fund_data.get("sector_breakdown", {})
                    if sector_breakdown:
                        sector = max(sector_breakdown, key=sector_breakdown.get)

            positions.append({
                "ticker": db_pos.ticker,
                "name": db_pos.name or db_pos.ticker,
                "shares": db_pos.shares,
                "current_price": db_pos.current_price,
                "cost_basis": db_pos.cost_basis,
                "sector": sector or "Other",
                "asset_class": db_pos.asset_class,
                "is_fund": db_pos.is_fund,
                "position_type": db_pos.position_type,
                "account_id": db_account.id,
                "account_name": db_account.name,
                "account_type": db_account.account_type,
            })

    # Run all widgets
    result = pipeline.render_all(positions, accounts)

    return result.to_dict()


@router.get("/widgets/{plugin_id}")
def render_single_widget(plugin_id: str, db: Database = Depends(get_db)):
    """
    Render a specific widget plugin with current portfolio data.

    Args:
        plugin_id: ID of the widget plugin to render (e.g., "correlation-heatmap")
    """
    from src.plugins import get_plugin_registry, get_widget_pipeline
    from src.services.fund_data import FundDataService
    from src.services.secrets import SecretsManager
    from fastapi import HTTPException

    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_widget_pipeline()

    # Initialize fund data service for sector enrichment
    secrets = SecretsManager(db)
    fmp_key = secrets.get_api_key(secrets.FMP_API_KEY)
    fund_service = FundDataService(cache_path="funds.yaml", fmp_api_key=fmp_key)

    # Get portfolio data from database
    positions = []
    accounts = []

    for db_account in db.get_all_accounts():
        accounts.append({
            "id": db_account.id,
            "name": db_account.name,
            "account_type": db_account.account_type,
            "brokerage": db_account.brokerage,
            "is_retirement": db_account.account_type in [
                "traditional_401k", "roth_401k", "traditional_ira", "roth_ira",
                "hsa", "pension", "sep_ira", "simple_ira",
            ],
        })

        # Add positions with sector enrichment (using only fast cached lookups)
        for db_pos in db.get_positions_by_account(db_account.id):
            sector = db_pos.sector or "Other"
            # For funds with no sector, try FundDataService cache (fast local lookup)
            if sector.lower() == "other" and db_pos.is_fund:
                fund_data = fund_service.get_fund_raw_data(db_pos.ticker)
                if fund_data:
                    sector_breakdown = fund_data.get("sector_breakdown", {})
                    if sector_breakdown:
                        sector = max(sector_breakdown, key=sector_breakdown.get)

            positions.append({
                "ticker": db_pos.ticker,
                "name": db_pos.name or db_pos.ticker,
                "shares": db_pos.shares,
                "current_price": db_pos.current_price,
                "cost_basis": db_pos.cost_basis,
                "sector": sector or "Other",
                "asset_class": db_pos.asset_class,
                "is_fund": db_pos.is_fund,
                "position_type": db_pos.position_type,
                "account_id": db_account.id,
                "account_name": db_account.name,
                "account_type": db_account.account_type,
            })

    # Render specific widget
    result = pipeline.render_widget(plugin_id, positions, accounts)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Widget plugin not found: {plugin_id}"
        )

    return {
        "plugin_id": result.plugin_id,
        "plugin_name": result.plugin_name,
        "config": {
            "title": result.config.title,
            "default_width": result.config.default_width,
            "default_height": result.config.default_height,
            "refresh_interval": result.config.refresh_interval,
        } if result.config else None,
        "content": {
            "html": result.content.html,
            "data": result.content.data,
            "scripts": result.content.scripts,
            "styles": result.content.styles,
        } if result.content else None,
        "success": result.success,
        "error": result.error,
    }
