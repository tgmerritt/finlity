"""Regression tests for ProfileManager database lifecycle.

Covers the bug where activating a newly-created (EMPTY) profile a second time
raised: ValueError("Database already exists at ... Use force=True to delete and
recreate.") — which propagated to HTTP 400 on every API endpoint.
"""

import tempfile
from pathlib import Path

import pytest

from src.database.profile_manager import ProfileManager


@pytest.fixture
def manager(tmp_path):
    """ProfileManager backed by a fresh temporary directory."""
    return ProfileManager(data_dir=tmp_path)


class TestActivateEmptyProfileTwice:
    """Regression: activating a freshly-created (empty) profile must not raise."""

    def test_activate_new_profile_first_time(self, manager):
        """Activating a brand-new profile succeeds and returns a usable DB."""
        profile = manager.create_profile(name="Alice")
        db = manager.activate_profile(profile.id)
        assert db is not None

    def test_activate_new_profile_second_time_no_error(self, manager):
        """Activating the same empty profile a second time must not raise ValueError."""
        profile = manager.create_profile(name="Bob")
        manager.activate_profile(profile.id)
        # Simulate what get_active_database does when _active_db is cleared:
        manager._active_db = None
        # This previously raised: ValueError("Database already exists...")
        db = manager.activate_profile(profile.id)
        assert db is not None

    def test_get_active_database_after_cache_reset(self, manager):
        """get_active_database after cache clear must not raise.

        reset_database_caches() (module-level) sets _active_db = None and
        _active_profile_id = None on the global manager.  We simulate that
        directly on our local fixture manager to cover the same code path.
        """
        profile = manager.create_profile(name="Carol")
        manager.activate_profile(profile.id)
        # Simulate what reset_database_caches() does on the shared instance
        manager._active_db = None
        manager._active_profile_id = None
        # This is the production trigger path that surfaced as a 400 error
        db = manager.get_active_database()
        assert db is not None

    def test_newly_created_profile_db_is_queryable(self, manager):
        """Opening an empty-schema DB must return a DB that accepts operations."""
        profile = manager.create_profile(name="Dave")
        manager._active_db = None
        db = manager.activate_profile(profile.id)
        # Confirm the DB is functional (account list returns an empty list, not an error)
        accounts = db.get_all_accounts()
        assert isinstance(accounts, list)
