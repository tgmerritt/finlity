"""
Tests for Settings API endpoints.
"""

import pytest


class TestSettingsAPI:
    """Test settings API endpoints."""

    def test_get_config(self, client):
        """Test getting full configuration."""
        response = client.get("/api/settings/config")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)

    def test_get_demo_mode_status(self, client):
        """Test getting demo mode status."""
        response = client.get("/api/settings/demo-mode")
        assert response.status_code == 200
        data = response.json()
        assert "enabled" in data or "demo_mode" in data or isinstance(data, bool)

    def test_get_api_key_status(self, client):
        """Test getting API key status."""
        response = client.get("/api/settings/api-keys/status")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)


class TestProfilesAPI:
    """Test profile management endpoints."""

    def test_list_profiles(self, client):
        """Test listing profiles."""
        response = client.get("/api/profiles")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_get_active_profile(self, client):
        """Test getting active profile."""
        response = client.get("/api/profiles/active")
        assert response.status_code == 200
        data = response.json()
        assert "id" in data or "profile_id" in data or data is None


class TestProjectionsAPI:
    """Test projection endpoints."""

    def test_monte_carlo_projection(self, client):
        """Test Monte Carlo projection."""
        projection_data = {
            "current_age": 35,
            "retirement_age": 65,
            "current_savings": 500000,
            "monthly_contribution": 1667,
            "monthly_withdrawal": 3333
        }
        response = client.post("/api/projections/monte-carlo", json=projection_data)
        assert response.status_code == 200
        data = response.json()
        assert "success_rate" in data
        assert "median_values" in data

    def test_withdrawal_table(self, client):
        """Test withdrawal table generation."""
        table_data = {
            "current_age": 35,
            "retirement_age": 65,
            "end_age": 95,
            "current_savings": 500000,
            "monthly_contribution": 1667,
            "monthly_withdrawal": 3333,
            "withdrawal_rate_or_amount": 40000
        }
        response = client.post("/api/projections/withdrawal-table", json=table_data)
        assert response.status_code == 200
        data = response.json()
        assert "rows" in data
        assert "success" in data
