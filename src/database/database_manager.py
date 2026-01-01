"""Database lifecycle management.

This module provides a DatabaseManager class that handles the complete database
lifecycle including:
- Existence checking
- Integrity validation
- Schema version management
- First-time initialization from seed data
- Corruption detection and recovery

The database is the SOURCE OF TRUTH once it exists and is valid.
CSV/YAML files are only used for first-time initialization (seed data).
"""

import hashlib
import logging
import shutil
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Optional, Callable

from .operations import Database

logger = logging.getLogger(__name__)


# Current schema version - increment when making breaking schema changes
SCHEMA_VERSION = 1


class DatabaseStatus(Enum):
    """Status of a database file."""
    NOT_EXISTS = "not_exists"      # Database file doesn't exist
    VALID = "valid"                # Database exists and is valid
    CORRUPT = "corrupt"            # Database exists but failed integrity check
    SCHEMA_MISMATCH = "schema_mismatch"  # Database schema version doesn't match
    EMPTY = "empty"                # Database exists but has no data


@dataclass
class DatabaseCheckResult:
    """Result of checking a database."""
    status: DatabaseStatus
    path: Path
    schema_version: Optional[int] = None
    error_message: Optional[str] = None
    table_count: int = 0
    position_count: int = 0
    account_count: int = 0

    @property
    def is_usable(self) -> bool:
        """Check if database can be used as source of truth."""
        return self.status == DatabaseStatus.VALID

    @property
    def needs_initialization(self) -> bool:
        """Check if database needs first-time initialization."""
        return self.status in (DatabaseStatus.NOT_EXISTS, DatabaseStatus.EMPTY)

    @property
    def needs_recovery(self) -> bool:
        """Check if database needs recovery from corruption."""
        return self.status == DatabaseStatus.CORRUPT


class DatabaseManager:
    """Manages database lifecycle and initialization.

    This class provides a clear interface for:
    1. Checking if a database exists and is valid
    2. First-time initialization with seed data from CSV/YAML
    3. Corruption detection and recovery
    4. Schema version management

    Usage:
        manager = DatabaseManager(db_path)
        result = manager.check()

        if result.is_usable:
            db = manager.get_database()  # Use existing DB as source of truth
        elif result.needs_initialization:
            db = manager.initialize()    # First-time setup
        elif result.needs_recovery:
            db = manager.recover()       # Backup corrupt + re-initialize
    """

    def __init__(self, db_path: str | Path):
        """Initialize DatabaseManager.

        Args:
            db_path: Path to the SQLite database file
        """
        self.db_path = Path(db_path)
        self._database: Optional[Database] = None

    def check(self) -> DatabaseCheckResult:
        """Check database status.

        This is the primary method to determine what action is needed:
        - NOT_EXISTS: Call initialize() for first-time setup
        - VALID: Call get_database() to use existing data
        - CORRUPT: Call recover() to backup and re-initialize
        - SCHEMA_MISMATCH: May need migration or re-initialization
        - EMPTY: Call initialize() to seed with data

        Returns:
            DatabaseCheckResult with status and details
        """
        # Check if file exists
        if not self.db_path.exists():
            return DatabaseCheckResult(
                status=DatabaseStatus.NOT_EXISTS,
                path=self.db_path,
            )

        # Check file integrity with SQLite
        try:
            integrity_result = self._check_integrity()
            if not integrity_result[0]:
                return DatabaseCheckResult(
                    status=DatabaseStatus.CORRUPT,
                    path=self.db_path,
                    error_message=integrity_result[1],
                )
        except Exception as e:
            return DatabaseCheckResult(
                status=DatabaseStatus.CORRUPT,
                path=self.db_path,
                error_message=str(e),
            )

        # Check schema version
        schema_version = self._get_schema_version()

        # Get basic stats
        stats = self._get_database_stats()

        # Check if empty (no accounts or positions)
        if stats["account_count"] == 0 and stats["position_count"] == 0:
            return DatabaseCheckResult(
                status=DatabaseStatus.EMPTY,
                path=self.db_path,
                schema_version=schema_version,
                table_count=stats["table_count"],
                position_count=0,
                account_count=0,
            )

        # Check schema version compatibility
        if schema_version is not None and schema_version != SCHEMA_VERSION:
            return DatabaseCheckResult(
                status=DatabaseStatus.SCHEMA_MISMATCH,
                path=self.db_path,
                schema_version=schema_version,
                error_message=f"Schema version {schema_version} != expected {SCHEMA_VERSION}",
                table_count=stats["table_count"],
                position_count=stats["position_count"],
                account_count=stats["account_count"],
            )

        # Database is valid and usable
        return DatabaseCheckResult(
            status=DatabaseStatus.VALID,
            path=self.db_path,
            schema_version=schema_version or SCHEMA_VERSION,
            table_count=stats["table_count"],
            position_count=stats["position_count"],
            account_count=stats["account_count"],
        )

    def get_database(self) -> Database:
        """Get the Database instance.

        Returns the existing database as source of truth.
        Call check() first to verify database is valid.

        Returns:
            Database instance connected to this db_path
        """
        if self._database is None:
            self._database = Database(str(self.db_path))
        return self._database

    def initialize(
        self,
        seed_callback: Optional[Callable[[Database], None]] = None,
        force: bool = False,
    ) -> Database:
        """Initialize a new database.

        Creates the database schema and optionally seeds it with initial data.
        This should only be called for first-time setup.

        Args:
            seed_callback: Optional function to seed initial data.
                          Receives Database instance, should add initial
                          accounts/positions from CSV/YAML configuration.
            force: If True, will delete existing database first

        Returns:
            Initialized Database instance
        """
        if self.db_path.exists():
            if force:
                self.db_path.unlink()
            else:
                raise ValueError(
                    f"Database already exists at {self.db_path}. "
                    "Use force=True to delete and recreate."
                )

        # Ensure parent directory exists
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

        # Create database with schema
        self._database = Database(str(self.db_path))

        # Set schema version
        self._set_schema_version(SCHEMA_VERSION)

        # Run seed callback if provided
        if seed_callback:
            seed_callback(self._database)

        return self._database

    def recover(
        self,
        backup_dir: Optional[Path] = None,
        seed_callback: Optional[Callable[[Database], None]] = None,
    ) -> Database:
        """Recover from a corrupt database.

        1. Backs up the corrupt database file
        2. Creates a new database
        3. Optionally seeds with initial data

        Args:
            backup_dir: Directory to store backup (default: same as db)
            seed_callback: Optional function to seed initial data

        Returns:
            New Database instance
        """
        if self.db_path.exists():
            # Create backup
            backup_dir = backup_dir or self.db_path.parent
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            backup_path = backup_dir / f"{self.db_path.stem}_corrupt_{timestamp}.db"

            shutil.copy2(self.db_path, backup_path)
            logger.warning(f"Backed up corrupt database to: {backup_path}")

            # Delete corrupt database
            self.db_path.unlink()

        # Initialize fresh database
        return self.initialize(seed_callback=seed_callback)

    def _check_integrity(self) -> tuple[bool, Optional[str]]:
        """Run SQLite integrity check.

        Returns:
            Tuple of (is_valid, error_message)
        """
        conn = sqlite3.connect(str(self.db_path))
        try:
            cursor = conn.execute("PRAGMA integrity_check")
            result = cursor.fetchone()[0]

            if result == "ok":
                return (True, None)
            else:
                return (False, result)
        except sqlite3.DatabaseError as e:
            return (False, str(e))
        finally:
            conn.close()

    def _get_schema_version(self) -> Optional[int]:
        """Get the stored schema version.

        Returns:
            Schema version number or None if not set
        """
        try:
            conn = sqlite3.connect(str(self.db_path))
            cursor = conn.execute("PRAGMA user_version")
            version = cursor.fetchone()[0]
            conn.close()
            return version if version > 0 else None
        except Exception:
            return None

    def _set_schema_version(self, version: int) -> None:
        """Set the schema version.

        Args:
            version: Schema version number to set

        Note: PRAGMA statements don't support parameterized queries,
        but version is validated as int by type hint.
        """
        if not isinstance(version, int) or version < 0:
            raise ValueError(f"Schema version must be a non-negative integer, got: {version}")
        conn = sqlite3.connect(str(self.db_path))
        # PRAGMA doesn't support ? placeholders, but we've validated version is a safe int
        conn.execute(f"PRAGMA user_version = {version}")
        conn.commit()
        conn.close()

    def _get_database_stats(self) -> dict:
        """Get basic database statistics.

        Returns:
            Dictionary with table_count, position_count, account_count
        """
        try:
            conn = sqlite3.connect(str(self.db_path))

            # Count tables
            cursor = conn.execute(
                "SELECT count(*) FROM sqlite_master WHERE type='table'"
            )
            table_count = cursor.fetchone()[0]

            # Count positions
            try:
                cursor = conn.execute("SELECT count(*) FROM positions")
                position_count = cursor.fetchone()[0]
            except sqlite3.OperationalError:
                position_count = 0

            # Count accounts
            try:
                cursor = conn.execute("SELECT count(*) FROM accounts")
                account_count = cursor.fetchone()[0]
            except sqlite3.OperationalError:
                account_count = 0

            conn.close()
            return {
                "table_count": table_count,
                "position_count": position_count,
                "account_count": account_count,
            }
        except Exception:
            return {
                "table_count": 0,
                "position_count": 0,
                "account_count": 0,
            }

    def get_checksum(self) -> Optional[str]:
        """Calculate MD5 checksum of database file.

        Useful for detecting changes or verifying backups.

        Returns:
            MD5 hex digest or None if file doesn't exist
        """
        if not self.db_path.exists():
            return None

        md5 = hashlib.md5()
        with open(self.db_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                md5.update(chunk)
        return md5.hexdigest()


def check_database(db_path: str | Path) -> DatabaseCheckResult:
    """Convenience function to check database status.

    Args:
        db_path: Path to the database file

    Returns:
        DatabaseCheckResult with status and details
    """
    return DatabaseManager(db_path).check()
