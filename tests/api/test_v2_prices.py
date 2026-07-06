"""Tests for /api/v2/prices and /api/v2/fund-metadata.

PriceService is monkeypatched so tests never hit the network; the price
cache/quote calls that DO happen use PriceService's own file cache (no DB).
"""

from datetime import datetime

import pytest
from fastapi.testclient import TestClient

import src.api.v2.prices as prices_module
from src.data.prices import PriceData
from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


class _FakePriceService:
    """Drop-in replacement for PriceService with canned responses."""

    def __init__(self, *args, **kwargs):
        pass

    def get_current_price(self, ticker: str, force: bool = False):
        if ticker == "AAPL":
            return PriceData(
                ticker="AAPL",
                current_price=200.0,
                previous_close=198.0,
                daily_change=2.0,
                daily_change_pct=1.01,
                year_high=250.0,
                year_low=150.0,
                last_updated=datetime(2026, 1, 1),
            )
        if ticker == "BADTICKER":
            raise RuntimeError("simulated upstream failure")
        return None  # simulate "no data available"


class TestGetPrices:
    def test_returns_prices_and_errors(self, client, monkeypatch):
        monkeypatch.setattr(prices_module, "PriceService", _FakePriceService)

        response = client.get("/api/v2/prices", params={"tickers": "AAPL,UNKNOWN,BADTICKER"})
        assert response.status_code == 200
        data = response.json()

        assert len(data["prices"]) == 1
        assert data["prices"][0]["ticker"] == "AAPL"
        assert data["prices"][0]["current_price"] == pytest.approx(200.0)

        error_tickers = {e["ticker"] for e in data["errors"]}
        assert error_tickers == {"UNKNOWN", "BADTICKER"}

    def test_caps_at_100_tickers(self, client, monkeypatch):
        monkeypatch.setattr(prices_module, "PriceService", _FakePriceService)

        many_tickers = ",".join(f"T{i}" for i in range(150))
        response = client.get("/api/v2/prices", params={"tickers": many_tickers})
        assert response.status_code == 200
        data = response.json()
        # All unknown so all land in errors; count must be capped at 100.
        assert len(data["prices"]) + len(data["errors"]) == 100


class TestFundMetadata:
    def test_cache_only_lookup(self, client):
        """funds.yaml at the repo root has real entries for common ETFs like
        VTI; this exercises the cache-only path with no network calls."""
        response = client.get("/api/v2/fund-metadata", params={"tickers": "VTI,DEFINITELY_NOT_A_FUND"})
        assert response.status_code == 200
        data = response.json()
        assert "DEFINITELY_NOT_A_FUND" in data["not_found"]
        # VTI may or may not be present depending on the cache contents, but
        # if present it must carry a data_source and ticker.
        if data["funds"]:
            entry = data["funds"][0]
            assert entry["ticker"]
            assert entry["data_source"]
