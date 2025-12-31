"""Analysis API endpoints."""

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from typing import Optional

from src.database import Database
from src.models import Portfolio, Account as PydanticAccount, Position as PydanticPosition
from src.models import AccountType, Brokerage
from src.analysis.performance import PerformanceAnalyzer, PortfolioPerformance
from src.analysis.risk import RiskAnalyzer, PortfolioRisk
from src.analysis.allocation import AllocationAnalyzer
from src.analysis.correlation import CorrelationAnalyzer

router = APIRouter(prefix="/api/analysis", tags=["analysis"])


def get_db() -> Database:
    """Dependency to get database instance."""
    return Database()


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


@router.get("/performance", response_model=PerformanceResponse)
def get_performance(
    benchmark: str = "SPY",
    db: Database = Depends(get_db),
) -> PerformanceResponse:
    """Get portfolio performance metrics."""
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

    analyzer = PerformanceAnalyzer()
    perf = analyzer.get_portfolio_performance(portfolio, benchmark)

    return PerformanceResponse(
        total_value=perf.total_value,
        total_cost_basis=perf.total_cost_basis,
        total_gain_loss=perf.total_gain_loss,
        total_gain_loss_pct=perf.total_gain_loss_pct,
        ytd_return=perf.ytd_return,
        one_year_return=perf.one_year_return,
        benchmark_ytd=perf.benchmark_ytd,
        benchmark_one_year=perf.benchmark_one_year,
        alpha_ytd=perf.alpha_ytd,
        alpha_one_year=perf.alpha_one_year,
    )


@router.get("/risk", response_model=RiskResponse)
def get_risk(
    benchmark: str = "SPY",
    db: Database = Depends(get_db),
) -> RiskResponse:
    """Get portfolio risk metrics."""
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

    analyzer = RiskAnalyzer()
    risk = analyzer.get_portfolio_risk(portfolio, benchmark)

    return RiskResponse(
        volatility=risk.volatility,
        sharpe_ratio=risk.sharpe_ratio,
        sortino_ratio=risk.sortino_ratio,
        max_drawdown=risk.max_drawdown,
        beta=risk.beta,
        var_95=risk.var_95,
        cvar_95=risk.cvar_95,
        diversification_ratio=risk.diversification_ratio,
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

    analyzer = AllocationAnalyzer()

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
    matrix = analyzer.get_correlation_matrix(tickers[:20])  # Limit to top 20

    if matrix is None or matrix.empty:
        return CorrelationResponse(
            tickers=tickers[:20],
            matrix=[],
            high_correlations=[],
            low_correlations=[],
        )

    # Convert to response format
    matrix_list = matrix.values.tolist()
    tickers_in_matrix = matrix.columns.tolist()

    # Find high and low correlations
    high_corr = []
    low_corr = []

    for i, t1 in enumerate(tickers_in_matrix):
        for j, t2 in enumerate(tickers_in_matrix):
            if i < j:  # Only upper triangle
                corr = matrix.iloc[i, j]
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

    # Initialize fund data service
    fund_service = FundDataService(cache_path="funds.yaml")

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
    if db.delete_trigger(trigger_id):
        return {"message": "Trigger deleted"}
    from fastapi import HTTPException
    raise HTTPException(status_code=404, detail="Trigger not found")


@router.put("/triggers/{trigger_id}/toggle")
def toggle_trigger(trigger_id: str, db: Database = Depends(get_db)):
    """Toggle a trigger's active status."""
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

    # Get Claude API key if available
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY) if request.use_claude else None

    # Create fund data service
    fund_service = FundDataService(
        cache_path="funds.yaml",
        claude_api_key=claude_key,
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

    # Get Claude API key
    secrets = SecretsManager(db)
    claude_key = secrets.get_api_key(secrets.ANTHROPIC_API_KEY)

    # Create fund data service
    fund_service = FundDataService(
        cache_path="funds.yaml",
        claude_api_key=claude_key,
    )

    # Analyze each fund
    results = []
    for ticker in fund_tickers[:10]:  # Limit to 10 funds to avoid rate limits
        try:
            composition = fund_service.get_fund_composition(
                ticker,
                use_claude=claude_key is not None,
            )
            if composition:
                results.append({
                    "ticker": composition.ticker,
                    "name": composition.name,
                    "morningstar_category": composition.morningstar_category,
                    "style": composition.style,
                    "region": composition.region,
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
        "claude_used": claude_key is not None,
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

    return {
        "success": result.success,
        "metrics": result.all_metrics,
        "insights": result.all_insights,
        "errors": result.errors,
        "plugins": [
            {
                "plugin_id": pr.plugin_id,
                "plugin_name": pr.plugin_name,
                "success": pr.result.success,
                "metrics": pr.result.metrics,
                "insights": pr.result.insights,
            }
            for pr in result.plugin_results
        ],
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
