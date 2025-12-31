"""Fund data retrieval service with Claude API fallback."""

import json
import logging
from dataclasses import dataclass, field
from typing import Optional

import yaml
from pathlib import Path

logger = logging.getLogger(__name__)


@dataclass
class FundComposition:
    """Fund composition and metadata."""

    ticker: str
    name: str = ""
    morningstar_category: Optional[str] = None
    style: Optional[str] = None  # growth, value, blend
    market_cap: Optional[str] = None  # large, mid, small, multi
    region: Optional[str] = None  # us, foreign_developed, emerging, global
    expense_ratio: Optional[float] = None
    sector_breakdown: dict[str, float] = field(default_factory=dict)
    top_holdings: list[dict] = field(default_factory=list)
    data_source: str = "unknown"  # yfinance, cache, claude


class FundDataService:
    """Retrieves fund composition data from multiple sources.

    Data sources are tried in this order:
    1. Local cache (funds.yaml)
    2. yfinance for basic data
    3. Claude API for enrichment/analysis (if API key available)
    """

    def __init__(
        self,
        cache_path: str = "funds.yaml",
        claude_api_key: Optional[str] = None,
    ):
        """Initialize fund data service.

        Args:
            cache_path: Path to the local fund cache file
            claude_api_key: Optional Anthropic API key for Claude queries
        """
        self.cache_path = Path(cache_path)
        self.claude_api_key = claude_api_key
        self._client = None
        self._cache: dict = {}
        self._load_cache()

    def _load_cache(self) -> None:
        """Load fund data cache from file."""
        if self.cache_path.exists():
            try:
                with open(self.cache_path) as f:
                    data = yaml.safe_load(f) or {}
                    self._cache = data.get("funds", {})
            except Exception as e:
                logger.warning(f"Could not load fund cache: {e}")
                self._cache = {}

    def _save_cache(self) -> None:
        """Save fund data cache to file."""
        try:
            # Load existing file to preserve other data
            existing = {}
            if self.cache_path.exists():
                with open(self.cache_path) as f:
                    existing = yaml.safe_load(f) or {}

            existing["funds"] = self._cache

            with open(self.cache_path, "w") as f:
                yaml.dump(existing, f, default_flow_style=False, sort_keys=False)
        except Exception as e:
            logger.warning(f"Could not save fund cache: {e}")

    def _get_claude_client(self):
        """Get or create Anthropic client."""
        if self._client is None and self.claude_api_key:
            try:
                from anthropic import Anthropic

                self._client = Anthropic(api_key=self.claude_api_key)
            except ImportError:
                logger.warning("anthropic package not installed")
                return None
        return self._client

    def get_from_cache(self, ticker: str) -> Optional[FundComposition]:
        """Get fund data from local cache."""
        ticker = ticker.upper()
        if ticker in self._cache:
            data = self._cache[ticker]
            return FundComposition(
                ticker=ticker,
                name=data.get("name", ""),
                morningstar_category=data.get("morningstar_category"),
                style=data.get("style"),
                market_cap=data.get("market_cap"),
                region=data.get("region"),
                expense_ratio=data.get("expense_ratio"),
                sector_breakdown=data.get("sector_breakdown", {}),
                top_holdings=data.get("top_holdings", []),
                data_source="cache",
            )
        return None

    def get_from_yfinance(self, ticker: str) -> Optional[FundComposition]:
        """Get basic fund data from yfinance."""
        try:
            import yfinance as yf

            stock = yf.Ticker(ticker)
            info = stock.info

            if not info or "shortName" not in info:
                return None

            # Try to extract sector information
            sector_breakdown = {}
            try:
                # For ETFs/funds, yfinance sometimes has sector weights
                sector_weights = getattr(stock, "sector_weightings", None)
                if sector_weights:
                    sector_breakdown = {
                        sector: weight * 100
                        for sector, weight in sector_weights.items()
                    }
            except Exception:
                pass

            return FundComposition(
                ticker=ticker.upper(),
                name=info.get("shortName", info.get("longName", "")),
                morningstar_category=info.get("category"),
                expense_ratio=info.get("annualReportExpenseRatio"),
                sector_breakdown=sector_breakdown,
                data_source="yfinance",
            )
        except ImportError:
            logger.warning("yfinance package not installed")
            return None
        except Exception as e:
            logger.warning(f"Could not fetch yfinance data for {ticker}: {e}")
            return None

    def enrich_with_claude(
        self, ticker: str, basic_data: Optional[FundComposition] = None
    ) -> Optional[FundComposition]:
        """Use Claude API to analyze and categorize a fund.

        Args:
            ticker: Fund ticker symbol
            basic_data: Existing data to enrich

        Returns:
            Enriched FundComposition or None if not available
        """
        client = self._get_claude_client()
        if not client:
            return basic_data

        name = basic_data.name if basic_data else ticker

        prompt = f"""Analyze this investment fund and return ONLY valid JSON (no markdown, no explanation):

Ticker: {ticker}
Name: {name}

Return a JSON object with these fields:
- morningstar_category: string (e.g., "Large Growth", "Foreign Large Blend", "Small Value")
- style: "growth" | "value" | "blend"
- market_cap: "large" | "mid" | "small" | "multi"
- region: "us" | "foreign_developed" | "emerging" | "global"
- sector_breakdown: object mapping sector names to percentages (e.g., {{"Technology": 25.5, "Healthcare": 15.2}})

Only include fields you are confident about. Use standard Morningstar category names."""

        try:
            message = client.messages.create(
                model="claude-sonnet-4-20250514",
                max_tokens=1024,
                messages=[{"role": "user", "content": prompt}],
            )

            response_text = message.content[0].text.strip()

            # Clean up response - remove markdown code blocks if present
            if response_text.startswith("```"):
                lines = response_text.split("\n")
                response_text = "\n".join(lines[1:-1])

            data = json.loads(response_text)

            # Create or update fund composition
            if basic_data:
                result = basic_data
                result.data_source = "claude"
            else:
                result = FundComposition(ticker=ticker.upper(), data_source="claude")

            if "morningstar_category" in data:
                result.morningstar_category = data["morningstar_category"]
            if "style" in data:
                result.style = data["style"]
            if "market_cap" in data:
                result.market_cap = data["market_cap"]
            if "region" in data:
                result.region = data["region"]
            if "sector_breakdown" in data:
                result.sector_breakdown = data["sector_breakdown"]

            return result

        except json.JSONDecodeError as e:
            logger.warning(f"Could not parse Claude response for {ticker}: {e}")
            return basic_data
        except Exception as e:
            logger.warning(f"Claude API error for {ticker}: {e}")
            return basic_data

    def get_fund_composition(
        self, ticker: str, use_claude: bool = True
    ) -> Optional[FundComposition]:
        """Get fund composition from all available sources.

        Args:
            ticker: Fund ticker symbol
            use_claude: Whether to use Claude API for enrichment

        Returns:
            FundComposition with best available data
        """
        ticker = ticker.upper()

        # 1. Check local cache first
        cached = self.get_from_cache(ticker)
        if cached and cached.morningstar_category:
            logger.debug(f"Using cached data for {ticker}")
            return cached

        # 2. Try yfinance for basic data
        yf_data = self.get_from_yfinance(ticker)

        # 3. Enrich with Claude if available
        if use_claude and self.claude_api_key:
            enriched = self.enrich_with_claude(ticker, yf_data)
            if enriched:
                # Save to cache
                self._cache[ticker] = {
                    "name": enriched.name,
                    "morningstar_category": enriched.morningstar_category,
                    "style": enriched.style,
                    "market_cap": enriched.market_cap,
                    "region": enriched.region,
                    "expense_ratio": enriched.expense_ratio,
                    "sector_breakdown": enriched.sector_breakdown,
                }
                self._save_cache()
                return enriched

        # Return yfinance data if available
        if yf_data:
            return yf_data

        # Return cached data even if incomplete
        return cached

    def get_multiple_funds(
        self, tickers: list[str], use_claude: bool = True
    ) -> dict[str, FundComposition]:
        """Get composition data for multiple funds.

        Args:
            tickers: List of fund ticker symbols
            use_claude: Whether to use Claude API

        Returns:
            Dict mapping ticker to FundComposition
        """
        results = {}
        for ticker in tickers:
            composition = self.get_fund_composition(ticker, use_claude=use_claude)
            if composition:
                results[ticker.upper()] = composition
        return results

    def update_cache(self, ticker: str, data: dict) -> None:
        """Manually update cache for a ticker.

        Args:
            ticker: Fund ticker symbol
            data: Fund data to cache
        """
        self._cache[ticker.upper()] = data
        self._save_cache()

    def get_fund_raw_data(self, ticker: str) -> Optional[dict]:
        """Get raw fund data from cache including all percentage breakdowns.

        This returns the raw data from funds.yaml with fields like:
        - technology_pct, healthcare_pct, etc. (sector breakdown)
        - us_pct, developed_ex_us_pct, emerging_markets_pct (geography)
        - giant_pct, large_pct, medium_pct, small_pct, micro_pct (market cap)
        - style: growth/value/blend

        Args:
            ticker: Fund ticker symbol

        Returns:
            Dict with all fund data or None if not found
        """
        ticker = ticker.upper()
        if ticker in self._cache:
            return self._cache[ticker].copy()
        return None

    def get_all_fund_data(self) -> dict[str, dict]:
        """Get all cached fund data.

        Returns:
            Dict mapping ticker to fund data
        """
        return self._cache.copy()

    def calculate_weighted_allocation(
        self,
        positions: list[tuple[str, float, bool]],  # (ticker, value, is_fund)
        allocation_type: str,
    ) -> dict[str, float]:
        """Calculate weighted allocation for a list of positions.

        Args:
            positions: List of (ticker, market_value, is_fund) tuples
            allocation_type: One of 'sector', 'geography', 'cap', 'style'

        Returns:
            Dict mapping category to total dollar value
        """
        allocation = {}
        total_value = sum(p[1] for p in positions)

        # Define mapping from allocation type to fund data keys
        allocation_keys = {
            'sector': {
                'technology_pct': 'Technology',
                'healthcare_pct': 'Healthcare',
                'financial_pct': 'Financial Services',
                'consumer_cyclical_pct': 'Consumer Cyclical',
                'consumer_defensive_pct': 'Consumer Defensive',
                'industrials_pct': 'Industrials',
                'energy_pct': 'Energy',
                'materials_pct': 'Materials',
                'real_estate_pct': 'Real Estate',
                'utilities_pct': 'Utilities',
                'communication_pct': 'Communication Services',
            },
            'geography': {
                'us_pct': 'US',
                'developed_ex_us_pct': 'Foreign Developed',
                'emerging_markets_pct': 'Emerging Markets',
            },
            'cap': {
                'giant_pct': 'Giant Cap',
                'large_pct': 'Large Cap',
                'medium_pct': 'Mid Cap',
                'small_pct': 'Small Cap',
                'micro_pct': 'Micro Cap',
            },
        }

        if allocation_type not in allocation_keys:
            return allocation

        keys = allocation_keys[allocation_type]

        for ticker, value, is_fund in positions:
            if value <= 0:
                continue

            if is_fund:
                # For funds, use weighted allocation from fund data
                fund_data = self.get_fund_raw_data(ticker)
                if fund_data:
                    for pct_key, category in keys.items():
                        pct = fund_data.get(pct_key, 0) or 0
                        weighted_value = value * (pct / 100)
                        allocation[category] = allocation.get(category, 0) + weighted_value
                else:
                    # No fund data available, put in "Other"
                    allocation['Other'] = allocation.get('Other', 0) + value
            else:
                # For individual stocks, assign to single category based on sector
                if allocation_type == 'sector':
                    # Would need to look up stock sector - put in "Other" for now
                    allocation['Other'] = allocation.get('Other', 0) + value
                elif allocation_type == 'geography':
                    # Most individual stocks are US
                    allocation['US'] = allocation.get('US', 0) + value
                elif allocation_type == 'cap':
                    # Would need to look up market cap - default to Large
                    allocation['Large Cap'] = allocation.get('Large Cap', 0) + value

        return allocation
