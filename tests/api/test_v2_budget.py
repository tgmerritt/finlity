"""Tests for /api/v2/budget/* — calculate-annual and paycheck-chart-data
from payload arrays (no DB), plus the pass-through calculate-paycheck and
social-security endpoints.
"""

import pytest
from fastapi.testclient import TestClient

from src.main import app


@pytest.fixture(scope="module")
def client():
    return TestClient(app)


class TestCalculatePaycheck:
    def test_calculate_paycheck(self, client):
        response = client.post(
            "/api/v2/budget/calculate-paycheck",
            json={"gross_per_period": 4000, "pay_frequency": "biweekly", "filing_status": "single", "state": "CA"},
        )
        assert response.status_code == 200
        data = response.json()
        assert "net_pay" in data
        assert data["gross"] == pytest.approx(4000.0)


class TestSocialSecurity:
    def test_social_security_estimate(self, client):
        response = client.post(
            "/api/v2/budget/social-security",
            json={"annual_income": 100000, "current_age": 40},
        )
        assert response.status_code == 200
        data = response.json()
        assert "estimate" in data
        assert "comparison_by_age" in data


class TestCalculateAnnual:
    def test_calculate_annual_from_payload(self, client):
        response = client.post(
            "/api/v2/budget/calculate-annual",
            json={
                "income_sources": [
                    {"name": "Job", "gross_annual": 100000, "state": "CA", "pay_frequency": "biweekly", "is_active": True}
                ],
                "expenses": [
                    {"name": "Rent", "amount": 2000, "frequency": "monthly", "category_name": "Housing", "is_active": True, "is_pretax": False}
                ],
                "deductions": [],
                "filing_status": "single",
                "tax_year": 2024,
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["gross_income"] == pytest.approx(100000.0)
        assert data["total_expenses"] == pytest.approx(24000.0)
        assert data["expenses_by_category"] == {"Housing": pytest.approx(24000.0)}

    def test_calculate_annual_no_income_sources(self, client):
        response = client.post(
            "/api/v2/budget/calculate-annual",
            json={"income_sources": [], "expenses": [], "deductions": []},
        )
        assert response.status_code == 200
        assert response.json()["gross_income"] == 0

    def test_calculate_annual_excludes_pretax_expenses(self, client):
        response = client.post(
            "/api/v2/budget/calculate-annual",
            json={
                "income_sources": [
                    {"name": "Job", "gross_annual": 100000, "state": "CA", "pay_frequency": "biweekly", "is_active": True}
                ],
                "expenses": [
                    {"name": "401k contribution", "amount": 1000, "frequency": "monthly", "category_name": "Retirement", "is_active": True, "is_pretax": True},
                    {"name": "Rent", "amount": 2000, "frequency": "monthly", "category_name": "Housing", "is_active": True, "is_pretax": False},
                ],
                "deductions": [],
            },
        )
        assert response.status_code == 200
        data = response.json()
        # Only the non-pretax expense counts toward total_expenses.
        assert data["total_expenses"] == pytest.approx(24000.0)
        assert "Retirement" not in data["expenses_by_category"]


class TestPaycheckChartData:
    def test_paycheck_chart_data_from_payload(self, client):
        response = client.post(
            "/api/v2/budget/paycheck-chart-data",
            json={
                "income_sources": [
                    {"id": "src-1", "name": "Job", "gross_annual": 100000, "state": "CA", "pay_frequency": "biweekly", "is_active": True}
                ],
                "deductions": [
                    {"income_source_id": "src-1", "deduction_type": "401k", "amount_per_period": 200}
                ],
                "expenses": [],
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert data["pay_frequency"] == "biweekly"
        assert len(data["periods"]) == 26
        assert len(data["gross"]) == 26
        # Cumulative gross in the final period should equal annual gross.
        assert data["gross"][-1] == pytest.approx(100000.0, abs=1.0)

    def test_paycheck_chart_data_no_active_sources(self, client):
        response = client.post(
            "/api/v2/budget/paycheck-chart-data",
            json={"income_sources": [], "deductions": [], "expenses": []},
        )
        assert response.status_code == 200
        assert response.json() == {"periods": [], "data": []}


class TestIncomeTransition:
    def test_income_transition_from_payload(self, client):
        response = client.post(
            "/api/v2/budget/income-transition",
            json={
                "current_age": 40,
                "retirement_age": 65,
                "income_sources": [
                    {"name": "Job", "gross_annual": 100000, "state": "CA", "pay_frequency": "biweekly", "is_active": True}
                ],
                "expenses": [],
            },
        )
        assert response.status_code == 200
        data = response.json()
        assert "years" in data
        assert data["years"][0]["is_retired"] is False
