"""Stateless v2 price and fund-metadata endpoints.

/prices calls PriceService.get_current_price per ticker (its own file cache
+ SKIP_PRICE_LOOKUP rules apply) but never calls db.update_price_cache — no
DB is involved at all in this path (PriceService is DB-free).

/fund-metadata is cache-only: funds.yaml lookups via FundDataService,
no Claude/yfinance network calls.
"""

from typing import Optional

from fastapi import APIRouter, Query
from pydantic import BaseModel

from src.data.prices import PriceService

router = APIRouter(prefix="/api/v2", tags=["v2-prices"])

MAX_TICKERS = 100


class PriceEntry(BaseModel):
    ticker: str
    current_price: float
    previous_close: Optional[float] = None
    year_high: Optional[float] = None
    year_low: Optional[float] = None
    fetched_at: str


class PriceError(BaseModel):
    ticker: str
    error: str


class PricesResponse(BaseModel):
    prices: list[PriceEntry]
    errors: list[PriceError]


@router.get("/prices", response_model=PricesResponse)
def get_prices(
    tickers: str = Query(..., description="Comma-separated list of tickers, max 100"),
) -> PricesResponse:
    """Current price/quote for each ticker. No DB writes (PriceService has none)."""
    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if len(ticker_list) > MAX_TICKERS:
        ticker_list = ticker_list[:MAX_TICKERS]

    service = PriceService()

    prices: list[PriceEntry] = []
    errors: list[PriceError] = []

    for ticker in ticker_list:
        try:
            data = service.get_current_price(ticker)
            if data is None:
                errors.append(PriceError(ticker=ticker, error="No price data available"))
                continue
            prices.append(PriceEntry(
                ticker=data.ticker,
                current_price=data.current_price,
                previous_close=data.previous_close,
                year_high=data.year_high,
                year_low=data.year_low,
                fetched_at=data.last_updated.isoformat(),
            ))
        except Exception as e:
            errors.append(PriceError(ticker=ticker, error=str(e)))

    return PricesResponse(prices=prices, errors=errors)


class FundMetadataEntry(BaseModel):
    ticker: str
    name: str
    morningstar_category: Optional[str] = None
    style: Optional[str] = None
    market_cap: Optional[str] = None
    region: Optional[str] = None
    expense_ratio: Optional[float] = None
    sector_breakdown: dict[str, float] = {}
    data_source: str


class FundMetadataResponse(BaseModel):
    funds: list[FundMetadataEntry]
    not_found: list[str]


@router.get("/fund-metadata", response_model=FundMetadataResponse)
def get_fund_metadata(
    tickers: str = Query(..., description="Comma-separated list of tickers, max 100"),
) -> FundMetadataResponse:
    """funds.yaml cache entries per ticker. Cache-only — no Claude/yfinance calls."""
    from src.services.fund_data import FundDataService

    ticker_list = [t.strip().upper() for t in tickers.split(",") if t.strip()]
    if len(ticker_list) > MAX_TICKERS:
        ticker_list = ticker_list[:MAX_TICKERS]

    fund_service = FundDataService(cache_path="funds.yaml")

    funds: list[FundMetadataEntry] = []
    not_found: list[str] = []

    for ticker in ticker_list:
        composition = fund_service.get_from_cache(ticker)
        if composition is None:
            not_found.append(ticker)
            continue
        funds.append(FundMetadataEntry(
            ticker=composition.ticker,
            name=composition.name,
            morningstar_category=composition.morningstar_category,
            style=composition.style,
            market_cap=composition.market_cap,
            region=composition.region,
            expense_ratio=composition.expense_ratio,
            sector_breakdown=composition.sector_breakdown,
            data_source=composition.data_source,
        ))

    return FundMetadataResponse(funds=funds, not_found=not_found)
