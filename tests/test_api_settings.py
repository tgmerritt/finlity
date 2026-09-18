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

    def test_demo_export_requires_demo_enabled(self, client):
        """404 when demo mode is off — the export must never leak real data.

        Flips demo mode OFF through the manager's own state API (the test
        suite runs against a throwaway PORTFOLIO_DATA_DIR seeded at import
        time), asserts the gate, then restores via enable().
        """
        from src.services.demo_mode import get_demo_manager

        manager = get_demo_manager()
        profile_id = manager.last_profile_id
        manager.disable()
        try:
            response = client.get("/api/settings/demo-mode/export")
            assert response.status_code == 404
        finally:
            manager.enable(profile_id)

        # Sanity: with demo restored, the export is reachable again.
        assert client.get("/api/settings/demo-mode/export").status_code == 200

    def test_demo_export_returns_synthetic_dataset(self, client):
        """Locked-demo servers export accounts/positions/snapshots for seeding.

        conftest runs the whole suite with PORTFOLIO_DEMO_MODE=true against an
        isolated data dir seeded from the tracked demo.db — the endpoint's
        production posture, exercised as-is.
        """
        response = client.get("/api/settings/demo-mode/export")
        assert response.status_code == 200
        data = response.json()
        # NB: not absolute counts — other suites legitimately create accounts
        # in the shared isolated demo DB (demo mode redirects writes there).
        # The contract is: canonical demo accounts present, positions cover
        # them, individuals-only entities, snapshots exist.
        names = {a["name"] for a in data["accounts"]}
        assert {"Company 401k", "Roth IRA", "Taxable Brokerage"} <= names
        assert len(data["positions"]) >= 48
        assert len(data["entities"]) >= 2  # john-demo, jane-demo
        assert all(not e.get("is_household") for e in data["entities"])
        assert data["snapshots"], "expected at least one snapshot"
        # Referential integrity: every position points at an exported account
        account_ids = {a["id"] for a in data["accounts"]}
        assert all(p["account_id"] in account_ids for p in data["positions"])

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


class TestDemoModeHerokuLock:
    """Demo mode must stay ON for visitors of the hosted (Heroku) site.

    The demo toggle writes server-global state, so on the public deployment
    one visitor switching it off would flip the whole site to an empty
    personal portfolio until the next dyno restart. When DYNO is present the
    disable path is blocked with 403 unless PORTFOLIO_ALLOW_DEMO_DISABLE
    explicitly opts back in.
    """

    @pytest.fixture(autouse=True)
    def _restore_demo_mode(self, client):
        """Leave demo mode enabled for the rest of the module."""
        yield
        from src.services.demo_mode import get_demo_manager
        get_demo_manager().enable("default")

    def test_disable_blocked_on_heroku(self, client, monkeypatch):
        monkeypatch.setenv("DYNO", "web.1")
        monkeypatch.delenv("PORTFOLIO_ALLOW_DEMO_DISABLE", raising=False)
        response = client.put("/api/settings/demo-mode", json={"enabled": False})
        assert response.status_code == 403
        # And the state must not have flipped
        status = client.get("/api/settings/demo-mode").json()
        assert status["enabled"] is True

    def test_enable_still_allowed_on_heroku(self, client, monkeypatch):
        monkeypatch.setenv("DYNO", "web.1")
        response = client.put("/api/settings/demo-mode", json={"enabled": True})
        assert response.status_code == 200

    def test_disable_allowed_with_escape_hatch(self, client, monkeypatch):
        monkeypatch.setenv("DYNO", "web.1")
        monkeypatch.setenv("PORTFOLIO_ALLOW_DEMO_DISABLE", "true")
        response = client.put("/api/settings/demo-mode", json={"enabled": False})
        assert response.status_code == 200

    def test_disable_allowed_off_heroku(self, client, monkeypatch):
        monkeypatch.delenv("DYNO", raising=False)
        response = client.put("/api/settings/demo-mode", json={"enabled": False})
        assert response.status_code == 200

    def test_status_reports_lock_on_heroku(self, client, monkeypatch):
        monkeypatch.setenv("DYNO", "web.1")
        monkeypatch.delenv("PORTFOLIO_ALLOW_DEMO_DISABLE", raising=False)
        status = client.get("/api/settings/demo-mode").json()
        assert status["disable_locked"] is True

    def test_status_reports_unlocked_off_heroku(self, client, monkeypatch):
        monkeypatch.delenv("DYNO", raising=False)
        status = client.get("/api/settings/demo-mode").json()
        assert status["disable_locked"] is False


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
