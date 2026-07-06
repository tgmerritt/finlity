"""Stateless v2 analysis endpoints.

Body = PortfolioPayload (client-supplied) unless noted. No DB reads/writes
except cache-only fund-metadata lookups, price/quote fetches (keyed by
ticker), and API keys from environment variables.
"""

import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from src.api.analysis import (
    AllocationResponse,
    CorrelationEntry,
    CorrelationResponse,
    DataWarnings,
    DetailedAllocationResponse,
    AllocationRow,
    ExcludedPositionWarning,
    ExpenseDragHolding,
    ExpenseDragResponse,
    PerformanceResponse,
    RiskResponse,
    BENCHMARK_ER,
    _compute_expense_drag,
    _run_performance_task,
    _run_risk_task,
    _sanitize_float,
    is_hosted_environment,
)
from src.api.v2.payload import (
    ExcludedPosition,
    PortfolioPayload,
    payload_to_portfolio_with_warnings,
    payload_to_raw_positions,
    payload_to_advisor_portfolio_context,
)
from src.services.background_tasks import task_manager
from src.analysis.performance import PerformanceAnalyzer
from src.analysis.risk import RiskAnalyzer
from src.analysis.allocation import AllocationAnalyzer
from src.analysis.correlation import CorrelationAnalyzer

router = APIRouter(prefix="/api/v2/analysis", tags=["v2-analysis"])


def _data_warnings_from_excluded(excluded: list[ExcludedPosition]) -> Optional[DataWarnings]:
    """Build the additive DataWarnings response field from the adapter's
    excluded-positions list. Returns None (omit the field) when nothing was
    excluded, keeping the happy-path response shape unchanged."""
    if not excluded:
        return None
    return DataWarnings(
        excluded_positions=[
            ExcludedPositionWarning(
                ticker=e.ticker, account_name=e.account_name, reason=e.reason
            )
            for e in excluded
        ],
        count=len(excluded),
    )


def get_session_id(request: Request) -> str | None:
    """Get session ID from request state (set by SessionMiddleware)."""
    sid = getattr(request.state, "session_id", None)
    return sid if sid is None else str(sid)


@router.post("/allocation", response_model=AllocationResponse)
def get_allocation(payload: PortfolioPayload) -> AllocationResponse:
    """Portfolio allocation breakdown from client-supplied data."""
    portfolio, excluded = payload_to_portfolio_with_warnings(payload)
    data_warnings = _data_warnings_from_excluded(excluded)

    if not portfolio.accounts:
        return AllocationResponse(
            by_asset_class={},
            by_sector={},
            by_account_type={},
            by_brokerage={},
            concentration_top5=0,
            concentration_top10=0,
            data_warnings=data_warnings,
        )

    by_asset_class = {k.value: v * 100 for k, v in portfolio.get_allocation_by_asset_class().items()}
    by_sector = {k: v * 100 for k, v in portfolio.get_allocation_by_sector().items()}
    by_brokerage = {k.value: v * 100 for k, v in portfolio.get_allocation_by_brokerage().items()}

    by_account_type: dict[str, float] = {}
    total = portfolio.total_value
    if total > 0:
        for account in portfolio.accounts:
            at = account.account_type.value
            by_account_type[at] = by_account_type.get(at, 0) + (account.total_value / total * 100)

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
        data_warnings=data_warnings,
    )


@router.post("/allocation/detailed", response_model=DetailedAllocationResponse)
def get_detailed_allocation(payload: PortfolioPayload) -> DetailedAllocationResponse:
    """Detailed allocation breakdown matching xlsm format, from payload positions."""
    from src.services.fund_data import FundDataService

    positions = payload_to_raw_positions(payload)
    total_value: float = float(sum(p["market_value"] for p in positions))

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

    # Cache-only: no FMP key wiring in v2 (no app_settings table to read).
    fund_service = FundDataService(cache_path="funds.yaml")

    position_list: list[tuple[str, float, bool]] = []
    asset_class_values: dict[str, float] = {}
    position_type_values: dict[str, float] = {}
    cash_value: float = 0.0
    stock_value: float = 0.0
    fund_value: float = 0.0

    for pos in positions:
        value = pos["market_value"]
        is_fund = bool(pos["is_fund"] or (pos["position_type"] == "fund"))
        pos_type = pos["position_type"] or "equity"

        position_type_values[pos_type] = position_type_values.get(pos_type, 0) + value

        if pos_type == "cash" or pos["ticker"] == "CASH":
            cash_value += value
            continue

        asset_class = pos["asset_class"] or "equity"
        asset_class_values[asset_class] = asset_class_values.get(asset_class, 0) + value

        if is_fund:
            fund_value += value
        else:
            stock_value += value

        position_list.append((pos["ticker"], value, is_fund))

    sector_allocation = fund_service.calculate_weighted_allocation(position_list, 'sector')
    geography_allocation = fund_service.calculate_weighted_allocation(position_list, 'geography')
    cap_allocation = fund_service.calculate_weighted_allocation(position_list, 'cap')

    def build_allocation_rows(allocation: dict, total: float) -> list[AllocationRow]:
        rows = []
        for category, value in sorted(allocation.items(), key=lambda x: x[1], reverse=True):
            if value <= 0:
                continue
            pct = (value / total * 100) if total > 0 else 0
            rows.append(AllocationRow(
                name=category,
                stocks_bonds=0,
                funds=value,
                total=value,
                current_pct=round(pct, 2),
            ))
        return rows

    sector_rows = build_allocation_rows(sector_allocation, total_value)
    geography_rows = build_allocation_rows(geography_allocation, total_value)
    cap_rows = build_allocation_rows(cap_allocation, total_value)

    style_allocation: dict[str, float] = {}
    for ticker, value, is_fund in position_list:
        if value <= 0 or not is_fund:
            continue
        fund_data = fund_service.get_fund_raw_data(ticker)
        if fund_data:
            style = fund_data.get('style', 'blend') or 'blend'
            style_allocation[style.title()] = style_allocation.get(style.title(), 0) + value
        else:
            style_allocation['Blend'] = style_allocation.get('Blend', 0) + value

    if stock_value > 0:
        style_allocation['Blend'] = style_allocation.get('Blend', 0) + stock_value

    style_rows = build_allocation_rows(style_allocation, total_value)

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


@router.post("/expense-drag", response_model=ExpenseDragResponse)
def get_expense_drag(payload: PortfolioPayload) -> ExpenseDragResponse:
    """Portfolio expense-ratio drag vs SPY/VOO benchmark, from payload positions.

    Cache-only fund lookups (no live network calls), matching v1.
    """
    from src.services.fund_data import FundDataService

    positions = payload_to_raw_positions(payload)
    fund_service = FundDataService(cache_path="funds.yaml")

    positions_with_er: list[tuple[str, float, Optional[float]]] = []
    for pos in positions:
        value = pos["market_value"]
        if value <= 0:
            continue

        ticker_str = pos["ticker"]
        er: Optional[float] = None
        if pos["is_fund"] and ticker_str:
            cached = fund_service.get_from_cache(ticker_str)
            if cached and cached.expense_ratio is not None:
                er = float(cached.expense_ratio)
            else:
                raw = fund_service.get_fund_raw_data(ticker_str)
                if raw and raw.get("expense_ratio") is not None:
                    er = float(raw["expense_ratio"])

        positions_with_er.append((ticker_str, value, er))

    result = _compute_expense_drag(positions_with_er, benchmark_er=BENCHMARK_ER, top_n=5)

    return ExpenseDragResponse(
        portfolio_expense_ratio=_sanitize_float(result["portfolio_expense_ratio"]),
        benchmark_expense_ratio=_sanitize_float(result["benchmark_expense_ratio"]),
        annual_drag_dollars=_sanitize_float(result["annual_drag_dollars"]),
        annual_drag_basis_points=_sanitize_float(result["annual_drag_basis_points"]),
        covered_value=_sanitize_float(result["covered_value"]),
        uncovered_value=_sanitize_float(result["uncovered_value"]),
        top_drag_holdings=[
            ExpenseDragHolding(
                ticker=h["ticker"],
                position_value=_sanitize_float(h["position_value"]),
                expense_ratio=_sanitize_float(h["expense_ratio"]),
                annual_drag_dollars=_sanitize_float(h["annual_drag_dollars"]),
            )
            for h in result["top_drag_holdings"]
        ],
    )


@router.post("/suggestions")
def get_rebalancing_suggestions(payload: PortfolioPayload) -> dict:
    """Rebalancing suggestions based on target allocations (hardcoded defaults, same as v1)."""
    from datetime import date

    from src.models.targets import AllocationTargets

    portfolio, excluded = payload_to_portfolio_with_warnings(payload)
    data_warnings = _data_warnings_from_excluded(excluded)

    if not portfolio.accounts:
        return {
            "suggestions": [],
            "message": "No positions to analyze",
            "data_warnings": data_warnings.model_dump() if data_warnings else None,
        }

    # Explicit targets so AllocationAnalyzer never falls back to
    # AllocationTargets.from_config() -> load_config() -> get_database()
    # (the server's shared profile DB). Values match from_config's own
    # hardcoded fallbacks exactly (dob 1990-01-01, retirement_age 65,
    # class-default asset/sector/geography/style targets) — same pattern
    # as _build_engine_config in src/api/v2/projections.py.
    targets = AllocationTargets(dob=date(1990, 1, 1))
    analyzer = AllocationAnalyzer(targets=targets)
    suggestions = analyzer.get_rebalancing_suggestions(portfolio)

    return {
        "suggestions": [
            {
                "ticker": s.subcategory,
                "current_allocation": s.current_pct,
                "target_allocation": s.target_pct,
                "deviation": s.deviation_pct,
                "action": s.action,
                "amount": s.deviation_dollars,
            }
            for s in suggestions
        ],
        "total_value": portfolio.total_value,
        "data_warnings": data_warnings.model_dump() if data_warnings else None,
    }


@router.post("/performance")
def get_performance(
    payload: PortfolioPayload,
    request: Request,
    benchmark: str = "SPY",
    async_mode: bool = Query(
        default=None,
        description="Run in background. Defaults to True on Heroku, False locally."
    ),
) -> Any:
    """Portfolio performance metrics from client-supplied data. Supports async mode."""
    portfolio, excluded = payload_to_portfolio_with_warnings(payload)
    data_warnings = _data_warnings_from_excluded(excluded)

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
            data_warnings=data_warnings,
        )

    use_async = async_mode if async_mode is not None else is_hosted_environment()

    if use_async:
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
        data_warnings=data_warnings,
    )


@router.post("/risk")
def get_risk(
    payload: PortfolioPayload,
    request: Request,
    benchmark: str = "SPY",
    async_mode: bool = Query(
        default=None,
        description="Run in background. Defaults to True on Heroku, False locally."
    ),
) -> Any:
    """Portfolio risk metrics from client-supplied data. Supports async mode."""
    portfolio, excluded = payload_to_portfolio_with_warnings(payload)
    data_warnings = _data_warnings_from_excluded(excluded)

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
            data_warnings=data_warnings,
        )

    use_async = async_mode if async_mode is not None else is_hosted_environment()

    # Explicit config dict (never None) so RiskAnalyzer never falls back to
    # load_config() / the server's shared profile DB. Omitted keys use
    # RiskAnalyzer's own class defaults.
    risk_config = {"market": payload.market_config or {}}

    if use_async:
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
            _run_risk_task, portfolio_dict, benchmark, config=risk_config, session_id=session_id
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Risk analysis started. Poll GET /api/tasks/{task_id} for results.",
        }

    analyzer = RiskAnalyzer(config=risk_config)
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
        data_warnings=data_warnings,
    )


def _run_correlation_task(portfolio_dict: dict, min_positions: int) -> dict:
    """Background task for correlation analysis (v2 — no DB access)."""
    from src.models import Portfolio as _Portfolio, Account as _Account, Position as _Position, AccountType as _AccountType, Brokerage as _Brokerage

    portfolio = _Portfolio(
        accounts=[
            _Account(
                name=a["name"],
                account_type=_AccountType(a["account_type"]),
                brokerage=_Brokerage(a["brokerage"]) if a.get("brokerage") else _Brokerage.OTHER,
                positions=[_Position(**p) for p in a.get("positions", [])]
            )
            for a in portfolio_dict["accounts"]
        ]
    )

    tickers = list(set(p.ticker for p in portfolio.all_positions))
    if len(tickers) < min_positions:
        return {"tickers": tickers, "matrix": [], "high_correlations": [], "low_correlations": []}

    analyzer = CorrelationAnalyzer()
    corr_result = analyzer.calculate_correlation_matrix(portfolio, period="1y", min_weight=0.01)

    if corr_result is None:
        return {"tickers": tickers[:20], "matrix": [], "high_correlations": [], "low_correlations": []}

    matrix_list = corr_result.matrix
    tickers_in_matrix = corr_result.tickers

    high_corr = []
    low_corr = []
    for i, t1 in enumerate(tickers_in_matrix):
        for j, t2 in enumerate(tickers_in_matrix):
            if i < j:
                corr = matrix_list[i][j]
                entry = {"ticker1": t1, "ticker2": t2, "correlation": round(corr, 3)}
                if corr > 0.7:
                    high_corr.append(entry)
                elif corr < 0.0:
                    low_corr.append(entry)

    high_corr.sort(key=lambda x: x["correlation"], reverse=True)
    low_corr.sort(key=lambda x: x["correlation"])

    return {
        "tickers": tickers_in_matrix,
        "matrix": matrix_list,
        "high_correlations": high_corr[:10],
        "low_correlations": low_corr[:10],
    }


@router.post("/correlation")
def get_correlation(
    payload: PortfolioPayload,
    request: Request,
    min_positions: int = 2,
    async_mode: bool = Query(
        default=None,
        description="Run in background. Defaults to True on Heroku, False locally."
    ),
) -> Any:
    """Correlation matrix for payload positions. Supports async mode."""
    portfolio, excluded = payload_to_portfolio_with_warnings(payload)
    data_warnings = _data_warnings_from_excluded(excluded)
    tickers = list(set(p.ticker for p in portfolio.all_positions))

    use_async = async_mode if async_mode is not None else is_hosted_environment()

    if use_async:
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
            _run_correlation_task, portfolio_dict, min_positions, session_id=session_id
        )
        return {
            "task_id": task_id,
            "status": "pending",
            "message": "Correlation analysis started. Poll GET /api/tasks/{task_id} for results.",
        }

    if len(tickers) < min_positions:
        return CorrelationResponse(
            tickers=tickers, matrix=[], high_correlations=[], low_correlations=[],
            data_warnings=data_warnings,
        )

    analyzer = CorrelationAnalyzer()
    corr_result = analyzer.calculate_correlation_matrix(portfolio, period="1y", min_weight=0.01)

    if corr_result is None:
        return CorrelationResponse(
            tickers=tickers[:20], matrix=[], high_correlations=[], low_correlations=[],
            data_warnings=data_warnings,
        )

    matrix_list = corr_result.matrix
    tickers_in_matrix = corr_result.tickers

    high_corr = []
    low_corr = []
    for i, t1 in enumerate(tickers_in_matrix):
        for j, t2 in enumerate(tickers_in_matrix):
            if i < j:
                corr = matrix_list[i][j]
                entry = CorrelationEntry(ticker1=t1, ticker2=t2, correlation=round(corr, 3))
                if corr > 0.7:
                    high_corr.append(entry)
                elif corr < 0.0:
                    low_corr.append(entry)

    high_corr.sort(key=lambda x: x.correlation, reverse=True)
    low_corr.sort(key=lambda x: x.correlation)

    return CorrelationResponse(
        tickers=tickers_in_matrix,
        matrix=matrix_list,
        high_correlations=high_corr[:10],
        low_correlations=low_corr[:10],
        data_warnings=data_warnings,
    )


# ====================
# Advisor endpoints
# ====================


class AdvisorPortfolioAnalyzeRequest(BaseModel):
    portfolio: PortfolioPayload
    ticker: str
    fund_name: Optional[str] = None
    investor_age: Optional[int] = None
    risk_tolerance: Optional[str] = None


class AdvisorAnalysisResponse(BaseModel):
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


class AdvisorChatRequest(BaseModel):
    portfolio: PortfolioPayload
    message: str
    ticker: Optional[str] = None
    include_portfolio: bool = True
    history: Optional[list[dict]] = None


class AdvisorChatResponse(BaseModel):
    response: str
    history: list[dict]


def _get_env_claude_key() -> Optional[str]:
    """Get the Claude API key from environment variables only (no app_settings table)."""
    return os.environ.get("ANTHROPIC_API_KEY") or None


@router.post("/advisor/analyze", response_model=AdvisorAnalysisResponse)
def get_advisor_analysis(request: AdvisorPortfolioAnalyzeRequest) -> "AdvisorAnalysisResponse":
    """Financial advisor-style analysis of a fund, using an in-memory portfolio.

    API key comes from environment variable only. If missing, returns 400.
    """
    from src.services.advisor_analysis import AdvisorAnalysisService

    claude_key = _get_env_claude_key()
    if not claude_key:
        raise HTTPException(
            status_code=400,
            detail="Claude API key not configured. Set the ANTHROPIC_API_KEY environment variable.",
        )

    portfolio_context = payload_to_advisor_portfolio_context(request.portfolio)
    advisor = AdvisorAnalysisService(claude_api_key=claude_key, portfolio_context=portfolio_context)

    analysis = advisor.analyze_fund(
        ticker=request.ticker,
        fund_name=request.fund_name or "",
        investor_age=request.investor_age,
        risk_tolerance=request.risk_tolerance,
    )

    if not analysis:
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


@router.post("/advisor/chat", response_model=AdvisorChatResponse)
def chat_with_advisor(request: AdvisorChatRequest) -> "AdvisorChatResponse":
    """Stateless advisor chat turn: portfolio + message (+ optional history) in, response out.

    Unlike v1 (which keeps a module-level chat-service cache keyed by
    session), v2 is fully stateless: a fresh AdvisorAnalysisService is built
    per request from the payload, seeded with the caller-supplied history.
    """
    from src.services.advisor_analysis import AdvisorAnalysisService

    claude_key = _get_env_claude_key()
    if not claude_key:
        return AdvisorChatResponse(
            response="Claude API key not configured. Set the ANTHROPIC_API_KEY environment variable to use the advisor chat.",
            history=request.history or [],
        )

    portfolio_context = payload_to_advisor_portfolio_context(request.portfolio)
    advisor = AdvisorAnalysisService(claude_api_key=claude_key, portfolio_context=portfolio_context)
    if request.history:
        advisor.set_chat_history(request.history)

    response = advisor.chat(
        user_message=request.message,
        ticker=request.ticker,
        include_portfolio=request.include_portfolio,
    )

    return AdvisorChatResponse(
        response=response,
        history=advisor.get_chat_history(),
    )


@router.post("/advisor/chat/stream/v2")
def chat_with_advisor_stream(request: AdvisorChatRequest) -> StreamingResponse:
    """Streaming advisor chat.

    Mirrors v1's `/api/analysis/advisor/chat/stream` SSE format exactly
    (plain-text chunks with newlines escaped, terminated by `data: [DONE]`)
    so the existing frontend parser works unchanged.
    """
    from src.services.advisor_analysis import AdvisorAnalysisService

    claude_key = _get_env_claude_key()
    if not claude_key:
        def _no_key_stream() -> Any:
            yield "data: Claude API key not configured. Set the ANTHROPIC_API_KEY environment variable to use the advisor chat.\n\n"
            yield "data: [DONE]\n\n"
        return StreamingResponse(_no_key_stream(), media_type="text/event-stream")

    portfolio_context = payload_to_advisor_portfolio_context(request.portfolio)
    advisor = AdvisorAnalysisService(claude_api_key=claude_key, portfolio_context=portfolio_context)
    if request.history:
        advisor.set_chat_history(request.history)

    def generate() -> Any:
        try:
            for chunk in advisor.chat_stream(
                user_message=request.message,
                ticker=request.ticker,
                include_portfolio=request.include_portfolio,
            ):
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
        },
    )
