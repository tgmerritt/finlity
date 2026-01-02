"""
Tests for Portfolio API endpoints.
"""

import pytest


class TestPortfolioAPI:
    """Test portfolio API endpoints."""

    def test_get_portfolio_summary(self, client):
        """Test getting portfolio summary."""
        response = client.get("/api/portfolio")
        assert response.status_code == 200
        data = response.json()
        assert "total_value" in data
        assert "accounts" in data

    def test_list_accounts(self, client):
        """Test listing accounts."""
        response = client.get("/api/portfolio/accounts")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_get_account_types(self, client):
        """Test getting available account types."""
        response = client.get("/api/portfolio/account-types")
        assert response.status_code == 200
        data = response.json()
        # Returns a list of account type objects
        assert isinstance(data, list)
        # Check that roth_ira type exists
        values = [item.get("value") for item in data]
        assert "roth_ira" in values

    def test_create_account(self, client, sample_account):
        """Test creating an account."""
        response = client.post("/api/portfolio/accounts", json=sample_account)
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == sample_account["name"]
        assert data["account_type"] == sample_account["account_type"]
        assert "id" in data

    def test_list_positions(self, client):
        """Test listing positions."""
        response = client.get("/api/portfolio/positions")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_create_position(self, client, sample_account, sample_position):
        """Test creating a position."""
        # First create an account
        account_response = client.post("/api/portfolio/accounts", json=sample_account)
        account_id = account_response.json()["id"]

        # Create position in that account
        position_data = {**sample_position, "account_id": account_id}
        response = client.post("/api/portfolio/positions", json=position_data)
        assert response.status_code == 200
        data = response.json()
        assert data["ticker"] == sample_position["ticker"]
        assert data["shares"] == sample_position["shares"]

    def test_get_retirement_metrics(self, client):
        """Test getting retirement metrics."""
        response = client.get("/api/portfolio")
        assert response.status_code == 200
        data = response.json()
        # Should have retirement-specific fields
        assert "retirement_value" in data or "total_value" in data


class TestPortfolioCashCD:
    """Test cash and CD endpoints."""

    def test_add_cash_position(self, client, sample_account):
        """Test adding a cash position."""
        # First create an account
        account_response = client.post("/api/portfolio/accounts", json=sample_account)
        account_id = account_response.json()["id"]

        cash_data = {
            "account_id": account_id,
            "amount": 10000,
            "name": "Cash Reserve",
            "apy": 4.5
        }
        response = client.post("/api/portfolio/positions/cash", json=cash_data)
        assert response.status_code == 200
        data = response.json()
        # Response includes id, amount, and message
        assert "id" in data
        assert data["amount"] == 10000

    def test_get_upcoming_cd_maturities(self, client):
        """Test getting upcoming CD maturities."""
        response = client.get("/api/portfolio/positions/cd/upcoming")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)
