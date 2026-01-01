"""Demo mode manager for dynamic database switching.

Handles switching between demo and real portfolio databases without
requiring a server restart.
"""

import json
import logging
from pathlib import Path
from typing import Optional

from src.database.operations import Database
from src.database.database_manager import DatabaseManager

logger = logging.getLogger(__name__)


class DemoModeManager:
    """Manages demo mode state and database switching.

    Demo mode uses a separate database (data/demo/demo.db) with fake data
    for testing and demonstration purposes.

    State is stored in data/demo_state.json to persist across requests.
    """

    def __init__(self, state_file: str = "data/demo_state.json"):
        self.state_file = Path(state_file)
        self.demo_db_path = Path("data/demo/demo.db")
        self._demo_db: Optional[Database] = None
        self._state: Optional[dict] = None

        # Ensure demo directory exists
        self.demo_db_path.parent.mkdir(parents=True, exist_ok=True)

        # Load state
        self._load_state()

    def _load_state(self) -> None:
        """Load demo mode state from file."""
        if self.state_file.exists():
            try:
                with open(self.state_file, "r") as f:
                    self._state = json.load(f)
            except Exception as e:
                logger.warning(f"Failed to load demo state: {e}")
                self._state = self._default_state()
        else:
            self._state = self._default_state()

    def _save_state(self) -> None:
        """Save demo mode state to file."""
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.state_file, "w") as f:
            json.dump(self._state, f, indent=2)

    def _default_state(self) -> dict:
        """Get default state."""
        return {
            "enabled": False,
            "last_profile_id": "default",
            "demo_initialized": False,
        }

    @property
    def is_enabled(self) -> bool:
        """Check if demo mode is currently enabled."""
        return self._state.get("enabled", False)

    @property
    def last_profile_id(self) -> str:
        """Get the last used profile ID before demo mode."""
        return self._state.get("last_profile_id", "default")

    @property
    def demo_initialized(self) -> bool:
        """Check if demo database has been initialized."""
        return self._state.get("demo_initialized", False) and self.demo_db_path.exists()

    def enable(self, current_profile_id: str) -> dict:
        """Enable demo mode.

        Args:
            current_profile_id: The current profile ID to restore later

        Returns:
            Status dict with success/error info
        """
        if self.is_enabled:
            return {"status": "already_enabled", "enabled": True}

        # Store current profile for later
        self._state["last_profile_id"] = current_profile_id
        self._state["enabled"] = True
        self._save_state()

        # Ensure demo database exists
        if not self.demo_initialized:
            self._initialize_demo_db()

        # Clear cached demo database to force reload
        self._demo_db = None

        logger.info(f"Demo mode enabled, saved last profile: {current_profile_id}")

        return {
            "status": "enabled",
            "enabled": True,
            "last_profile_id": current_profile_id,
            "demo_initialized": self.demo_initialized,
        }

    def disable(self) -> dict:
        """Disable demo mode.

        Returns:
            Status dict with the profile ID to restore
        """
        if not self.is_enabled:
            return {"status": "already_disabled", "enabled": False}

        last_profile = self._state.get("last_profile_id", "default")
        self._state["enabled"] = False
        self._save_state()

        # Clear cached demo database
        self._demo_db = None

        logger.info(f"Demo mode disabled, restore profile: {last_profile}")

        return {
            "status": "disabled",
            "enabled": False,
            "restore_profile_id": last_profile,
        }

    def get_demo_database(self) -> Database:
        """Get the demo database instance.

        Creates the demo database if it doesn't exist.
        """
        if self._demo_db is None:
            if not self.demo_initialized:
                self._initialize_demo_db()

            self._demo_db = Database(str(self.demo_db_path))

        return self._demo_db

    def _initialize_demo_db(self) -> None:
        """Initialize an empty demo database with schema."""
        # If database already exists, just mark as initialized
        if self.demo_db_path.exists():
            self._state["demo_initialized"] = True
            self._save_state()
            logger.info("Demo database already exists, marked as initialized")
            return

        manager = DatabaseManager(str(self.demo_db_path))
        manager.initialize()
        self._state["demo_initialized"] = True
        self._save_state()
        logger.info("Initialized empty demo database")

    def generate_demo_data(self) -> dict:
        """Generate demo portfolio data.

        Returns:
            Result dict with generation status
        """
        import sys
        from pathlib import Path

        # Add scripts to path
        scripts_path = Path(__file__).parent.parent.parent / "scripts"
        if str(scripts_path) not in sys.path:
            sys.path.insert(0, str(scripts_path))

        try:
            from scripts.generate_demo import generate_demo_data as run_generator
            result = run_generator()

            self._state["demo_initialized"] = True
            self._save_state()

            # Clear cached database to pick up new data
            self._demo_db = None

            return result
        except Exception as e:
            import traceback
            logger.error(f"Failed to generate demo data: {e}")
            return {
                "error": str(e),
                "traceback": traceback.format_exc(),
            }

    def reset_demo_data(self) -> dict:
        """Reset demo database (delete and regenerate).

        Returns:
            Result dict with reset status
        """
        # Delete existing demo database
        if self.demo_db_path.exists():
            self.demo_db_path.unlink()

        self._demo_db = None
        self._state["demo_initialized"] = False
        self._save_state()

        return {"status": "reset", "message": "Demo database deleted"}

    def get_status(self) -> dict:
        """Get current demo mode status."""
        return {
            "enabled": self.is_enabled,
            "last_profile_id": self.last_profile_id,
            "demo_initialized": self.demo_initialized,
            "demo_db_path": str(self.demo_db_path),
            "demo_db_exists": self.demo_db_path.exists(),
        }


# Global instance
_demo_manager: Optional[DemoModeManager] = None


def get_demo_manager() -> DemoModeManager:
    """Get the global DemoModeManager instance."""
    global _demo_manager
    if _demo_manager is None:
        _demo_manager = DemoModeManager()
    return _demo_manager


def is_demo_mode() -> bool:
    """Check if demo mode is enabled."""
    return get_demo_manager().is_enabled
