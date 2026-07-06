"""Tests for /api/v2/analysis/* — stateless allocation, suggestions, and
one async_mode flow returning a task_id (per WS1 plan's testing section).
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


def _sample_payload():
    return {
        "accounts": [
            {
                "name": "Test Roth",
                "account_type": "roth_ira",
                "brokerage": "vanguard",
                "positions": [
                    {
                        "ticker": "VTI",
                        "name": "Vanguard Total Market",
                        "shares": 10,
                        "current_price": 250.0,
                        "cost_basis": 2000,
                        "is_fund": True,
                        "sector": "Broad Market",
                    },
                    {
                        "ticker": "AAPL",
                        "shares": 5,
                        "current_price": 200.0,
                        "cost_basis": 500,
                        "sector": "Technology",
                    },
                    # No current_price -> dropped by payload_to_portfolio
                    {"ticker": "NOPX", "shares": 5, "current_price": None},
                ],
            }
        ]
    }


class TestAllocation:
    def test_allocation_from_payload(self, client):
        response = client.post("/api/v2/analysis/allocation", json=_sample_payload())
        assert response.status_code == 200
        data = response.json()
        assert data["by_account_type"]["roth_ira"] == pytest.approx(100.0)
        assert set(data["by_sector"].keys()) == {"Broad Market", "Technology"}
        assert data["concentration_top5"] == pytest.approx(100.0)

    def test_allocation_empty_portfolio(self, client):
        response = client.post("/api/v2/analysis/allocation", json={"accounts": []})
        assert response.status_code == 200
        data = response.json()
        assert data["by_asset_class"] == {}
        assert data["concentration_top5"] == 0


class TestDataWarnings:
    """F5 regression: payload_to_portfolio previously dropped priceless
    positions with no trace. v2 endpoints that consume the adapter must now
    surface a `data_warnings` field reporting what was excluded and why.
    `_sample_payload()` includes one priceless position (NOPX, no
    current_price) alongside two valid ones."""

    def test_allocation_reports_excluded_priceless_position(self, client):
        response = client.post("/api/v2/analysis/allocation", json=_sample_payload())
        assert response.status_code == 200
        data = response.json()
        assert data["data_warnings"]["count"] == 1
        excluded = data["data_warnings"]["excluded_positions"][0]
        assert excluded["ticker"] == "NOPX"
        assert excluded["account_name"] == "Test Roth"
        assert excluded["reason"] == "missing_price"

    def test_allocation_omits_data_warnings_when_nothing_excluded(self, client):
        payload = {
            "accounts": [
                {
                    "name": "Taxable",
                    "account_type": "taxable",
                    "positions": [{"ticker": "VTI", "shares": 1, "current_price": 100.0}],
                }
            ]
        }
        response = client.post("/api/v2/analysis/allocation", json=payload)
        assert response.status_code == 200
        assert response.json()["data_warnings"] is None

    def test_risk_reports_excluded_priceless_position(self, client):
        response = client.post(
            "/api/v2/analysis/risk?async_mode=false", json=_sample_payload()
        )
        assert response.status_code == 200
        assert response.json()["data_warnings"]["count"] == 1

    def test_performance_reports_excluded_priceless_position(self, client):
        response = client.post(
            "/api/v2/analysis/performance?async_mode=false", json=_sample_payload()
        )
        assert response.status_code == 200
        assert response.json()["data_warnings"]["count"] == 1

    def test_correlation_reports_excluded_priceless_position(self, client):
        response = client.post(
            "/api/v2/analysis/correlation?async_mode=false&min_positions=1",
            json=_sample_payload(),
        )
        assert response.status_code == 200
        assert response.json()["data_warnings"]["count"] == 1

    def test_suggestions_reports_excluded_priceless_position(self, client):
        response = client.post("/api/v2/analysis/suggestions", json=_sample_payload())
        assert response.status_code == 200
        data = response.json()
        assert data["data_warnings"]["count"] == 1


class TestSuggestions:
    def test_suggestions_from_payload(self, client):
        response = client.post("/api/v2/analysis/suggestions", json=_sample_payload())
        assert response.status_code == 200
        data = response.json()
        assert "suggestions" in data
        # VTI (2500) + AAPL (1000) = 3500; priceless position excluded
        assert data["total_value"] == pytest.approx(3500.0)

    def test_suggestions_empty_portfolio(self, client):
        response = client.post("/api/v2/analysis/suggestions", json={"accounts": []})
        assert response.status_code == 200
        data = response.json()
        # F5: data_warnings is additive (None when nothing was excluded) —
        # assert on the fields that matter rather than exact dict equality.
        assert data["suggestions"] == []
        assert data["message"] == "No positions to analyze"
        assert data.get("data_warnings") is None


class TestExpenseDrag:
    def test_expense_drag_from_payload(self, client):
        response = client.post("/api/v2/analysis/expense-drag", json=_sample_payload())
        assert response.status_code == 200
        data = response.json()
        # Neither VTI (not marked is_fund cache hit) nor AAPL have a cached
        # ER in this test's funds.yaml lookup context, so most likely lands
        # in uncovered_value; just assert the response shape is sane.
        assert data["covered_value"] >= 0
        assert data["uncovered_value"] >= 0


class TestAsyncMode:
    def test_performance_async_mode_returns_task_id(self, client):
        """async_mode=true returns {task_id, status} for polling via
        /api/tasks/{task_id}, matching v1's contract exactly."""
        response = client.post(
            "/api/v2/analysis/performance?async_mode=true",
            json=_sample_payload(),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["status"] == "pending"
        assert "task_id" in data

        # Poll until complete (background thread should finish almost immediately
        # for this tiny portfolio).
        import time
        task_id = data["task_id"]
        for _ in range(50):
            poll = client.get(f"/api/tasks/{task_id}")
            assert poll.status_code == 200
            if poll.json()["status"] in ("completed", "failed"):
                break
            time.sleep(0.1)
        final = poll.json()
        assert final["status"] == "completed"
        assert "total_value" in final["result"]

    def test_performance_sync_mode(self, client):
        response = client.post(
            "/api/v2/analysis/performance?async_mode=false",
            json=_sample_payload(),
        )
        assert response.status_code == 200
        data = response.json()
        assert data["total_value"] == pytest.approx(3500.0)


class TestSuggestionsNeverTouchesServerDB:
    """F1 follow-up: AllocationAnalyzer() with no explicit targets falls
    back to AllocationTargets.from_config() -> load_config() ->
    get_database() (the server's shared profile DB). v2's /suggestions must
    construct AllocationTargets explicitly (from_config's own hardcoded
    fallback values) so no config/DB load is attempted at all."""

    def test_suggestions_returns_200_when_server_db_raises(self, client, monkeypatch):
        def _boom() -> None:
            raise AssertionError("v2 /suggestions must not call src.api.settings.get_database")

        monkeypatch.setattr("src.api.settings.get_database", _boom)

        response = client.post("/api/v2/analysis/suggestions", json=_sample_payload())
        assert response.status_code == 200
        data = response.json()
        assert "suggestions" in data
        assert data["total_value"] == pytest.approx(3500.0)

    def test_suggestions_never_constructs_targets_via_from_config(self, client, monkeypatch):
        """Stronger check: from_config's DB path swallows exceptions and
        falls back to reading config.yaml, so a get_database boom alone
        can't prove from_config wasn't called. Assert from_config itself is
        never invoked on the v2 path."""
        from src.models.targets import AllocationTargets

        def _boom(cls, config=None):
            raise AssertionError("v2 /suggestions must not call AllocationTargets.from_config")

        monkeypatch.setattr(AllocationTargets, "from_config", classmethod(_boom))

        response = client.post("/api/v2/analysis/suggestions", json=_sample_payload())
        assert response.status_code == 200
        assert "suggestions" in response.json()


class TestRiskNeverTouchesServerDB:
    """F1 regression: RiskAnalyzer() with no explicit config falls back to
    load_config() -> get_database() (the server's shared profile DB). v2's
    /risk must construct RiskAnalyzer(config=...) explicitly so it never
    calls get_database(), even when the client sends no market_config."""

    def test_risk_sync_returns_200_when_server_db_raises(self, client, monkeypatch):
        def _boom() -> None:
            raise AssertionError("v2 /risk must not call src.api.settings.get_database")

        monkeypatch.setattr("src.api.settings.get_database", _boom)

        response = client.post(
            "/api/v2/analysis/risk?async_mode=false",
            json=_sample_payload(),
        )
        assert response.status_code == 200
        assert "volatility" in response.json()

    def test_risk_with_market_config_override_returns_200_when_server_db_raises(self, client, monkeypatch):
        monkeypatch.setattr(
            "src.api.settings.get_database",
            lambda: (_ for _ in ()).throw(AssertionError("must not touch server DB")),
        )

        payload = _sample_payload()
        payload["market_config"] = {"risk_free_rate": 0.03}

        response = client.post(
            "/api/v2/analysis/risk?async_mode=false",
            json=payload,
        )
        assert response.status_code == 200
