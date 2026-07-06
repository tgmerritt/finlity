"""Stateless v2 fund/sector endpoints (F3).

Mirrors v1's /api/analysis/fund/status and /api/analysis/fund/analyze
(src/api/analysis.py) but with AI/data-provider availability and API keys
determined from environment variables only — no `SecretsManager(db)`, no
`Depends(get_db)`. Writing the shared ticker-keyed funds.yaml cache is
allowed here: it's public fund metadata (expense ratio, sector breakdown,
Morningstar category), not user portfolio data.

/positions/sectors is the ticker-keyed counterpart for sector lookups used
by the frontend's position-enrichment flow, running the same multi-source
sector lookup as v1's `_get_sector_multi_source` (src/api/analysis.py:1350)
but sourcing Finnhub/Alpha Vantage keys from the environment only (no
SecretsManager/DB) — yfinance requires no key at all.
"""

import os
from typing import Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.api.analysis import (
    FundAnalysisResponse,
    _get_sector_from_alphavantage,
    _get_sector_from_finnhub,
    _get_sector_from_yfinance,
)

router = APIRouter(prefix="/api/v2", tags=["v2-fund"])

MAX_SECTOR_TICKERS = 100


def _get_env_claude_key() -> Optional[str]:
    """Claude API key from environment variables only (no app_settings table)."""
    return os.environ.get("ANTHROPIC_API_KEY") or None


def _get_env_fmp_key() -> Optional[str]:
    """Financial Modeling Prep API key from environment variables only."""
    return os.environ.get("FMP_API_KEY") or None


# ====================
# Fund status / analyze
# ====================


@router.get("/fund/status")
def get_fund_status() -> dict:
    """AI/data-provider availability for fund analysis, from environment
    keys only. Mirrors v1's GET /api/analysis/fund/status response shape."""
    has_key = _get_env_claude_key() is not None

    return {
        "claude_available": has_key,
        "api_key_source": "environment" if has_key else None,
        "features": {
            "fund_analysis": has_key,
            "sector_breakdown": has_key,
            "style_classification": has_key,
        },
    }


class FundAnalyzeRequestV2(BaseModel):
    ticker: str
    use_claude: bool = True


@router.post("/fund/analyze", response_model=FundAnalysisResponse)
def analyze_fund_v2(request: FundAnalyzeRequestV2) -> FundAnalysisResponse:
    """Analyze a fund using yfinance and optionally Claude, from env keys
    only. Mirrors v1's POST /api/analysis/fund/analyze response shape.

    Writing to the shared funds.yaml cache is allowed (public ticker-keyed
    fund metadata, not user data) — same cache v1 and v2's /fund-metadata
    and /allocation/detailed already read from.
    """
    from src.services.fund_data import FundDataService

    claude_key = _get_env_claude_key() if request.use_claude else None
    fmp_key = _get_env_fmp_key()

    fund_service = FundDataService(
        cache_path="funds.yaml",
        claude_api_key=claude_key,
        fmp_api_key=fmp_key,
    )

    composition = fund_service.get_fund_composition(
        request.ticker,
        use_claude=request.use_claude and claude_key is not None,
    )

    if not composition:
        raise HTTPException(
            status_code=404,
            detail=f"Could not find data for ticker {request.ticker}",
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


# ====================
# Sector lookup (ticker-keyed, no user data)
# ====================


def _get_sector_multi_source_env(ticker: str) -> tuple[Optional[str], str]:
    """Env-key-only counterpart to v1's `_get_sector_multi_source`
    (src/api/analysis.py:1350). Same source order (yfinance, then Finnhub,
    then Alpha Vantage) but never constructs a SecretsManager/touches the
    DB — API keys for Finnhub/Alpha Vantage come from the environment only.
    """
    sector = _get_sector_from_yfinance(ticker)
    if sector:
        return sector, "yfinance"

    finnhub_key = os.environ.get("FINNHUB_API_KEY")
    if finnhub_key:
        sector = _get_sector_from_finnhub(ticker, finnhub_key)
        if sector:
            return sector, "finnhub"

    av_key = os.environ.get("ALPHA_VANTAGE_API_KEY")
    if av_key:
        sector = _get_sector_from_alphavantage(ticker, av_key)
        if sector:
            return sector, "alphavantage"

    return None, "none"


class SectorsRequestV2(BaseModel):
    tickers: list[str] = Field(
        ..., description=f"Tickers to look up (capped at {MAX_SECTOR_TICKERS})"
    )


class SectorLookupError(BaseModel):
    ticker: str
    error: str


class SectorsResponseV2(BaseModel):
    sectors: dict[str, Optional[str]]
    errors: list[SectorLookupError]


@router.post("/positions/sectors", response_model=SectorsResponseV2)
def get_position_sectors(request: SectorsRequestV2) -> SectorsResponseV2:
    """Sector lookup for each ticker via the multi-source chain (yfinance,
    Finnhub, Alpha Vantage), env keys only. No DB access."""
    tickers = [t.strip().upper() for t in request.tickers if t and t.strip()][:MAX_SECTOR_TICKERS]

    sectors: dict[str, Optional[str]] = {}
    errors: list[SectorLookupError] = []

    for ticker in tickers:
        try:
            sector, _source = _get_sector_multi_source_env(ticker)
            sectors[ticker] = sector
        except Exception as e:
            sectors[ticker] = None
            errors.append(SectorLookupError(ticker=ticker, error=str(e)))

    return SectorsResponseV2(sectors=sectors, errors=errors)
