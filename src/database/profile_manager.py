"""Profile management for multi-database support.

Allows financial advisors and users to manage multiple separate portfolios
with complete data isolation between clients/families.

Uses DatabaseManager for proper database lifecycle:
- Existence checking
- Integrity validation
- First-time initialization
- Corruption recovery
"""

import json
import logging
import shutil
import zipfile
from dataclasses import dataclass, field, asdict
from datetime import datetime
from pathlib import Path
from typing import Optional, Callable
import re
import os

from .operations import Database
from .database_manager import DatabaseManager, DatabaseStatus, DatabaseCheckResult

logger = logging.getLogger(__name__)


@dataclass
class Profile:
    """Represents a database profile."""
    id: str
    name: str
    description: str = ""
    created_at: str = field(default_factory=lambda: datetime.now().isoformat())
    last_accessed: str = field(default_factory=lambda: datetime.now().isoformat())
    icon: str = "user"
    color: str = "#4A90D9"

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "Profile":
        """Create Profile from dictionary."""
        return cls(**data)


@dataclass
class ProfilesConfig:
    """Configuration for all profiles."""
    profiles: list[Profile] = field(default_factory=list)
    active_profile: str = "default"

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "profiles": [p.to_dict() for p in self.profiles],
            "active_profile": self.active_profile,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "ProfilesConfig":
        """Create ProfilesConfig from dictionary."""
        profiles = [Profile.from_dict(p) for p in data.get("profiles", [])]
        return cls(
            profiles=profiles,
            active_profile=data.get("active_profile", "default"),
        )


class ProfileManager:
    """Manages multiple database profiles for multi-tenant support.

    Each profile has:
    - Its own SQLite database (portfolio.db)
    - Its own fund metadata cache (funds.yaml)
    - Its own import folders

    Usage:
        manager = ProfileManager()
        manager.activate_profile("client-smith")
        db = manager.get_active_database()
    """

    # Default colors for new profiles
    PROFILE_COLORS = [
        "#4A90D9",  # Blue
        "#2ECC71",  # Green
        "#E74C3C",  # Red
        "#9B59B6",  # Purple
        "#F39C12",  # Orange
        "#1ABC9C",  # Teal
        "#E91E63",  # Pink
        "#00BCD4",  # Cyan
    ]

    # Icons available for profiles
    PROFILE_ICONS = [
        "user",
        "briefcase",
        "home",
        "building",
        "users",
        "star",
        "heart",
        "folder",
    ]

    def __init__(self, data_dir: str = "data/databases"):
        """Initialize the profile manager.

        Args:
            data_dir: Base directory for all profile databases
        """
        self.data_dir = Path(data_dir)
        self.profiles_file = self.data_dir / "profiles.json"
        self._config: Optional[ProfilesConfig] = None
        self._active_db: Optional[Database] = None
        self._active_profile_id: Optional[str] = None

        # Ensure data directory exists
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # Load or initialize configuration
        self._load_config()

    def _load_config(self) -> None:
        """Load profiles configuration from disk."""
        if self.profiles_file.exists():
            with open(self.profiles_file, "r") as f:
                data = json.load(f)
                self._config = ProfilesConfig.from_dict(data)
        else:
            # Check if we need to migrate existing data
            self._migrate_existing_data()

    def _save_config(self) -> None:
        """Save profiles configuration to disk."""
        with open(self.profiles_file, "w") as f:
            json.dump(self._config.to_dict(), f, indent=2)

    def _migrate_existing_data(self) -> None:
        """Migrate existing portfolio.db to the new profile structure."""
        old_db_path = Path("data/portfolio.db")
        old_funds_path = Path("funds.yaml")
        old_imports_path = Path("data/imports")

        # Create default profile
        default_profile = Profile(
            id="default",
            name="My Portfolio",
            description="Default portfolio (migrated)",
            icon="user",
            color=self.PROFILE_COLORS[0],
        )

        self._config = ProfilesConfig(
            profiles=[default_profile],
            active_profile="default",
        )

        # Create default profile directory
        default_dir = self.data_dir / "default"
        default_dir.mkdir(parents=True, exist_ok=True)

        # Move existing database if it exists
        if old_db_path.exists():
            shutil.copy2(old_db_path, default_dir / "portfolio.db")

        # Copy funds.yaml if it exists
        if old_funds_path.exists():
            shutil.copy2(old_funds_path, default_dir / "funds.yaml")

        # Create imports directory structure
        imports_dir = default_dir / "imports"
        imports_dir.mkdir(exist_ok=True)

        # Create standard import folders
        from src.models.account_types import PREDEFINED_ACCOUNT_TYPES
        for account_type in PREDEFINED_ACCOUNT_TYPES:
            (imports_dir / account_type).mkdir(exist_ok=True)

        self._save_config()

    def _get_profile_dir(self, profile_id: str) -> Path:
        """Get the directory path for a profile."""
        return self.data_dir / profile_id

    def _get_db_path(self, profile_id: str) -> str:
        """Get the database path for a profile."""
        return str(self._get_profile_dir(profile_id) / "portfolio.db")

    def get_profile_db_path(self, profile_id: str) -> Path:
        """Get the database path for a profile (public method)."""
        return self._get_profile_dir(profile_id) / "portfolio.db"

    def _get_funds_path(self, profile_id: str) -> str:
        """Get the funds.yaml path for a profile."""
        return str(self._get_profile_dir(profile_id) / "funds.yaml")

    def _get_imports_path(self, profile_id: str) -> Path:
        """Get the imports directory for a profile."""
        return self._get_profile_dir(profile_id) / "imports"

    def _generate_id(self, name: str) -> str:
        """Generate a unique profile ID from a name."""
        # Convert to lowercase, replace spaces with hyphens
        base_id = re.sub(r'[^a-z0-9]+', '-', name.lower()).strip('-')
        if not base_id:
            base_id = "profile"

        # Ensure uniqueness
        candidate = base_id
        counter = 1
        existing_ids = {p.id for p in self._config.profiles}
        while candidate in existing_ids:
            candidate = f"{base_id}-{counter}"
            counter += 1

        return candidate

    def _get_next_color(self) -> str:
        """Get the next color for a new profile."""
        used_colors = {p.color for p in self._config.profiles}
        for color in self.PROFILE_COLORS:
            if color not in used_colors:
                return color
        # If all colors used, cycle back
        return self.PROFILE_COLORS[len(self._config.profiles) % len(self.PROFILE_COLORS)]

    # ==================== Public API ====================

    def list_profiles(self) -> list[Profile]:
        """List all available profiles."""
        return self._config.profiles.copy()

    def get_profile(self, profile_id: str) -> Optional[Profile]:
        """Get a profile by ID."""
        for profile in self._config.profiles:
            if profile.id == profile_id:
                return profile
        return None

    def get_active_profile(self) -> Optional[Profile]:
        """Get the currently active profile."""
        return self.get_profile(self._config.active_profile)

    def get_active_profile_id(self) -> str:
        """Get the ID of the currently active profile."""
        return self._config.active_profile

    def create_profile(
        self,
        name: str,
        description: str = "",
        icon: str = "user",
        color: Optional[str] = None,
    ) -> Profile:
        """Create a new profile.

        Args:
            name: Display name for the profile
            description: Optional description
            icon: Icon identifier
            color: Hex color code (auto-assigned if not provided)

        Returns:
            The created Profile
        """
        profile_id = self._generate_id(name)
        profile_color = color or self._get_next_color()

        profile = Profile(
            id=profile_id,
            name=name,
            description=description,
            icon=icon,
            color=profile_color,
        )

        # Create profile directory structure
        profile_dir = self._get_profile_dir(profile_id)
        profile_dir.mkdir(parents=True, exist_ok=True)

        # Create imports directory with standard folders
        imports_dir = self._get_imports_path(profile_id)
        imports_dir.mkdir(exist_ok=True)

        from src.models.account_types import PREDEFINED_ACCOUNT_TYPES
        for account_type in PREDEFINED_ACCOUNT_TYPES:
            (imports_dir / account_type).mkdir(exist_ok=True)

        # Initialize empty database using DatabaseManager
        db_path = self._get_db_path(profile_id)
        manager = DatabaseManager(db_path)
        manager.initialize()  # Creates schema with proper versioning

        # Add to config and save
        self._config.profiles.append(profile)
        self._save_config()

        return profile

    def update_profile(
        self,
        profile_id: str,
        name: Optional[str] = None,
        description: Optional[str] = None,
        icon: Optional[str] = None,
        color: Optional[str] = None,
    ) -> Optional[Profile]:
        """Update a profile's metadata.

        Args:
            profile_id: ID of the profile to update
            name: New display name (optional)
            description: New description (optional)
            icon: New icon (optional)
            color: New color (optional)

        Returns:
            The updated Profile, or None if not found
        """
        profile = self.get_profile(profile_id)
        if not profile:
            return None

        if name is not None:
            profile.name = name
        if description is not None:
            profile.description = description
        if icon is not None:
            profile.icon = icon
        if color is not None:
            profile.color = color

        self._save_config()
        return profile

    def delete_profile(self, profile_id: str) -> bool:
        """Delete a profile and all its data.

        Args:
            profile_id: ID of the profile to delete

        Returns:
            True if deleted, False if not found or is active profile
        """
        if profile_id == self._config.active_profile:
            raise ValueError("Cannot delete the active profile. Switch to another profile first.")

        if profile_id == "default":
            raise ValueError("Cannot delete the default profile.")

        profile = self.get_profile(profile_id)
        if not profile:
            return False

        # Remove profile directory
        profile_dir = self._get_profile_dir(profile_id)
        if profile_dir.exists():
            shutil.rmtree(profile_dir)

        # Remove from config
        self._config.profiles = [p for p in self._config.profiles if p.id != profile_id]
        self._save_config()

        return True

    def check_database_status(self, profile_id: str) -> DatabaseCheckResult:
        """Check the status of a profile's database.

        Uses DatabaseManager to perform integrity and validation checks.

        Args:
            profile_id: ID of the profile to check

        Returns:
            DatabaseCheckResult with status and details
        """
        db_path = self._get_db_path(profile_id)
        manager = DatabaseManager(db_path)
        return manager.check()

    def activate_profile(
        self,
        profile_id: str,
        seed_callback: Optional[Callable[[Database], None]] = None,
    ) -> Database:
        """Switch to a different profile.

        Uses DatabaseManager to ensure database is valid before activation.
        If the database doesn't exist or is empty, it will be initialized.
        If the database is corrupt, it will be recovered (with backup).

        Args:
            profile_id: ID of the profile to activate
            seed_callback: Optional callback to seed new databases with data

        Returns:
            Database instance for the activated profile
        """
        profile = self.get_profile(profile_id)
        if not profile:
            raise ValueError(f"Profile not found: {profile_id}")

        # Update last accessed time
        profile.last_accessed = datetime.now().isoformat()

        # Update active profile
        self._config.active_profile = profile_id
        self._save_config()

        # Close existing database connection
        self._active_db = None
        self._active_profile_id = profile_id

        # Use DatabaseManager for proper lifecycle handling
        db_path = self._get_db_path(profile_id)
        manager = DatabaseManager(db_path)
        result = manager.check()

        if result.is_usable:
            # Database exists and is valid - use as source of truth
            self._active_db = manager.get_database()
        elif result.needs_initialization:
            # First-time setup or empty database
            self._active_db = manager.initialize(seed_callback=seed_callback)
            logger.info(f"Initialized new database for profile_id={profile_id}")
        elif result.needs_recovery:
            # Corrupt database - backup and re-initialize
            logger.warning(f"Database corrupt for profile_id={profile_id}: {result.error_message}")
            backup_dir = self._get_profile_dir(profile_id)
            self._active_db = manager.recover(
                backup_dir=backup_dir,
                seed_callback=seed_callback,
            )
            logger.info(f"Recovered database for profile_id={profile_id}")
        elif result.status == DatabaseStatus.SCHEMA_MISMATCH:
            # Schema version mismatch - for now, just open it and let migrations run
            # Future: could add explicit migration handling here
            self._active_db = manager.get_database()
            logger.info(f"Schema version mismatch for profile_id={profile_id}, running migrations")
        else:
            # Fallback - just try to open it
            self._active_db = manager.get_database()

        return self._active_db

    def get_active_database(self) -> Database:
        """Get the database instance for the active profile.

        Returns:
            Database instance (source of truth)
        """
        if self._active_db is None or self._active_profile_id != self._config.active_profile:
            return self.activate_profile(self._config.active_profile)
        return self._active_db

    def get_active_funds_path(self) -> str:
        """Get the funds.yaml path for the active profile."""
        return self._get_funds_path(self._config.active_profile)

    def get_active_imports_path(self) -> Path:
        """Get the imports directory for the active profile."""
        return self._get_imports_path(self._config.active_profile)

    def duplicate_profile(self, source_id: str, new_name: str) -> Profile:
        """Create a copy of an existing profile.

        Args:
            source_id: ID of the profile to copy
            new_name: Name for the new profile

        Returns:
            The new Profile
        """
        source = self.get_profile(source_id)
        if not source:
            raise ValueError(f"Source profile not found: {source_id}")

        # Create new profile
        new_profile = self.create_profile(
            name=new_name,
            description=f"Copy of {source.name}",
            icon=source.icon,
        )

        # Copy database file
        source_db = self._get_db_path(source_id)
        dest_db = self._get_db_path(new_profile.id)
        if Path(source_db).exists():
            shutil.copy2(source_db, dest_db)

        # Copy funds.yaml
        source_funds = self._get_funds_path(source_id)
        dest_funds = self._get_funds_path(new_profile.id)
        if Path(source_funds).exists():
            shutil.copy2(source_funds, dest_funds)

        return new_profile

    def export_profile(self, profile_id: str, output_path: Optional[str] = None) -> Path:
        """Export a profile to a ZIP file.

        Args:
            profile_id: ID of the profile to export
            output_path: Optional path for the ZIP file

        Returns:
            Path to the created ZIP file
        """
        profile = self.get_profile(profile_id)
        if not profile:
            raise ValueError(f"Profile not found: {profile_id}")

        profile_dir = self._get_profile_dir(profile_id)
        if not profile_dir.exists():
            raise ValueError(f"Profile directory not found: {profile_dir}")

        # Generate output path if not provided
        if output_path is None:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            output_path = f"data/exports/{profile_id}_{timestamp}.zip"

        output_file = Path(output_path)
        output_file.parent.mkdir(parents=True, exist_ok=True)

        # Create ZIP file
        with zipfile.ZipFile(output_file, 'w', zipfile.ZIP_DEFLATED) as zf:
            # Add profile metadata
            metadata = {
                "profile": profile.to_dict(),
                "exported_at": datetime.now().isoformat(),
                "version": "1.0",
            }
            zf.writestr("profile.json", json.dumps(metadata, indent=2))

            # Add database file
            db_path = self._get_db_path(profile_id)
            if Path(db_path).exists():
                zf.write(db_path, "portfolio.db")

            # Add funds.yaml
            funds_path = self._get_funds_path(profile_id)
            if Path(funds_path).exists():
                zf.write(funds_path, "funds.yaml")

        return output_file

    def import_profile(self, zip_path: str, new_name: Optional[str] = None) -> Profile:
        """Import a profile from a ZIP file.

        Args:
            zip_path: Path to the ZIP file
            new_name: Optional new name (uses original if not provided)

        Returns:
            The imported Profile
        """
        zip_file = Path(zip_path)
        if not zip_file.exists():
            raise ValueError(f"ZIP file not found: {zip_path}")

        with zipfile.ZipFile(zip_file, 'r') as zf:
            # Read profile metadata
            metadata = json.loads(zf.read("profile.json"))
            original_profile = Profile.from_dict(metadata["profile"])

            # Create new profile with new or original name
            profile_name = new_name or original_profile.name
            new_profile = self.create_profile(
                name=profile_name,
                description=original_profile.description,
                icon=original_profile.icon,
                color=original_profile.color,
            )

            # Extract database
            if "portfolio.db" in zf.namelist():
                db_data = zf.read("portfolio.db")
                db_path = Path(self._get_db_path(new_profile.id))
                db_path.write_bytes(db_data)

            # Extract funds.yaml
            if "funds.yaml" in zf.namelist():
                funds_data = zf.read("funds.yaml")
                funds_path = Path(self._get_funds_path(new_profile.id))
                funds_path.write_bytes(funds_data)

        return new_profile

    def get_profile_stats(self, profile_id: str) -> dict:
        """Get statistics for a profile.

        Args:
            profile_id: ID of the profile

        Returns:
            Dictionary with profile statistics
        """
        profile_dir = self._get_profile_dir(profile_id)

        # Calculate disk usage
        total_size = 0
        for path in profile_dir.rglob("*"):
            if path.is_file():
                total_size += path.stat().st_size

        # Get database stats
        db_path = Path(self._get_db_path(profile_id))
        db_size = db_path.stat().st_size if db_path.exists() else 0

        # Count accounts and positions
        account_count = 0
        position_count = 0
        if db_path.exists():
            db = Database(str(db_path))
            account_count = len(db.get_all_accounts())
            position_count = len(db.get_all_positions())

        return {
            "total_size_bytes": total_size,
            "total_size_mb": round(total_size / (1024 * 1024), 2),
            "db_size_bytes": db_size,
            "db_size_mb": round(db_size / (1024 * 1024), 2),
            "account_count": account_count,
            "position_count": position_count,
        }


# Global profile manager instance
_profile_manager: Optional[ProfileManager] = None


def get_profile_manager() -> ProfileManager:
    """Get the global ProfileManager instance."""
    global _profile_manager
    if _profile_manager is None:
        _profile_manager = ProfileManager()
    return _profile_manager


def reset_database_caches() -> None:
    """Reset all cached database connections.

    Call this when demo mode changes to ensure fresh connections.
    This clears:
    - ProfileManager's cached active database
    - DemoModeManager's cached demo database
    """
    global _profile_manager
    if _profile_manager is not None:
        _profile_manager._active_db = None
        _profile_manager._active_profile_id = None
        logger.info("Cleared profile manager database cache")

    # Also clear demo manager cache
    from src.services.demo_mode import get_demo_manager
    demo_manager = get_demo_manager()
    demo_manager._demo_db = None
    logger.info("Cleared demo manager database cache")


def get_database() -> Database:
    """Get the database for the active profile or demo database.

    This is the main entry point for getting a database connection.
    It replaces direct Database() instantiation throughout the app.

    If demo mode is enabled, returns the demo database instead.
    """
    # Check if demo mode is enabled
    from src.services.demo_mode import get_demo_manager
    demo_manager = get_demo_manager()

    if demo_manager.is_enabled:
        return demo_manager.get_demo_database()

    return get_profile_manager().get_active_database()
