"""Database module for SQLite persistence.

Key concepts:
- DatabaseManager: Handles database lifecycle (existence, integrity, initialization)
- Database: The actual database operations class
- SeedLoader: Loads initial data from CSV/YAML for first-time setup

The database is the SOURCE OF TRUTH once it exists and is valid.
CSV/YAML files are only used for first-time initialization.
"""

from .models import (
    Base,
    Entity,
    FileImport,
    Account,
    Position,
    PortfolioSnapshot,
    PriceCache,
    AppSettings,
    AllocationTrigger,
)
from .operations import Database
from .profile_manager import (
    Profile,
    ProfileManager,
    get_profile_manager,
    get_database,
    reset_database_caches,
)
from .database_manager import (
    DatabaseManager,
    DatabaseStatus,
    DatabaseCheckResult,
    check_database,
    SCHEMA_VERSION,
)
from .seed_loader import (
    SeedLoader,
    create_seed_callback,
)

__all__ = [
    # Models
    "Base",
    "Entity",
    "FileImport",
    "Account",
    "Position",
    "PortfolioSnapshot",
    "PriceCache",
    "AppSettings",
    "AllocationTrigger",
    # Database operations
    "Database",
    # Profile management
    "Profile",
    "ProfileManager",
    "get_profile_manager",
    "get_database",
    "reset_database_caches",
    # Database lifecycle management
    "DatabaseManager",
    "DatabaseStatus",
    "DatabaseCheckResult",
    "check_database",
    "SCHEMA_VERSION",
    # Seed data loading
    "SeedLoader",
    "create_seed_callback",
]
