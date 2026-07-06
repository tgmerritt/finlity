"""Tests for /api/v2/fund/status, /api/v2/fund/analyze, and
/api/v2/positions/sectors (F3) — no real network calls (yfinance/Finnhub/
Alpha Vantage/Claude are all monkeypatched), no DB access.
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


class TestFundStatus:
    def test_reports_unavailable_without_env_key(self, client, monkeypatch):
        monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)

        response = client.get("/api/v2/fund/status")
        assert response.status_code == 200
        data = response.json()
        assert data["claude_available"] is False
        assert data["api_key_source"] is None
        assert data["features"]["fund_analysis"] is False

    def test_reports_available_with_env_key(self, client, monkeypatch):
        monkeypatch.setenv("ANTHROPIC_API_KEY", "fake-key-not-used")

        response = client.get("/api/v2/fund/status")
        assert response.status_code == 200
        data = response.json()
        assert data["claude_available"] is True
        assert data["api_key_source"] == "environment"
        assert data["features"]["fund_analysis"] is True

    def test_never_touches_server_db(self, client, monkeypatch):
        def _boom() -> None:
            raise AssertionError("v2 fund/status must not call src.api.settings.get_database")

        monkeypatch.setattr("src.api.settings.get_database", _boom)
        response = client.get("/api/v2/fund/status")
        assert response.status_code == 200


class TestFundAnalyze:
    def test_analyze_returns_composition_from_service(self, client, monkeypatch):
        from src.services.fund_data import FundComposition, FundDataService

        fake_composition = FundComposition(
            ticker="VTI",
            name="Vanguard Total Stock Market ETF",
            morningstar_category="Large Blend",
            style="blend",
            market_cap="multi",
            region="us",
            expense_ratio=0.0003,
            sector_breakdown={"Technology": 0.3, "Financials": 0.15},
            data_source="cache",
        )

        def _fake_get_fund_composition(self, ticker, use_claude=True):
            assert ticker == "VTI"
            return fake_composition

        monkeypatch.setattr(FundDataService, "get_fund_composition", _fake_get_fund_composition)

        response = client.post("/api/v2/fund/analyze", json={"ticker": "VTI"})
        assert response.status_code == 200
        data = response.json()
        assert data["ticker"] == "VTI"
        assert data["expense_ratio"] == pytest.approx(0.0003)
        assert data["sector_breakdown"] == {"Technology": 0.3, "Financials": 0.15}

    def test_analyze_unknown_ticker_returns_404(self, client, monkeypatch):
        from src.services.fund_data import FundDataService

        monkeypatch.setattr(
            FundDataService, "get_fund_composition", lambda self, ticker, use_claude=True: None
        )

        response = client.post("/api/v2/fund/analyze", json={"ticker": "NOTREAL"})
        assert response.status_code == 404

    def test_analyze_never_touches_server_db(self, client, monkeypatch):
        from src.services.fund_data import FundComposition, FundDataService

        def _boom() -> None:
            raise AssertionError("v2 fund/analyze must not call src.api.settings.get_database")

        monkeypatch.setattr("src.api.settings.get_database", _boom)
        monkeypatch.setattr(
            FundDataService,
            "get_fund_composition",
            lambda self, ticker, use_claude=True: FundComposition(ticker=ticker, name=ticker),
        )

        response = client.post("/api/v2/fund/analyze", json={"ticker": "VTI", "use_claude": False})
        assert response.status_code == 200


class TestPositionSectors:
    def test_returns_sector_per_ticker(self, client, monkeypatch):
        from src.api.v2 import fund as fund_module

        def _fake_yfinance(ticker):
            return {"VTI": "Broad Market", "AAPL": "Technology"}.get(ticker)

        monkeypatch.setattr(fund_module, "_get_sector_from_yfinance", _fake_yfinance)

        response = client.post(
            "/api/v2/positions/sectors", json={"tickers": ["VTI", "AAPL"]}
        )
        assert response.status_code == 200
        data = response.json()
        assert data["sectors"] == {"VTI": "Broad Market", "AAPL": "Technology"}
        assert data["errors"] == []

    def test_ticker_with_no_sector_found_is_null_not_an_error(self, client, monkeypatch):
        from src.api.v2 import fund as fund_module

        monkeypatch.setattr(fund_module, "_get_sector_from_yfinance", lambda ticker: None)
        monkeypatch.delenv("FINNHUB_API_KEY", raising=False)
        monkeypatch.delenv("ALPHA_VANTAGE_API_KEY", raising=False)

        response = client.post("/api/v2/positions/sectors", json={"tickers": ["ZZZZ"]})
        assert response.status_code == 200
        data = response.json()
        assert data["sectors"] == {"ZZZZ": None}
        assert data["errors"] == []

    def test_lookup_exception_is_reported_per_ticker(self, client, monkeypatch):
        from src.api.v2 import fund as fund_module

        def _raise(ticker):
            raise RuntimeError("synthetic lookup failure")

        monkeypatch.setattr(fund_module, "_get_sector_from_yfinance", _raise)

        response = client.post("/api/v2/positions/sectors", json={"tickers": ["VTI"]})
        assert response.status_code == 200
        data = response.json()
        assert data["sectors"]["VTI"] is None
        assert len(data["errors"]) == 1
        assert data["errors"][0]["ticker"] == "VTI"

    def test_ticker_list_capped_at_100(self, client, monkeypatch):
        from src.api.v2 import fund as fund_module

        calls = []

        def _fake_yfinance(ticker):
            calls.append(ticker)
            return "Technology"

        monkeypatch.setattr(fund_module, "_get_sector_from_yfinance", _fake_yfinance)

        tickers = [f"T{i}" for i in range(150)]
        response = client.post("/api/v2/positions/sectors", json={"tickers": tickers})
        assert response.status_code == 200
        assert len(calls) == 100
        assert len(response.json()["sectors"]) == 100

    def test_never_touches_server_db(self, client, monkeypatch):
        from src.api.v2 import fund as fund_module

        def _boom() -> None:
            raise AssertionError("v2 positions/sectors must not call src.api.settings.get_database")

        monkeypatch.setattr("src.api.settings.get_database", _boom)
        monkeypatch.setattr(fund_module, "_get_sector_from_yfinance", lambda ticker: "Technology")

        response = client.post("/api/v2/positions/sectors", json={"tickers": ["VTI"]})
        assert response.status_code == 200
