"""
Tests for Settings API endpoints.
"""


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

    def test_settings_version_shape(self, client):
        """The version probe always returns an ``updated_at`` key."""
        response = client.get("/api/settings/version")
        assert response.status_code == 200
        data = response.json()
        assert "updated_at" in data
        # Either None (nothing saved yet) or an ISO 8601 string.
        assert data["updated_at"] is None or isinstance(data["updated_at"], str)

    def test_settings_version_advances_after_save(self, client):
        """Saving personal settings bumps the settings version forward.

        This is what lets the frontend cheaply detect that its in-memory copy
        is stale and re-pull the settings (e.g. the age fields) on navigation.
        """
        before = client.get("/api/settings/version").json()["updated_at"]

        resp = client.put(
            "/api/settings/config/personal",
            json={
                "dob": "1985-06-15",
                "retirement_age": 65,
                "withdrawal_rate": 4,
                "target_monthly_income": 0,
                "avg_annual_growth_real": 0.06,
                "ss_claiming_age": 67,
            },
        )
        assert resp.status_code == 200

        after = client.get("/api/settings/version").json()["updated_at"]
        assert after is not None
        # Newer-or-equal as a lexicographic ISO string; never goes backwards.
        if before is not None:
            assert after >= before


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
