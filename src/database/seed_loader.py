"""Seed data loader for first-time database initialization.

This module loads initial configuration from CSV/YAML files to seed
a new database. This is ONLY used for first-time setup - once the
database exists, it becomes the source of truth.

Seed data sources:
- config.yaml: Application settings, target allocations
- funds.yaml: Fund metadata cache
- data/imports/*.csv: Initial portfolio data from brokerage exports
"""

import logging
from pathlib import Path

import yaml

from .operations import Database

logger = logging.getLogger(__name__)


class SeedLoader:
    """Loads seed data from configuration files into a new database.

    This class is responsible for first-time database initialization.
    It reads from:
    - config.yaml (app settings)
    - funds.yaml (fund metadata)
    - CSV files in data/imports/ (portfolio data)

    After the database is seeded, these files are no longer the source
    of truth - the database is.
    """

    def __init__(
        self,
        config_path: Path = Path("config.yaml"),
        funds_path: Path = Path("funds.yaml"),
        imports_dir: Path = Path("data/imports"),
    ):
        """Initialize SeedLoader.

        Args:
            config_path: Path to config.yaml
            funds_path: Path to funds.yaml
            imports_dir: Directory containing CSV imports
        """
        self.config_path = config_path
        self.funds_path = funds_path
        self.imports_dir = imports_dir

    def seed_database(self, db: Database) -> dict:
        """Seed a database with initial data.

        This is the main entry point for first-time initialization.
        Loads all available seed data into the database.

        Args:
            db: Database instance to seed

        Returns:
            Summary of what was loaded
        """
        summary = {
            "config_loaded": False,
            "funds_loaded": 0,
            "accounts_created": 0,
            "positions_imported": 0,
            "views_created": 0,
        }

        # Load application settings from config.yaml
        if self.config_path.exists():
            self._load_config_settings(db)
            summary["config_loaded"] = True

        # Load fund metadata from funds.yaml
        if self.funds_path.exists():
            summary["funds_loaded"] = self._load_fund_metadata(db)

        # Create default views
        summary["views_created"] = self._create_default_views(db)

        # Import CSV files from imports directory
        if self.imports_dir.exists():
            import_result = self._import_csv_files(db)
            summary["accounts_created"] = import_result["accounts"]
            summary["positions_imported"] = import_result["positions"]

        return summary

    def _load_config_settings(self, db: Database) -> None:
        """Load settings from config.yaml into database.

        Args:
            db: Database instance
        """
        try:
            with open(self.config_path) as f:
                config = yaml.safe_load(f) or {}

            # Store relevant settings in AppSettings
            personal = config.get("personal", {})
            if personal:
                if "current_age" in personal:
                    db.set_setting("current_age", str(personal["current_age"]))
                if "retirement_age" in personal:
                    db.set_setting("retirement_age", str(personal["retirement_age"]))
                if "annual_spending" in personal:
                    db.set_setting("annual_spending", str(personal["annual_spending"]))

            # Store Monte Carlo settings
            monte_carlo = config.get("monte_carlo", {})
            if monte_carlo:
                for key, value in monte_carlo.items():
                    db.set_setting(f"monte_carlo_{key}", str(value))

            # Store target allocations
            allocations = config.get("target_allocations", {})
            if allocations:
                import json
                db.set_setting("target_allocations", json.dumps(allocations))

        except Exception as e:
            logger.warning(f"Could not load config settings: {e}")

    def _load_fund_metadata(self, db: Database) -> int:
        """Load fund metadata from funds.yaml.

        Args:
            db: Database instance

        Returns:
            Number of funds loaded
        """
        try:
            with open(self.funds_path) as f:
                funds = yaml.safe_load(f) or {}

            count = 0
            for ticker, metadata in funds.items():
                if isinstance(metadata, dict):
                    # Store as JSON in AppSettings for now
                    # Could be moved to a dedicated FundMetadata table
                    import json
                    db.set_setting(f"fund_metadata_{ticker}", json.dumps(metadata))
                    count += 1

            return count
        except Exception as e:
            logger.warning(f"Could not load fund metadata: {e}")
            return 0

    def _create_default_views(self, db: Database) -> int:
        """Create default portfolio views.

        Args:
            db: Database instance

        Returns:
            Number of views created
        """
        # Create "All Accounts" view
        db.ensure_all_accounts_view()
        return 1

    def _import_csv_files(self, db: Database) -> dict:
        """Import CSV files from the imports directory.

        Args:
            db: Database instance

        Returns:
            Dictionary with accounts and positions counts
        """
        from src.importers import FolderScanner

        result = {"accounts": 0, "positions": 0}

        try:
            scanner = FolderScanner(db)
            pending = scanner.scan_for_new_files()

            if pending:
                import_results = scanner.process_all_pending(fetch_prices=False)
                for r in import_results:
                    if r.success:
                        result["positions"] += r.positions_imported
                        if r.positions_imported > 0:
                            result["accounts"] += 1

        except Exception as e:
            logger.warning(f"Could not import CSV files: {e}")

        return result


def create_seed_callback(
    config_path: Path = Path("config.yaml"),
    funds_path: Path = Path("funds.yaml"),
    imports_dir: Path = Path("data/imports"),
):
    """Create a seed callback function for DatabaseManager.initialize().

    This returns a function that can be passed to DatabaseManager.initialize()
    to seed a new database with initial data.

    Args:
        config_path: Path to config.yaml
        funds_path: Path to funds.yaml
        imports_dir: Directory containing CSV imports

    Returns:
        Callback function that seeds a database
    """
    loader = SeedLoader(config_path, funds_path, imports_dir)

    def seed_callback(db: Database) -> None:
        summary = loader.seed_database(db)
        logger.info(
            f"Database seeded: config={summary['config_loaded']}, "
            f"funds={summary['funds_loaded']}, accounts={summary['accounts_created']}, "
            f"positions={summary['positions_imported']}, views={summary['views_created']}"
        )

    return seed_callback
