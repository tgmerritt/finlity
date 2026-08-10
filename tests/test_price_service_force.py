"""Tests for PriceService cache behaviour, especially the forced refresh path.

The bug these guard against: a user-initiated "Update Prices" (force=True) must
fetch a live quote rather than returning the file cache. Previously the cache
was consulted unconditionally, so a forced refresh within the 4-hour window
returned the stale cached value while the DB timestamp was re-stamped "fresh" —
leaving a green "Prices fresh" badge over an out-of-date price.
"""

import json
from collections import deque
from datetime import datetime

from src.data.prices import PriceData, PriceService


class _FakeSource:
    """Minimal price source that always returns a fixed live quote."""

    def __init__(self, price: float):
        self.name = "fake"
        self._price = price
        self.calls = 0

    def is_available(self) -> bool:
        return True

    def get_price(self, ticker: str) -> PriceData:
        self.calls += 1
        return PriceData(
            ticker=ticker,
            current_price=self._price,
            previous_close=self._price,
            daily_change=0.0,
            daily_change_pct=0.0,
            year_high=self._price,
            year_low=self._price,
            last_updated=datetime(2026, 1, 1),
        )


def _service_with_cached_price(tmp_path, ticker: str, cached_price: float, live_price: float):
    """Build a PriceService whose file cache holds ``cached_price`` and whose
    only (fake) upstream source returns ``live_price``."""
    svc = PriceService(cache_dir=str(tmp_path))
    cache_path = svc._get_cache_path(ticker)
    cached = PriceData(
        ticker=ticker,
        current_price=cached_price,
        previous_close=cached_price,
        daily_change=0.0,
        daily_change_pct=0.0,
        year_high=cached_price,
        year_low=cached_price,
        last_updated=datetime(2026, 1, 1),
    )
    with open(cache_path, "w") as f:
        json.dump(json.loads(cached.model_dump_json()), f)

    fake = _FakeSource(live_price)
    svc.sources = deque([fake])
    return svc, fake


def test_get_current_price_uses_fresh_cache_without_force(tmp_path):
    """A normal lookup returns the (valid) cached value and never hits upstream."""
    svc, fake = _service_with_cached_price(tmp_path, "AAPL", cached_price=100.0, live_price=200.0)

    result = svc.get_current_price("AAPL")

    assert result is not None
    assert result.current_price == 100.0
    assert fake.calls == 0  # cache short-circuited the fetch


def test_force_bypasses_fresh_cache_and_fetches_live(tmp_path):
    """force=True skips the valid file cache and fetches a live quote."""
    svc, fake = _service_with_cached_price(tmp_path, "AAPL", cached_price=100.0, live_price=200.0)

    result = svc.get_current_price("AAPL", force=True)

    assert result is not None
    assert result.current_price == 200.0  # the live value, not the cached 100
    assert fake.calls == 1  # upstream was actually consulted


def test_real_estate_sentinel_never_hits_upstream(tmp_path):
    """The "RE" real-estate sentinel must never reach a price provider.

    Real-estate prices are user-managed. Before "RE" was added to
    SKIP_PRICE_LOOKUP, analysis history calls and /api/v2/prices hit Yahoo
    for it, which logs "No data found, symbol may be delisted" on every
    dashboard load.
    """
    svc, fake = _service_with_cached_price(tmp_path, "RE", cached_price=0.0, live_price=1.0)

    result = svc.get_current_price("RE", force=True)

    assert result is None
    assert fake.calls == 0  # the sentinel short-circuited before upstream


def test_real_estate_sentinel_history_returns_none(tmp_path):
    """get_price_history for "RE" returns None without touching yfinance."""
    svc, _ = _service_with_cached_price(tmp_path, "RE", cached_price=0.0, live_price=1.0)

    history = svc.get_price_history("RE", period="1y")

    assert history is None
