"""Tests for /api/v2/projections/* — no DB fallback (current_balance
required, 422 otherwise) and no db.save_monte_carlo_result side effect
(unlike v1), verified via a monkeypatched Database.
"""

import pytest
from fastapi.testclient import TestClient

from src.database import Database
from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


class TestMonteCarloRequiresBalance:
    def test_missing_current_balance_returns_422(self, client):
        response = client.post(
            "/api/v2/projections/monte-carlo?async_mode=false",
            json={
                "current_age": 30,
                "retirement_age": 65,
                "monthly_contribution": 500,
                "monthly_withdrawal": 3000,
            },
        )
        assert response.status_code == 422

    def test_with_current_balance_succeeds(self, client, monkeypatch):
        """Also asserts db.save_monte_carlo_result is never called (v2 must
        not persist anything), unlike v1's _run_monte_carlo_task."""

        def _fail_if_called(*args, **kwargs):
            raise AssertionError("v2 monte-carlo must not call db.save_monte_carlo_result")

        monkeypatch.setattr(Database, "save_monte_carlo_result", _fail_if_called)

        response = client.post(
            "/api/v2/projections/monte-carlo?async_mode=false",
            json={
                "current_age": 30,
                "retirement_age": 65,
                "current_balance": 100000,
                "monthly_contribution": 500,
                "monthly_withdrawal": 3000,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert "median_final_value" in data
        assert "success_rate" in data


class TestMonteCarloNeverTouchesServerDB:
    """F1 regression: MonteCarloEngine() with no explicit config falls back
    to load_config() -> get_database() (the server's shared profile DB).
    v2's /monte-carlo must construct MonteCarloEngine(config=...) explicitly
    (even when the client omits market_config/monte_carlo_config) so it
    never calls get_database()."""

    def test_monte_carlo_sync_returns_200_when_server_db_raises(self, client, monkeypatch):
        def _boom() -> None:
            raise AssertionError("v2 /monte-carlo must not call src.api.settings.get_database")

        monkeypatch.setattr("src.api.settings.get_database", _boom)

        response = client.post(
            "/api/v2/projections/monte-carlo?async_mode=false",
            json={
                "current_age": 30,
                "retirement_age": 65,
                "current_balance": 100000,
                "monthly_contribution": 500,
                "monthly_withdrawal": 3000,
            },
        )
        assert response.status_code == 200
        assert "median_final_value" in response.json()

    def test_num_simulations_capped_at_10000(self, client):
        """A client-supplied num_simulations above the server cap is silently
        clamped rather than honored (protects against a client demanding an
        arbitrarily expensive simulation)."""
        response = client.post(
            "/api/v2/projections/monte-carlo?async_mode=false",
            json={
                "current_age": 30,
                "retirement_age": 65,
                "current_balance": 100000,
                "monthly_contribution": 500,
                "monthly_withdrawal": 3000,
                "monte_carlo_config": {"num_simulations": 10_000_000},
            },
        )
        assert response.status_code == 200
        assert "median_final_value" in response.json()

    def test_num_simulations_cap_actually_reaches_the_engine(self, client, monkeypatch):
        """Stronger check than the 200-status test above: capture the actual
        MonteCarloEngine.num_simulations the request produced, proving the
        clamp fired rather than just not-crashing."""
        from src.projections.engine import MonteCarloEngine

        captured = {}
        real_init = MonteCarloEngine.__init__

        def _spy_init(self, config=None, prefer_gpu=True):
            real_init(self, config=config, prefer_gpu=prefer_gpu)
            captured["num_simulations"] = self.num_simulations

        monkeypatch.setattr(MonteCarloEngine, "__init__", _spy_init)

        response = client.post(
            "/api/v2/projections/monte-carlo?async_mode=false",
            json={
                "current_age": 30,
                "retirement_age": 65,
                "current_balance": 100000,
                "monthly_contribution": 500,
                "monthly_withdrawal": 3000,
                "monte_carlo_config": {"num_simulations": 10_000_000},
            },
        )
        assert response.status_code == 200
        assert captured["num_simulations"] == 10_000


class TestFireRequiresBalance:
    def test_missing_current_balance_returns_422(self, client):
        response = client.post(
            "/api/v2/projections/fire",
            json={"annual_spending": 50000, "monthly_contribution": 1000},
        )
        assert response.status_code == 422

    def test_with_balance_succeeds(self, client):
        response = client.post(
            "/api/v2/projections/fire",
            json={
                "annual_spending": 50000,
                "current_balance": 200000,
                "monthly_contribution": 1000,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["fire_number"] == pytest.approx(1_250_000.0)


class TestWithdrawalTableRequiresBalance:
    def test_missing_starting_balance_returns_422(self, client):
        response = client.post(
            "/api/v2/projections/withdrawal-table",
            json={"withdrawal_rate_or_amount": 0.04},
        )
        assert response.status_code == 422

    def test_with_balance_succeeds(self, client):
        response = client.post(
            "/api/v2/projections/withdrawal-table",
            json={"starting_balance": 1_000_000, "withdrawal_rate_or_amount": 0.04},
        )
        assert response.status_code == 200
        assert "rows" in response.json()


class TestAccountBalancesByType:
    def test_buckets_by_tax_category(self, client):
        payload = {
            "accounts": [
                {
                    "name": "Roth",
                    "account_type": "roth_ira",
                    "positions": [{"ticker": "VTI", "shares": 1, "current_price": 100.0}],
                },
                {
                    "name": "Brokerage",
                    "account_type": "taxable",
                    "positions": [{"ticker": "AAPL", "shares": 1, "current_price": 50.0}],
                },
            ]
        }
        response = client.post("/api/v2/projections/account-balances-by-type", json=payload)
        assert response.status_code == 200
        data = response.json()
        assert data["roth"] == pytest.approx(100.0)
        assert data["taxable"] == pytest.approx(50.0)
        assert data["total"] == pytest.approx(150.0)


class TestTaxProjectionManualIncome:
    def test_requires_all_three_balances(self, client):
        response = client.post(
            "/api/v2/projections/tax-projection?async_mode=false",
            json={
                "current_age": 50,
                "retirement_age": 65,
                "taxable_balance": 100000,
                # missing traditional_balance, roth_balance
                "annual_spending": 60000,
            },
        )
        assert response.status_code == 422

    def test_manual_income_path(self, client):
        response = client.post(
            "/api/v2/projections/tax-projection?async_mode=false",
            json={
                "current_age": 50,
                "retirement_age": 65,
                "taxable_balance": 100000,
                "traditional_balance": 200000,
                "roth_balance": 50000,
                "annual_spending": 60000,
                "use_budget_income": False,
                "manual_pre_retirement_income": 80000,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert "years" in data
        assert "summary" in data

    def test_budget_income_path(self, client):
        response = client.post(
            "/api/v2/projections/tax-projection?async_mode=false",
            json={
                "current_age": 50,
                "retirement_age": 65,
                "taxable_balance": 100000,
                "traditional_balance": 200000,
                "roth_balance": 50000,
                "annual_spending": 60000,
                "use_budget_income": True,
                "budget": {
                    "income_sources": [
                        {"name": "Job", "gross_annual": 90000, "state": "CA", "pay_frequency": "biweekly", "is_active": True}
                    ],
                    "deductions": [],
                },
            },
        )
        assert response.status_code == 200
        assert "years" in response.json()
