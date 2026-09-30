"""Price data service with multiple API sources and round-robin fallbacks."""

import json
import logging
import time
import random
import requests
import yaml
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Optional
from collections import deque

import numpy as np
import pandas as pd
from pydantic import BaseModel

logger = logging.getLogger(__name__)


class PriceData(BaseModel):
    """Historical price data for a ticker."""

    ticker: str
    current_price: float
    previous_close: float
    daily_change: float
    daily_change_pct: float
    year_high: float
    year_low: float
    last_updated: datetime


class PriceHistory(BaseModel):
    """Historical price time series."""

    ticker: str
    dates: list[date]
    prices: list[float]
    returns: list[float]


class PriceSource:
    """Base class for price data sources."""

    def __init__(self, api_key: str, name: str):
        self.api_key = api_key
        self.name = name
        self._last_request_time = 0
        self._min_request_interval = 1.0  # Default 1 second between requests
        self._consecutive_failures = 0
        self._cooldown_until = 0

    def is_available(self) -> bool:
        """Check if this source is available (not in cooldown)."""
        return time.time() >= self._cooldown_until

    def _rate_limit(self):
        """Enforce rate limiting between requests."""
        elapsed = time.time() - self._last_request_time
        if elapsed < self._min_request_interval:
            sleep_time = self._min_request_interval - elapsed + random.uniform(0.1, 0.3)
            time.sleep(sleep_time)
        self._last_request_time = time.time()

    def record_failure(self, hard_limit: bool = False):
        """Record a failure and potentially enter cooldown.

        Args:
            hard_limit: If True, immediately enter long cooldown (e.g., daily API limit hit)
        """
        self._consecutive_failures += 1

        if hard_limit:
            # Daily limit hit - cooldown until tomorrow (or 12 hours)
            self._cooldown_until = time.time() + 43200  # 12 hours
            print(f"Price source {self.name} hit daily limit - disabled for 12 hours")
        elif self._consecutive_failures >= 3:
            # Cooldown for 5 minutes after 3 consecutive failures
            self._cooldown_until = time.time() + 300
            print(f"Price source {self.name} entering 5-minute cooldown after {self._consecutive_failures} failures")

    def record_success(self):
        """Record a success - reset failure counter."""
        self._consecutive_failures = 0

    def get_price(self, ticker: str) -> Optional[PriceData]:
        """Fetch price for a ticker. Must be implemented by subclass."""
        raise NotImplementedError


class AlphaVantageSource(PriceSource):
    """Alpha Vantage API price source."""

    BASE_URL = "https://www.alphavantage.co/query"

    def __init__(self, api_key: str):
        super().__init__(api_key, "Alpha Vantage")
        # Alpha Vantage free tier: 25 requests/day, so be conservative
        self._min_request_interval = 2.0

    def get_price(self, ticker: str) -> Optional[PriceData]:
        """Fetch price from Alpha Vantage GLOBAL_QUOTE endpoint."""
        if not self.is_available():
            return None

        self._rate_limit()

        try:
            params = {
                "function": "GLOBAL_QUOTE",
                "symbol": ticker,
                "apikey": self.api_key,
            }

            response = requests.get(self.BASE_URL, params=params, timeout=10)

            if response.status_code == 429:
                print(f"Alpha Vantage rate limited for {ticker}")
                self.record_failure()
                return None

            if response.status_code != 200:
                self.record_failure()
                return None

            data = response.json()

            # Check for error messages
            if "Error Message" in data or "Note" in data:
                if "Note" in data:
                    note = data["Note"]
                    print(f"Alpha Vantage: {note}")
                    # Check if it's the daily limit message
                    if "25 requests per day" in note or "API rate limit" in note:
                        self.record_failure(hard_limit=True)  # Disable for 12 hours
                        return None
                self.record_failure()
                return None

            quote = data.get("Global Quote", {})
            if not quote:
                return None

            current_price = float(quote.get("05. price", 0))
            if current_price == 0:
                return None

            previous_close = float(quote.get("08. previous close", current_price))
            daily_change = float(quote.get("09. change", 0))
            daily_change_pct = float(quote.get("10. change percent", "0%").replace("%", ""))
            year_high = float(quote.get("03. high", current_price))
            year_low = float(quote.get("04. low", current_price))

            self.record_success()

            return PriceData(
                ticker=ticker,
                current_price=current_price,
                previous_close=previous_close,
                daily_change=daily_change,
                daily_change_pct=daily_change_pct,
                year_high=year_high,
                year_low=year_low,
                last_updated=datetime.now(),
            )

        except Exception as e:
            print(f"Alpha Vantage error for {ticker}: {e}")
            self.record_failure()
            return None


class MassiveSource(PriceSource):
    """Massive API price source."""

    BASE_URL = "https://api.massive.com/v1"

    def __init__(self, api_key: str):
        super().__init__(api_key, "Massive")
        self._min_request_interval = 1.0

    def get_price(self, ticker: str) -> Optional[PriceData]:
        """Fetch price from Massive API."""
        if not self.is_available():
            return None

        self._rate_limit()

        try:
            # Try the quote endpoint
            url = f"{self.BASE_URL}/stocks/quote/{ticker}"
            headers = {
                "Authorization": f"Bearer {self.api_key}",
                "Accept": "application/json",
            }

            response = requests.get(url, headers=headers, timeout=10)

            if response.status_code == 429:
                print(f"Massive rate limited for {ticker}")
                self.record_failure()
                return None

            if response.status_code == 401:
                print("Massive API: Invalid API key")
                self.record_failure()
                return None

            if response.status_code != 200:
                # Try alternative endpoint format
                return self._try_alternative_endpoint(ticker, headers)

            data = response.json()

            current_price = float(data.get("price") or data.get("last") or data.get("c", 0))
            if current_price == 0:
                return None

            previous_close = float(data.get("previousClose") or data.get("pc", current_price))

            self.record_success()

            return PriceData(
                ticker=ticker,
                current_price=current_price,
                previous_close=previous_close,
                daily_change=current_price - previous_close,
                daily_change_pct=((current_price - previous_close) / previous_close * 100) if previous_close else 0,
                year_high=float(data.get("high52") or data.get("h", current_price)),
                year_low=float(data.get("low52") or data.get("l", current_price)),
                last_updated=datetime.now(),
            )

        except Exception as e:
            print(f"Massive error for {ticker}: {e}")
            self.record_failure()
            return None

    def _try_alternative_endpoint(self, ticker: str, headers: dict) -> Optional[PriceData]:
        """Try alternative Massive API endpoint formats."""
        try:
            # Try tickers endpoint
            url = f"{self.BASE_URL}/stocks/tickers/{ticker}"
            response = requests.get(url, headers=headers, timeout=10)

            if response.status_code != 200:
                return None

            data = response.json()
            current_price = float(data.get("lastPrice") or data.get("price", 0))

            if current_price == 0:
                return None

            previous_close = float(data.get("previousClose", current_price))

            self.record_success()

            return PriceData(
                ticker=ticker,
                current_price=current_price,
                previous_close=previous_close,
                daily_change=current_price - previous_close,
                daily_change_pct=((current_price - previous_close) / previous_close * 100) if previous_close else 0,
                year_high=current_price,
                year_low=current_price,
                last_updated=datetime.now(),
            )

        except Exception:
            self.record_failure()
            return None


class FinnhubSource(PriceSource):
    """Finnhub API price source (free tier available)."""

    BASE_URL = "https://finnhub.io/api/v1"

    def __init__(self, api_key: str):
        super().__init__(api_key, "Finnhub")
        self._min_request_interval = 1.0  # 60 calls/minute on free tier

    def get_price(self, ticker: str) -> Optional[PriceData]:
        """Fetch price from Finnhub quote endpoint."""
        if not self.is_available() or not self.api_key:
            return None

        self._rate_limit()

        try:
            url = f"{self.BASE_URL}/quote"
            params = {"symbol": ticker, "token": self.api_key}

            response = requests.get(url, params=params, timeout=10)

            if response.status_code == 429:
                print(f"Finnhub rate limited for {ticker}")
                self.record_failure()
                return None

            if response.status_code == 403:
                # Mutual funds not available on free tier - don't count as failure
                return None

            if response.status_code != 200:
                self.record_failure()
                return None

            data = response.json()

            # Check for error response
            if "error" in data:
                return None

            current_price = float(data.get("c", 0))  # Current price
            if current_price == 0:
                return None

            previous_close = float(data.get("pc", current_price))  # Previous close

            self.record_success()

            return PriceData(
                ticker=ticker,
                current_price=current_price,
                previous_close=previous_close,
                daily_change=float(data.get("d", 0)),  # Change
                daily_change_pct=float(data.get("dp", 0)),  # Percent change
                year_high=float(data.get("h", current_price)),  # High of day
                year_low=float(data.get("l", current_price)),  # Low of day
                last_updated=datetime.now(),
            )

        except Exception as e:
            print(f"Finnhub error for {ticker}: {e}")
            self.record_failure()
            return None


class YahooChartSource(PriceSource):
    """Yahoo Finance Chart API - works for mutual funds and ETFs."""

    BASE_URL = "https://query1.finance.yahoo.com/v8/finance/chart"

    def __init__(self):
        super().__init__("", "Yahoo Chart")  # No API key needed
        self._min_request_interval = 0.5  # Be conservative

    def get_price(self, ticker: str) -> Optional[PriceData]:
        """Fetch price from Yahoo Finance Chart API."""
        if not self.is_available():
            return None

        self._rate_limit()

        try:
            url = f"{self.BASE_URL}/{ticker}"
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
            }
            params = {"interval": "1d", "range": "5d"}

            response = requests.get(url, headers=headers, params=params, timeout=10)

            if response.status_code == 429:
                print(f"Yahoo Chart rate limited for {ticker}")
                self.record_failure()
                return None

            if response.status_code != 200:
                return None

            data = response.json()
            result = data.get("chart", {}).get("result", [])

            if not result:
                return None

            meta = result[0].get("meta", {})
            current_price = meta.get("regularMarketPrice", 0)

            if not current_price or current_price == 0:
                return None

            previous_close = meta.get("previousClose") or meta.get("chartPreviousClose") or current_price

            self.record_success()

            return PriceData(
                ticker=ticker,
                current_price=float(current_price),
                previous_close=float(previous_close),
                daily_change=float(current_price - previous_close),
                daily_change_pct=((current_price - previous_close) / previous_close * 100) if previous_close else 0,
                year_high=float(meta.get("fiftyTwoWeekHigh", current_price)),
                year_low=float(meta.get("fiftyTwoWeekLow", current_price)),
                last_updated=datetime.now(),
            )

        except Exception as e:
            print(f"Yahoo Chart error for {ticker}: {e}")
            self.record_failure()
            return None


class PriceService:
    """Service for fetching and caching price data from multiple sources with round-robin."""

    # Ticker symbol normalization mappings
    TICKER_ALIASES = {
        "BRK/B": "BRK-B",
        "BRK.B": "BRK-B",
        "BF/B": "BF-B",
        "BF.B": "BF-B",
        "BF/A": "BF-A",
        "BF.A": "BF-A",
    }

    # Tickers that don't have market prices (state-specific funds, etc.)
    SKIP_PRICE_LOOKUP = {
        "CASH", "CD", "MONEY", "SPAXX", "FDRXX",  # Cash/money market
        "VMFXX", "VUSXX", "VMRXX", "VFFXX",  # Vanguard money-market sweeps
        "UTVTX", "UTVNX", "UTVYX", "UTVIX",  # Utah 529 funds (state-specific)
        "RE",  # Real-estate sentinel (positions created via /positions/real-estate)
    }

    # Prefixes that indicate non-market securities (CDs, bonds, etc.)
    SKIP_PRICE_PREFIXES = ("CD-", "BOND-", "TBILL-", "IBOND-")

    @classmethod
    def is_quotable(cls, position_type: Optional[str], ticker: Optional[str]) -> bool:
        """Whether a holding has a market quote that can be requested.

        Combines the shared refresh rule (``is_updatable_position``) with this
        service's own skip lists, so callers that bypass PriceService (e.g. a
        direct yfinance download) never request tickers it would skip.
        """
        from src.models.position_types import is_updatable_position

        if not is_updatable_position(position_type, ticker):
            return False
        upper = (ticker or "").strip().upper()
        return upper not in cls.SKIP_PRICE_LOOKUP and not upper.startswith(
            cls.SKIP_PRICE_PREFIXES
        )

    # Manual price overrides for funds not available via standard APIs
    MANUAL_PRICES = {
        "UTVTX": 18.45,  # Utah 529 Total Stock Market - approximate NAV
        "UTVNX": 10.12,  # Utah 529 Bond Market - approximate NAV
        "UTVYX": 15.50,  # Utah 529 - approximate
        "UTVIX": 12.30,  # Utah 529 - approximate
    }

    def __init__(self, cache_dir: str = "data/cache", config_path: str = "config.yaml"):
        self.cache_dir = Path(cache_dir)
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        self.cache_ttl = timedelta(hours=4)  # Cache for 4 hours

        # Load API keys from config and environment
        self.config = self._load_config(config_path)
        self._load_env_file()  # Load .env file if present

        # Initialize price sources with round-robin queue
        self.sources: deque[PriceSource] = deque()
        self._init_sources()

    def _load_env_file(self):
        """Load .env file if present."""
        import os
        env_path = Path(".env")
        if env_path.exists():
            try:
                with open(env_path) as f:
                    for line in f:
                        line = line.strip()
                        if line and not line.startswith("#") and "=" in line:
                            key, value = line.split("=", 1)
                            key = key.strip()
                            value = value.strip().strip('"').strip("'")
                            if key and value and key not in os.environ:
                                os.environ[key] = value
            except Exception:
                logger.warning("Failed to load .env file", exc_info=True)

    def _get_api_key(self, config_name: str, env_name: str) -> Optional[str]:
        """Get API key from config or environment variable."""
        import os
        # Check environment first
        env_val = os.environ.get(env_name)
        if env_val:
            return env_val
        # Then check config
        api_keys = self.config.get("api_keys", {})
        return api_keys.get(config_name) or None

    def _load_config(self, config_path: str) -> dict:
        """Load configuration from YAML file."""
        try:
            with open(config_path) as f:
                return yaml.safe_load(f) or {}
        except Exception as e:
            print(f"Warning: Could not load config: {e}")
            return {}

    def _init_sources(self):
        """Initialize available price sources."""
        # Add Finnhub first (best free tier - 60 req/min, but no mutual funds)
        finnhub_key = self._get_api_key("finnhub", "FINNHUB_API_KEY")
        if finnhub_key:
            self.sources.append(FinnhubSource(finnhub_key))
            print("Price source enabled: Finnhub (stocks/ETFs)")

        # Add Yahoo Chart as fallback (no API key needed, works for mutual funds)
        self.sources.append(YahooChartSource())
        print("Price source enabled: Yahoo Chart (mutual funds/ETFs)")

        # Add Alpha Vantage if key available (limited to 25/day free)
        av_key = self._get_api_key("alpha_vantage", "ALPHA_VANTAGE_API_KEY")
        if av_key:
            self.sources.append(AlphaVantageSource(av_key))
            print("Price source enabled: Alpha Vantage (25 req/day)")

        # Add Massive if key available
        massive_key = self._get_api_key("massive", "MASSIVE_API_KEY")
        if massive_key:
            self.sources.append(MassiveSource(massive_key))
            print("Price source enabled: Massive")

    def normalize_ticker(self, ticker: str) -> str:
        """Normalize ticker symbol to standard format."""
        ticker = ticker.upper().strip()
        # Check explicit aliases first
        if ticker in self.TICKER_ALIASES:
            return self.TICKER_ALIASES[ticker]
        # General rule: replace / with - for API compatibility
        return ticker.replace("/", "-")

    def _get_cache_path(self, ticker: str) -> Path:
        normalized = self.normalize_ticker(ticker)
        return self.cache_dir / f"{normalized}_prices.json"

    def _is_cache_valid(self, cache_path: Path) -> bool:
        if not cache_path.exists():
            return False
        mtime = datetime.fromtimestamp(cache_path.stat().st_mtime)
        return datetime.now() - mtime < self.cache_ttl

    def _cache_price_data(self, cache_path: Path, price_data: PriceData):
        """Cache price data to file."""
        try:
            with open(cache_path, "w") as f:
                json.dump(price_data.model_dump(mode="json"), f)
        except Exception:
            logger.warning("Failed to cache price data to %s", cache_path, exc_info=True)

    def _rotate_sources(self):
        """Rotate sources for round-robin load balancing."""
        if self.sources:
            self.sources.rotate(-1)

    def get_current_price(self, ticker: str, force: bool = False) -> Optional[PriceData]:
        """Get current price data for a ticker using round-robin sources.

        Args:
            ticker: Ticker symbol to look up.
            force: When True, bypass the local file cache and always fetch a
                fresh quote from the upstream sources. This is what an explicit
                user-initiated "Update Prices" must do — otherwise a forced
                refresh within the 4-hour cache window returns the stale cached
                value while the DB timestamp is re-stamped to "now", leaving the
                freshness badge green over an out-of-date price.
        """
        original_ticker = ticker.upper().strip()
        normalized_ticker = self.normalize_ticker(ticker)
        cache_path = self._get_cache_path(original_ticker)

        # Check cache first (skipped on a forced refresh so the user actually
        # gets a live quote, not the value we cached up to 4 hours ago).
        if not force and self._is_cache_valid(cache_path):
            try:
                with open(cache_path) as f:
                    data = json.load(f)
                return PriceData(**data)
            except Exception:
                logger.warning("Corrupt price cache at %s; refetching", cache_path, exc_info=True)

        # Check if this ticker should skip price lookup
        should_skip = (
            original_ticker in self.SKIP_PRICE_LOOKUP or
            normalized_ticker in self.SKIP_PRICE_LOOKUP or
            original_ticker.startswith(self.SKIP_PRICE_PREFIXES)
        )

        if should_skip:
            # Use manual price if available
            if original_ticker in self.MANUAL_PRICES:
                price = self.MANUAL_PRICES[original_ticker]
                price_data = PriceData(
                    ticker=original_ticker,
                    current_price=price,
                    previous_close=price,
                    daily_change=0,
                    daily_change_pct=0,
                    year_high=price,
                    year_low=price,
                    last_updated=datetime.now(),
                )
                self._cache_price_data(cache_path, price_data)
                return price_data
            # For CDs and other fixed-value instruments, return None
            return None

        # Try each source in round-robin order
        price_data = None
        sources_tried = set()

        while len(sources_tried) < len(self.sources) and not price_data:
            # Find first available source we haven't tried
            source = None
            for s in self.sources:
                if s.name not in sources_tried and s.is_available():
                    source = s
                    break

            if not source:
                # No available sources left
                break

            sources_tried.add(source.name)
            price_data = source.get_price(normalized_ticker)

            if price_data:
                # Update ticker to original format
                price_data = PriceData(
                    ticker=original_ticker,
                    current_price=price_data.current_price,
                    previous_close=price_data.previous_close,
                    daily_change=price_data.daily_change,
                    daily_change_pct=price_data.daily_change_pct,
                    year_high=price_data.year_high,
                    year_low=price_data.year_low,
                    last_updated=price_data.last_updated,
                )

        # Rotate sources for next request (load balancing)
        self._rotate_sources()

        # Fallback to expired cache if all sources fail
        if not price_data and cache_path.exists():
            try:
                with open(cache_path) as f:
                    data = json.load(f)
                print(f"Using expired cache for {original_ticker}")
                return PriceData(**data)
            except Exception:
                logger.warning("Failed to read expired cache for %s", original_ticker, exc_info=True)

        # Cache successful result
        if price_data:
            self._cache_price_data(cache_path, price_data)

        return price_data

    def get_price_history(
        self,
        ticker: str,
        period: str = "1y",
        interval: str = "1d",
    ) -> Optional[PriceHistory]:
        """Get historical price data for a ticker.

        Uses yfinance (no API key required) with Alpha Vantage as fallback.
        """
        original_ticker = ticker
        ticker = self.normalize_ticker(ticker)
        cache_path = self.cache_dir / f"{ticker}_history_{period}.json"

        if self._is_cache_valid(cache_path):
            try:
                with open(cache_path) as f:
                    data = json.load(f)
                return PriceHistory(**data)
            except Exception:
                logger.warning("Corrupt history cache at %s; refetching", cache_path, exc_info=True)

        # Skip non-tradeable tickers
        if (
            original_ticker.upper() in self.SKIP_PRICE_LOOKUP or
            ticker in self.SKIP_PRICE_LOOKUP or
            original_ticker.startswith(self.SKIP_PRICE_PREFIXES)
        ):
            return None

        # Try yfinance first (no API key required)
        try:
            import yfinance as yf

            stock = yf.Ticker(ticker)
            hist = stock.history(period=period, interval=interval)

            if hist.empty:
                raise ValueError("No data returned")

            dates = [d.date() for d in hist.index]
            prices = hist["Close"].tolist()

            # Calculate returns
            returns = [0.0]
            for i in range(1, len(prices)):
                if prices[i - 1] != 0:
                    returns.append((prices[i] - prices[i - 1]) / prices[i - 1])
                else:
                    returns.append(0.0)

            history = PriceHistory(
                ticker=original_ticker.upper(),
                dates=dates,
                prices=prices,
                returns=returns,
            )

            # Cache the result
            with open(cache_path, "w") as f:
                json.dump(
                    {
                        "ticker": history.ticker,
                        "dates": [d.isoformat() for d in history.dates],
                        "prices": history.prices,
                        "returns": history.returns,
                    },
                    f,
                )

            return history

        except ImportError:
            print("yfinance not available, trying Alpha Vantage")
        except Exception as e:
            print(f"yfinance error for {ticker}: {e}, trying Alpha Vantage")

        # Fall back to Alpha Vantage
        api_keys = self.config.get("api_keys", {})
        av_key = api_keys.get("alpha_vantage")

        if not av_key:
            return None

        try:
            # Alpha Vantage TIME_SERIES_DAILY_ADJUSTED
            url = "https://www.alphavantage.co/query"
            params = {
                "function": "TIME_SERIES_DAILY_ADJUSTED",
                "symbol": ticker,
                "outputsize": "full" if period in ["1y", "2y", "5y"] else "compact",
                "apikey": av_key,
            }

            response = requests.get(url, params=params, timeout=15)

            if response.status_code != 200:
                return None

            data = response.json()

            if "Error Message" in data or "Note" in data:
                return None

            time_series = data.get("Time Series (Daily)", {})
            if not time_series:
                return None

            # Parse and limit to requested period
            period_days = {"1mo": 30, "3mo": 90, "6mo": 180, "1y": 365, "2y": 730, "5y": 1825}
            max_days = period_days.get(period, 365)

            dates = []
            prices = []

            for date_str, values in sorted(time_series.items(), reverse=True)[:max_days]:
                dates.append(date.fromisoformat(date_str))
                prices.append(float(values.get("5. adjusted close", values.get("4. close", 0))))

            # Reverse to chronological order
            dates = dates[::-1]
            prices = prices[::-1]

            # Calculate returns
            returns = [0.0]
            for i in range(1, len(prices)):
                if prices[i - 1] != 0:
                    returns.append((prices[i] - prices[i - 1]) / prices[i - 1])
                else:
                    returns.append(0.0)

            history = PriceHistory(
                ticker=original_ticker.upper(),
                dates=dates,
                prices=prices,
                returns=returns,
            )

            # Cache the result
            with open(cache_path, "w") as f:
                json.dump(
                    {
                        "ticker": history.ticker,
                        "dates": [d.isoformat() for d in history.dates],
                        "prices": history.prices,
                        "returns": history.returns,
                    },
                    f,
                )

            return history

        except Exception as e:
            print(f"Error fetching history for {original_ticker}: {e}")
            return None

    def get_multiple_prices(self, tickers: list[str]) -> dict[str, Optional[PriceData]]:
        """Get current prices for multiple tickers with batching."""
        results = {}

        for ticker in tickers:
            results[ticker] = self.get_current_price(ticker)

        return results

    def get_benchmark_history(self, benchmark: str = "SPY", period: str = "1y") -> Optional[PriceHistory]:
        """Get benchmark price history for comparison."""
        return self.get_price_history(benchmark, period)

    def calculate_volatility(self, ticker: str, period: str = "1y") -> Optional[float]:
        """Calculate annualized volatility for a ticker."""
        history = self.get_price_history(ticker, period)
        if not history or len(history.returns) < 20:
            return None

        # Annualized volatility = daily std dev * sqrt(252)
        daily_std = np.std(history.returns[1:])  # Skip first zero return
        return daily_std * np.sqrt(252)

    def calculate_beta(self, ticker: str, benchmark: str = "SPY", period: str = "1y") -> Optional[float]:
        """Calculate beta relative to a benchmark."""
        stock_history = self.get_price_history(ticker, period)
        bench_history = self.get_price_history(benchmark, period)

        if not stock_history or not bench_history:
            return None

        # Align the data by dates
        stock_df = pd.DataFrame({"date": stock_history.dates, "stock": stock_history.returns})
        bench_df = pd.DataFrame({"date": bench_history.dates, "bench": bench_history.returns})

        merged = pd.merge(stock_df, bench_df, on="date", how="inner")

        if len(merged) < 20:
            return None

        # Beta = Cov(stock, market) / Var(market)
        covariance = np.cov(merged["stock"], merged["bench"])[0][1]
        market_variance = np.var(merged["bench"])

        if market_variance == 0:
            return None

        return covariance / market_variance

    def update_manual_price(self, ticker: str, price: float):
        """Update manual price for a fund not available via APIs."""
        ticker = ticker.upper().strip()
        self.MANUAL_PRICES[ticker] = price

        # Update cache
        cache_path = self._get_cache_path(ticker)
        price_data = PriceData(
            ticker=ticker,
            current_price=price,
            previous_close=price,
            daily_change=0,
            daily_change_pct=0,
            year_high=price,
            year_low=price,
            last_updated=datetime.now(),
        )
        self._cache_price_data(cache_path, price_data)

    def get_source_status(self) -> list[dict]:
        """Get status of all configured price sources."""
        return [
            {
                "name": source.name,
                "available": source.is_available(),
                "consecutive_failures": source._consecutive_failures,
                "in_cooldown": not source.is_available(),
            }
            for source in self.sources
        ]
