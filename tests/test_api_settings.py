"""
Tests for Settings API endpoints.
"""

import json
from datetime import date

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


class TestUserAgeInterface:
    """The single canonical interface for user age (``src.api.settings``).

    Age must come from the date of birth stored in the database, and fall back
    to 35 whenever it is unknown, missing, or corrupt.
    """

    @pytest.fixture(autouse=True)
    def _isolate_personal_settings(self, client):
        """Snapshot and restore the ``personal_settings`` row around each test.

        Depends on ``client`` so the test environment (and thus the test
        database) is initialized before we touch it.
        """
        from src.database import get_database

        db = get_database()
        original = db.get_setting("personal_settings")
        original_value = original.value if original else None
        yield
        db.set_setting("personal_settings", original_value if original_value is not None else "")

    @staticmethod
    def _set_personal(value: str) -> None:
        from src.database import get_database

        get_database().set_setting("personal_settings", value)

    @staticmethod
    def _dob_for_age(age: int) -> str:
        """A Jan-1 date of birth that yields exactly ``age`` today."""
        return date(date.today().year - age, 1, 1).isoformat()

    def test_age_computed_from_stored_dob(self):
        from src.api.settings import get_user_age

        self._set_personal(json.dumps({"dob": self._dob_for_age(44)}))
        assert get_user_age() == 44

    def test_missing_personal_settings_falls_back_to_35(self):
        from src.api.settings import get_user_age

        self._set_personal("")  # absent/empty row
        assert get_user_age() == 35

    def test_corrupt_json_falls_back_to_35(self):
        from src.api.settings import get_user_age

        self._set_personal("{not valid json")
        assert get_user_age() == 35

    def test_missing_dob_key_falls_back_to_35(self):
        from src.api.settings import get_user_age

        self._set_personal(json.dumps({"retirement_age": 60}))
        assert get_user_age() == 35

    def test_unparseable_dob_falls_back_to_35(self):
        from src.api.settings import get_user_age

        self._set_personal(json.dumps({"dob": "not-a-date"}))
        assert get_user_age() == 35

    def test_future_dob_falls_back_to_35(self):
        from src.api.settings import get_user_age

        future = date(date.today().year + 5, 1, 1).isoformat()
        self._set_personal(json.dumps({"dob": future}))
        assert get_user_age() == 35

    def test_retirement_age_from_stored_value(self):
        from src.api.settings import get_retirement_age

        self._set_personal(json.dumps({"dob": self._dob_for_age(44), "retirement_age": 62}))
        assert get_retirement_age() == 62

    def test_retirement_age_falls_back_to_65(self):
        from src.api.settings import get_retirement_age

        self._set_personal(json.dumps({"dob": self._dob_for_age(44)}))
        assert get_retirement_age() == 65

    def test_retirement_age_corrupt_falls_back_to_65(self):
        from src.api.settings import get_retirement_age

        self._set_personal("{garbage")
        assert get_retirement_age() == 65


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
