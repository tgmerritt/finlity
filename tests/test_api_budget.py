"""
Tests for Budget API endpoints.
"""

import pytest


class TestBudgetIncomeAPI:
    """Test budget income endpoints."""

    def test_list_income_sources(self, client):
        """Test listing income sources."""
        response = client.get("/api/budget/income")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_create_income_source(self, client, sample_income_source):
        """Test creating an income source."""
        response = client.post("/api/budget/income", json=sample_income_source)
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == sample_income_source["name"]
        assert data["gross_annual"] == sample_income_source["gross_annual"]
        assert "id" in data

    def test_update_income_source(self, client, sample_income_source):
        """Test updating an income source."""
        # First create
        create_response = client.post("/api/budget/income", json=sample_income_source)
        income_id = create_response.json()["id"]

        # Update
        update_data = {"gross_annual": 120000}
        response = client.put(f"/api/budget/income/{income_id}", json=update_data)
        assert response.status_code == 200
        data = response.json()
        assert data.get("updated") is True or "id" in data

    def test_delete_income_source(self, client, sample_income_source):
        """Test deleting an income source."""
        # First create
        create_response = client.post("/api/budget/income", json=sample_income_source)
        income_id = create_response.json()["id"]

        # Delete
        response = client.delete(f"/api/budget/income/{income_id}")
        assert response.status_code == 200


class TestBudgetExpensesAPI:
    """Test budget expense endpoints."""

    def test_list_expenses(self, client):
        """Test listing expenses."""
        response = client.get("/api/budget/expenses")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_get_expense_categories(self, client):
        """Test getting expense categories."""
        response = client.get("/api/budget/expense-categories")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_create_expense(self, client, sample_expense):
        """Test creating an expense."""
        response = client.post("/api/budget/expenses", json=sample_expense)
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == sample_expense["name"]
        assert "id" in data


class TestBudgetDeductionsAPI:
    """Test budget deduction endpoints."""

    def test_list_deductions(self, client):
        """Test listing deductions."""
        response = client.get("/api/budget/deductions")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_create_deduction(self, client):
        """Test creating a deduction."""
        deduction_data = {
            "deduction_type": "401k",
            "amount_per_period": 500,
            "employer_match": 3.0
        }
        response = client.post("/api/budget/deductions", json=deduction_data)
        assert response.status_code == 200
        data = response.json()
        assert data["deduction_type"] == "401k"
        assert "id" in data


class TestBudgetCalculationsAPI:
    """Test budget calculation endpoints."""

    def test_calculate_paycheck(self, client):
        """Test paycheck calculation."""
        paycheck_data = {
            "gross_per_period": 3846.15,
            "pay_frequency": "biweekly",
            "filing_status": "single",
            "state": "CA"
        }
        response = client.post("/api/budget/calculate-paycheck", json=paycheck_data)
        assert response.status_code == 200
        data = response.json()
        assert "gross" in data or "gross_pay" in data
        assert "net_pay" in data
        assert "federal_income_tax" in data

    def test_calculate_annual_summary(self, client, sample_income_source):
        """Test annual budget calculation."""
        # First create an income source
        client.post("/api/budget/income", json=sample_income_source)

        # Calculate annual
        calc_data = {
            "filing_status": "single",
            "state": "CA",
            "tax_year": 2024
        }
        response = client.post("/api/budget/calculate-annual", json=calc_data)
        assert response.status_code == 200
        data = response.json()
        assert "gross_income" in data
        assert "total_taxes" in data
        assert "net_income" in data

    def test_paycheck_chart_data(self, client, sample_income_source):
        """Test getting paycheck chart data."""
        # First create an income source
        client.post("/api/budget/income", json=sample_income_source)

        response = client.get("/api/budget/paycheck-chart-data")
        assert response.status_code == 200
        data = response.json()
        assert "periods" in data


class TestTaxConfigAPI:
    """Test tax configuration endpoints."""

    def test_get_tax_config(self, client):
        """Test getting tax configuration."""
        response = client.get("/api/budget/tax-config")
        assert response.status_code == 200
        data = response.json()
        assert "filing_status" in data
        assert "state" in data

    def test_update_tax_config(self, client):
        """Test updating tax configuration."""
        config_data = {
            "filing_status": "married_joint",
            "state": "TX"
        }
        response = client.put("/api/budget/tax-config", json=config_data)
        assert response.status_code == 200
        data = response.json()
        # Response is {"updated": true} or full config
        assert data.get("updated") is True or "filing_status" in data
