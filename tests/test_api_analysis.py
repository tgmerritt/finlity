"""
Tests for Analysis API endpoints.
"""

import pytest


class TestAnalysisAPI:
    """Test analysis API endpoints."""

    def test_get_allocation(self, client):
        """Test getting basic allocation breakdown."""
        response = client.get("/api/analysis/allocation")
        assert response.status_code == 200
        data = response.json()
        assert "by_account_type" in data or "total" in data or isinstance(data, dict)

    def test_get_detailed_allocation(self, client):
        """Test getting detailed allocation breakdown."""
        response = client.get("/api/analysis/allocation/detailed")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)

    def test_get_performance_metrics(self, client):
        """Test getting performance metrics."""
        response = client.get("/api/analysis/performance")
        assert response.status_code == 200
        data = response.json()
        # Should return performance data or empty structure
        assert isinstance(data, dict)

    def test_get_risk_metrics(self, client):
        """Test getting risk metrics."""
        response = client.get("/api/analysis/risk")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, dict)


class TestTriggersAPI:
    """Test allocation triggers API."""

    def test_list_triggers(self, client):
        """Test listing triggers."""
        response = client.get("/api/analysis/triggers")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_create_trigger(self, client, sample_trigger):
        """Test creating a trigger."""
        response = client.post("/api/analysis/triggers", json=sample_trigger)
        assert response.status_code == 200
        data = response.json()
        assert data["name"] == sample_trigger["name"]
        assert data["condition_type"] == sample_trigger["condition_type"]
        assert "id" in data

    def test_evaluate_triggers(self, client):
        """Test evaluating triggers."""
        response = client.get("/api/analysis/triggers/evaluate")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)

    def test_get_triggered_alerts(self, client):
        """Test getting triggered alerts."""
        response = client.get("/api/analysis/triggers/triggered")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, list)


class TestWidgetsAPI:
    """Test widget endpoints."""

    def test_list_widgets(self, client):
        """Test listing available widgets."""
        response = client.get("/api/analysis/widgets")
        assert response.status_code == 200
        data = response.json()
        assert isinstance(data, (list, dict))
