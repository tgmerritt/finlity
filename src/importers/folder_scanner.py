"""Folder scanner for auto-detecting and importing position files.

Supports both plugin-based importers and legacy column detection.
Plugin importers (e.g., Schwab, Fidelity) take precedence when available.
"""

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

import pandas as pd

from src.database import Database
from src.models.account_types import PREDEFINED_ACCOUNT_TYPES, get_folder_name

logger = logging.getLogger(__name__)

# Mapping from folder name to account type
# Includes all predefined types plus common aliases
FOLDER_TO_ACCOUNT_TYPE = {
    # Direct mappings from predefined types
    "roth_ira": "roth_ira",
    "traditional_ira": "traditional_ira",
    "traditional_401k": "traditional_401k",
    "roth_401k": "roth_401k",
    "taxable": "taxable",
    "hsa": "hsa",
    "pension": "pension",
    "529": "529",
    "hysa": "hysa",
    "treasury_direct": "treasury_direct",
    "checking": "checking",
    "savings": "savings",
    # Common aliases
    "brokerage": "taxable",
    "individual": "taxable",
    "ira": "traditional_ira",
    "401k": "traditional_401k",
    "college": "529",
    "college_savings": "529",
    "high_yield_savings": "hysa",
    "treasury": "treasury_direct",
    "ibonds": "treasury_direct",
}

# Common column name patterns for auto-detection
COLUMN_PATTERNS = {
    "ticker": [
        r"^symbol$", r"^ticker$", r"^stock$", r"^security.*symbol",
        r"^fund.*symbol", r"^sym$", r"^code$",
    ],
    "shares": [
        r"^shares$", r"^quantity$", r"^qty$", r"^units$", r"^shares.*owned",
        r"^total.*shares", r"^holdings?$", r"^position",
        r"^qty.*quantity",  # Schwab: "Qty (Quantity)"
    ],
    "name": [
        r"^name$", r"^description$", r"^security.*name", r"^fund.*name",
        r"^company", r"^security$", r"^holding.*name",
    ],
    "price": [
        r"^price$", r"^last.*price", r"^current.*price", r"^market.*price",
        r"^close$", r"^last$", r"^quote",
    ],
    "cost_per_share": [
        r"^cost.?share", r"^avg.*cost", r"^average.*cost",
        r"^purchase.*price",
    ],
    "cost_basis": [
        r"^cost.*basis", r"^cost$", r"^basis$", r"^total.*cost",
    ],
    "market_value": [
        r"^market.*value", r"^value$", r"^current.*value", r"^total.*value",
        r"^position.*value", r"^mkt.*val",  # Schwab: "Mkt Val (Market Value)"
    ],
    "security_type": [
        r"^security.*type", r"^type$", r"^asset.*type",
    ],
}

# Rows to skip based on symbol/ticker values
SKIP_SYMBOLS = {
    "cash", "total", "pending", "money market", "", "account total",
    "cash & cash investments", "--", "n/a",
}


@dataclass
class PendingFile:
    """A file detected that hasn't been imported yet."""
    path: Path
    account_type: str
    content_hash: str
    row_count: int
    detected_columns: dict[str, str] = field(default_factory=dict)  # field -> column name
    brokerage: str = "other"
    # Plugin information (if a plugin can handle this file)
    plugin_id: Optional[str] = None
    plugin_name: Optional[str] = None
    plugin_confidence: float = 0.0
    use_plugin: bool = False  # True if plugin should be used instead of legacy import


@dataclass
class ImportResult:
    """Result of importing a file."""
    file_path: Path
    success: bool
    positions_imported: int
    error_message: Optional[str] = None


class FolderScanner:
    """Scans import folders for new position files.

    Integrates with the plugin system to use brokerage-specific importers
    when available, falling back to legacy column detection otherwise.
    """

    def __init__(
        self,
        db: Database,
        import_folder: str = "data/imports",
        use_plugins: bool = True,
    ):
        self.db = db
        self.import_folder = Path(import_folder)
        self.supported_extensions = {".csv", ".xlsx", ".xls"}
        self.use_plugins = use_plugins
        self._plugins_initialized = False

    def _ensure_plugins_initialized(self) -> bool:
        """Ensure plugin system is initialized. Returns True if plugins available."""
        if not self.use_plugins:
            return False

        if self._plugins_initialized:
            return True

        try:
            from src.plugins import get_plugin_registry

            registry = get_plugin_registry()
            registry.discover_plugins(auto_enable_builtin=True)
            registry.load_enabled_plugins()

            self._plugins_initialized = True
            logger.info("Plugin system initialized for imports")
            return True

        except Exception as e:
            logger.warning(f"Could not initialize plugin system: {e}")
            self.use_plugins = False
            return False

    def _get_import_pipeline(self):
        """Get the import pipeline (lazy initialization)."""
        if not self._ensure_plugins_initialized():
            return None

        from src.plugins import get_import_pipeline
        return get_import_pipeline()

    def scan_for_new_files(self) -> list[PendingFile]:
        """Scan import folder for files not yet imported."""
        pending_files = []

        if not self.import_folder.exists():
            logger.warning(f"Import folder does not exist: {self.import_folder}")
            return []

        for subfolder in self.import_folder.iterdir():
            if not subfolder.is_dir():
                continue

            # Get account type from folder name
            folder_name = subfolder.name.lower()
            account_type = FOLDER_TO_ACCOUNT_TYPE.get(folder_name)

            # Check for custom account type folders (custom_*)
            if not account_type and folder_name.startswith("custom_"):
                # Extract custom type name from folder
                custom_name = folder_name[7:]  # Strip "custom_" prefix
                if custom_name:
                    # Convert back to display format (replace underscores with spaces, title case)
                    display_name = custom_name.replace("_", " ").title()
                    account_type = f"custom:{display_name}"

            if not account_type:
                logger.debug(f"Skipping unknown folder: {folder_name}")
                continue

            # Scan files in this folder
            for file_path in subfolder.iterdir():
                if file_path.suffix.lower() not in self.supported_extensions:
                    continue

                # Check if already imported via hash
                content_hash = self.db.compute_file_hash(file_path)
                if self.db.is_file_imported(content_hash):
                    logger.debug(f"Skipping already imported: {file_path.name}")
                    continue

                # Try plugin-based detection first
                try:
                    pipeline = self._get_import_pipeline()
                    plugin_match = None
                    content_preview = None

                    if pipeline:
                        # Read preview for plugin detection
                        try:
                            with open(file_path, "rb") as f:
                                content_preview = f.read(8192)
                        except Exception:
                            content_preview = b""

                        plugin_match = pipeline.find_best_importer(file_path, content_preview)

                    if plugin_match and plugin_match.confidence >= 0.5:
                        # Plugin can handle this file - use plugin-based import
                        # Get row count for display purposes
                        row_count = self._count_rows(file_path)

                        pending_files.append(PendingFile(
                            path=file_path,
                            account_type=account_type,
                            content_hash=content_hash,
                            row_count=row_count,
                            detected_columns={},  # Plugins handle their own column mapping
                            brokerage=self._extract_brokerage_from_plugin(plugin_match.plugin_id),
                            plugin_id=plugin_match.plugin_id,
                            plugin_name=plugin_match.plugin.name,
                            plugin_confidence=plugin_match.confidence,
                            use_plugin=True,
                        ))
                        logger.info(
                            f"Plugin '{plugin_match.plugin.name}' matched {file_path.name} "
                            f"(confidence: {plugin_match.confidence:.0%})"
                        )
                        continue

                    # Fall back to legacy column detection
                    df, brokerage = self._load_file_smart(file_path)
                    if df is None or df.empty:
                        logger.warning(f"Empty or unreadable file: {file_path.name}")
                        continue

                    detected_columns = self._detect_columns(df)
                    if "ticker" not in detected_columns or "shares" not in detected_columns:
                        logger.warning(
                            f"Could not auto-detect required columns in {file_path.name}. "
                            f"Columns found: {list(df.columns)}. "
                            f"Detected mappings: {detected_columns}"
                        )
                        continue

                    pending_files.append(PendingFile(
                        path=file_path,
                        account_type=account_type,
                        content_hash=content_hash,
                        row_count=len(df),
                        detected_columns=detected_columns,
                        brokerage=brokerage,
                        use_plugin=False,
                    ))

                except Exception as e:
                    logger.error(f"Error scanning {file_path}: {e}")

        return pending_files

    def _detect_schwab_format(self, file_path: Path) -> bool:
        """Check if file is in Schwab export format."""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                first_line = f.readline()
                return first_line.startswith('"Positions for account')
        except Exception:
            return False

    def _count_rows(self, file_path: Path) -> int:
        """Count rows in a file (for display purposes)."""
        try:
            if file_path.suffix.lower() in [".xlsx", ".xls"]:
                df = pd.read_excel(file_path, nrows=1000)
                return len(df)
            else:
                # For CSV, count lines (minus header)
                with open(file_path, 'r', encoding='utf-8', errors='ignore') as f:
                    return sum(1 for _ in f) - 1
        except Exception:
            return 0

    def _extract_brokerage_from_plugin(self, plugin_id: str) -> str:
        """Extract brokerage name from plugin ID."""
        plugin_lower = plugin_id.lower()
        if "schwab" in plugin_lower:
            return "schwab"
        elif "fidelity" in plugin_lower:
            return "fidelity"
        elif "vanguard" in plugin_lower:
            return "vanguard"
        elif "etrade" in plugin_lower:
            return "etrade"
        elif "robinhood" in plugin_lower:
            return "robinhood"
        elif "td-ameritrade" in plugin_lower:
            return "td_ameritrade"
        else:
            return "other"

    def _load_file_smart(self, file_path: Path) -> tuple[Optional[pd.DataFrame], str]:
        """Load file with format auto-detection. Returns (DataFrame, brokerage)."""
        try:
            if file_path.suffix.lower() in [".xlsx", ".xls"]:
                return pd.read_excel(file_path), "other"

            # For CSV, check for Schwab format
            if self._detect_schwab_format(file_path):
                # Schwab: skip first 2 rows (header info + blank), row 3 has column names
                df = pd.read_csv(file_path, skiprows=2)
                logger.info(f"Detected Schwab format for {file_path.name}")
                return df, "schwab"

            # Standard CSV
            return pd.read_csv(file_path), "other"

        except Exception as e:
            logger.error(f"Error loading {file_path}: {e}")
            return None, "other"

    def _detect_columns(self, df: pd.DataFrame) -> dict[str, str]:
        """Auto-detect column mappings based on common patterns."""
        detected = {}
        columns_lower = {col: col.lower().strip() for col in df.columns}

        for field_name, patterns in COLUMN_PATTERNS.items():
            for col, col_lower in columns_lower.items():
                if field_name in detected:
                    break
                for pattern in patterns:
                    if re.search(pattern, col_lower, re.IGNORECASE):
                        detected[field_name] = col
                        break

        return detected

    def import_file(
        self,
        pending: PendingFile,
        brokerage: Optional[str] = None,
        fetch_prices: bool = True,
    ) -> ImportResult:
        """Import a pending file into the database.

        Uses plugin-based import if the file was matched by a plugin,
        otherwise falls back to legacy column-based import.
        """
        # Use detected brokerage if not overridden
        if brokerage is None:
            brokerage = pending.brokerage

        # Use plugin-based import if available
        if pending.use_plugin and pending.plugin_id:
            return self._import_with_plugin(pending, brokerage, fetch_prices)

        # Legacy import
        return self._import_legacy(pending, brokerage, fetch_prices)

    def _import_with_plugin(
        self,
        pending: PendingFile,
        brokerage: str,
        fetch_prices: bool,
    ) -> ImportResult:
        """Import using a plugin importer."""
        try:
            pipeline = self._get_import_pipeline()
            if not pipeline:
                return ImportResult(
                    file_path=pending.path,
                    success=False,
                    positions_imported=0,
                    error_message="Plugin system not available",
                )

            # Execute plugin import
            plugin_result = pipeline.import_file(
                pending.path,
                pending.account_type,
            )

            if not plugin_result.success:
                return ImportResult(
                    file_path=pending.path,
                    success=False,
                    positions_imported=0,
                    error_message=plugin_result.message,
                )

            # Get or create account
            account_name = plugin_result.account_name or self._generate_account_name(
                pending.account_type, brokerage
            )
            account = self.db.get_or_create_account(
                name=account_name,
                account_type=pending.account_type,
                brokerage=brokerage,
            )

            # Record the import
            file_import = self.db.record_import(
                file_name=pending.path.name,
                file_path=str(pending.path),
                content_hash=pending.content_hash,
                account_type=pending.account_type,
                row_count=len(plugin_result.positions),
                status="pending",
            )

            # Clear existing positions
            cleared_count = self.db.clear_account_positions(account.id)
            if cleared_count > 0:
                logger.info(f"Cleared {cleared_count} existing positions for {account_name}")

            # Add positions from plugin result
            positions_imported = 0
            tickers_needing_prices = []

            for pos_data in plugin_result.positions:
                try:
                    ticker = pos_data.get("ticker", "")
                    shares = pos_data.get("shares", 0)
                    name = pos_data.get("name", ticker)
                    price = pos_data.get("price")
                    cost_basis = pos_data.get("cost_basis")
                    is_fund = pos_data.get("is_fund", False)

                    self.db.add_position(
                        account_id=account.id,
                        ticker=ticker,
                        shares=shares,
                        name=name,
                        cost_basis=cost_basis,
                        current_price=price if price and price > 0 else None,
                        is_fund=is_fund,
                        import_id=file_import.id,
                    )
                    positions_imported += 1

                    if not price or price <= 0:
                        tickers_needing_prices.append(ticker)

                except Exception as e:
                    logger.warning(f"Error adding position {pos_data}: {e}")

            # Fetch missing prices
            if fetch_prices and tickers_needing_prices:
                self._fetch_and_update_prices(list(set(tickers_needing_prices)))

            # Update import status
            with self.db.get_session() as session:
                from src.database.models import FileImport
                import_record = session.query(FileImport).filter_by(id=file_import.id).first()
                if import_record:
                    import_record.status = "completed"
                    session.commit()

            logger.info(
                f"Plugin import complete: {positions_imported} positions from "
                f"{pending.path.name} using {pending.plugin_name}"
            )

            return ImportResult(
                file_path=pending.path,
                success=True,
                positions_imported=positions_imported,
                error_message=None,
            )

        except Exception as e:
            logger.exception(f"Error in plugin import for {pending.path}: {e}")
            return ImportResult(
                file_path=pending.path,
                success=False,
                positions_imported=0,
                error_message=str(e),
            )

    def _import_legacy(
        self,
        pending: PendingFile,
        brokerage: str,
        fetch_prices: bool,
    ) -> ImportResult:
        """Legacy import using column detection."""
        try:
            df, _ = self._load_file_smart(pending.path)
            if df is None:
                return ImportResult(
                    file_path=pending.path,
                    success=False,
                    positions_imported=0,
                    error_message="Could not load file",
                )

            # Get or create account
            account_name = self._generate_account_name(pending.account_type, brokerage)
            account = self.db.get_or_create_account(
                name=account_name,
                account_type=pending.account_type,
                brokerage=brokerage,
            )

            # Record the import first (as pending)
            file_import = self.db.record_import(
                file_name=pending.path.name,
                file_path=str(pending.path),
                content_hash=pending.content_hash,
                account_type=pending.account_type,
                row_count=len(df),
                status="pending",
            )

            # Clear existing positions for this account (replace with new snapshot)
            cleared_count = self.db.clear_account_positions(account.id)
            if cleared_count > 0:
                logger.info(f"Cleared {cleared_count} existing positions for {account_name}")

            # Process each row - add as individual lots
            positions_imported = 0
            errors = []
            tickers_needing_prices = []

            for idx, row in df.iterrows():
                try:
                    position_data = self._extract_position(row, pending.detected_columns)
                    if position_data is None:
                        continue

                    ticker, shares, name, price, cost_basis, is_fund = position_data

                    # Add as individual lot (each row is a separate position)
                    self.db.add_position(
                        account_id=account.id,
                        ticker=ticker,
                        shares=shares,
                        name=name,
                        cost_basis=cost_basis,
                        current_price=price if price > 0 else None,
                        is_fund=is_fund,
                        import_id=file_import.id,
                    )
                    positions_imported += 1

                    if price <= 0:
                        tickers_needing_prices.append(ticker)

                except Exception as e:
                    errors.append(f"Row {idx + 2}: {e}")

            # Fetch missing prices
            if fetch_prices and tickers_needing_prices:
                self._fetch_and_update_prices(list(set(tickers_needing_prices)))

            # Update import status
            with self.db.get_session() as session:
                import_record = session.query(type(file_import)).filter_by(id=file_import.id).first()
                if import_record:
                    import_record.status = "completed" if not errors else "completed_with_errors"
                    if errors:
                        import_record.error_message = "; ".join(errors[:5])
                    session.commit()

            return ImportResult(
                file_path=pending.path,
                success=True,
                positions_imported=positions_imported,
                error_message="; ".join(errors[:3]) if errors else None,
            )

        except Exception as e:
            logger.exception(f"Error importing {pending.path}: {e}")
            return ImportResult(
                file_path=pending.path,
                success=False,
                positions_imported=0,
                error_message=str(e),
            )

    def _extract_position(
        self,
        row: pd.Series,
        column_map: dict[str, str],
    ) -> Optional[tuple[str, float, str, float, Optional[float], bool]]:
        """Extract position data from a row. Returns (ticker, shares, name, price, cost_basis, is_fund)."""
        # Get ticker (required)
        ticker_col = column_map.get("ticker")
        if not ticker_col:
            return None

        ticker_val = row.get(ticker_col)
        if pd.isna(ticker_val):
            return None

        ticker = str(ticker_val).strip().upper()
        if not ticker or ticker.lower() in SKIP_SYMBOLS:
            return None

        # Get shares (required)
        shares_col = column_map.get("shares")
        if not shares_col:
            return None

        shares_val = row.get(shares_col)
        if pd.isna(shares_val) or str(shares_val).strip() == "--":
            return None
        shares = self._parse_number(shares_val)
        if shares <= 0:
            return None

        # Get name (optional)
        name = ticker
        name_col = column_map.get("name")
        if name_col:
            name_val = row.get(name_col)
            if not pd.isna(name_val) and str(name_val).strip() != "--":
                name = str(name_val).strip()

        # Get price (optional)
        price = 0.0
        price_col = column_map.get("price")
        if price_col:
            price_val = row.get(price_col)
            if not pd.isna(price_val) and str(price_val).strip() not in ["--", "N/A"]:
                price = self._parse_number(price_val)

        # If no price, try to compute from market value
        if price <= 0:
            mv_col = column_map.get("market_value")
            if mv_col:
                mv_val = row.get(mv_col)
                if not pd.isna(mv_val) and str(mv_val).strip() not in ["--", "N/A"]:
                    market_value = self._parse_number(mv_val)
                    if market_value > 0 and shares > 0:
                        price = market_value / shares

        # Get cost basis
        cost_basis = None

        # Try total cost basis column first
        cost_col = column_map.get("cost_basis")
        if cost_col:
            cost_val = row.get(cost_col)
            if not pd.isna(cost_val) and str(cost_val).strip() not in ["--", "N/A"]:
                cost_basis = self._parse_number(cost_val)

        # If no total cost, try cost per share * shares
        if cost_basis is None or cost_basis <= 0:
            cps_col = column_map.get("cost_per_share")
            if cps_col:
                cps_val = row.get(cps_col)
                if not pd.isna(cps_val) and str(cps_val).strip() not in ["--", "N/A"]:
                    cost_per_share = self._parse_number(cps_val)
                    if cost_per_share > 0:
                        cost_basis = cost_per_share * shares

        # Determine if it's a fund
        is_fund = self._is_likely_fund(ticker, name)

        # Check security type column if available
        sec_type_col = column_map.get("security_type")
        if sec_type_col:
            sec_type_val = row.get(sec_type_col)
            if not pd.isna(sec_type_val):
                sec_type = str(sec_type_val).lower()
                if "etf" in sec_type or "fund" in sec_type or "mutual" in sec_type:
                    is_fund = True

        return ticker, shares, name, price, cost_basis, is_fund

    def _parse_number(self, value) -> float:
        """Parse a number from various formats (handles $, commas, etc.)."""
        if isinstance(value, (int, float)):
            return float(value)

        if isinstance(value, str):
            # Remove $, commas, spaces, and other non-numeric chars except . and -
            cleaned = re.sub(r"[^\d.\-]", "", value)
            try:
                return float(cleaned) if cleaned else 0.0
            except ValueError:
                return 0.0

        return 0.0

    def _is_likely_fund(self, ticker: str, name: str) -> bool:
        """Determine if a position is likely a fund/ETF."""
        fund_indicators = ["ETF", "FUND", "INDEX", "TRUST", "ADMIRAL", "INST", "ISHARES", "VANGUARD", "SCHWAB"]
        name_upper = name.upper()

        if any(ind in name_upper for ind in fund_indicators):
            return True

        common_funds = [
            "VTI", "VOO", "VXUS", "VWO", "BND", "VNQ", "VTSAX", "VTIAX", "VFIAX",
            "SPY", "QQQ", "IWM", "EFA", "EEM", "AGG", "SCHD", "SCHX", "SCHG", "SCHF",
            "FXAIX", "FSKAX", "FTIHX", "SWPPX", "SWTSX", "SWISX",
            "IGV", "VUG", "VFH", "SGOV",
        ]
        return ticker in common_funds

    def _generate_account_name(self, account_type: str, brokerage: str) -> str:
        """Generate a readable account name."""
        from src.models.account_types import get_account_type_label

        type_name = get_account_type_label(account_type)
        brokerage_name = brokerage.title() if brokerage != "other" else ""

        if brokerage_name:
            return f"{brokerage_name} {type_name}"
        return type_name

    @staticmethod
    def create_import_folder(import_base: str, account_type: str) -> Path:
        """Create an import folder for an account type.

        Args:
            import_base: Base import folder (e.g., "data/imports")
            account_type: Account type (predefined or custom:name)

        Returns:
            Path to the created folder
        """
        folder_name = get_folder_name(account_type)
        folder_path = Path(import_base) / folder_name

        if not folder_path.exists():
            folder_path.mkdir(parents=True, exist_ok=True)
            logger.info(f"Created import folder: {folder_path}")

        return folder_path

    @staticmethod
    def ensure_all_default_folders(import_base: str = "data/imports") -> list[Path]:
        """Create import folders for all predefined account types.

        Returns:
            List of created folder paths
        """
        created = []
        base_path = Path(import_base)

        if not base_path.exists():
            base_path.mkdir(parents=True, exist_ok=True)

        for account_type in PREDEFINED_ACCOUNT_TYPES:
            folder_name = get_folder_name(account_type)
            folder_path = base_path / folder_name

            if not folder_path.exists():
                folder_path.mkdir(parents=True, exist_ok=True)
                logger.info(f"Created import folder: {folder_path}")
                created.append(folder_path)

        return created

    def _fetch_and_update_prices(self, tickers: list[str]) -> None:
        """Fetch prices using PriceService and update positions."""
        from src.data.prices import PriceService

        price_service = PriceService()

        for ticker in tickers:
            try:
                # Use PriceService which handles normalization, skips, and rate limiting
                price_data = price_service.get_current_price(ticker)

                if price_data:
                    # Update cache in database
                    self.db.update_price_cache(
                        ticker=ticker,
                        current_price=price_data.current_price,
                        previous_close=price_data.previous_close,
                        year_high=price_data.year_high,
                        year_low=price_data.year_low,
                    )
                    # Update positions
                    self._update_position_prices(ticker, price_data.current_price)
                    logger.debug(f"Fetched price for {ticker}: ${price_data.current_price:.2f}")
                else:
                    # Price service returned None (skip tickers like CDs, cash, etc.)
                    logger.debug(f"Skipped price lookup for {ticker} (non-market ticker)")

            except Exception as e:
                logger.warning(f"Could not fetch price for {ticker}: {e}")

    def _update_position_prices(self, ticker: str, price: float) -> None:
        """Update all positions with this ticker to use the given price."""
        with self.db.get_session() as session:
            from src.database.models import Position
            positions = session.query(Position).filter_by(ticker=ticker).all()
            for pos in positions:
                pos.current_price = price
            session.commit()

    def process_all_pending(
        self,
        brokerage: Optional[str] = None,
        fetch_prices: bool = True,
    ) -> list[ImportResult]:
        """Scan and process all pending files."""
        pending_files = self.scan_for_new_files()
        results = []

        for pending in pending_files:
            logger.info(f"Importing {pending.path.name} ({pending.row_count} rows, {pending.brokerage})")
            result = self.import_file(pending, brokerage=brokerage, fetch_prices=fetch_prices)
            results.append(result)
            logger.info(
                f"  {'Success' if result.success else 'Failed'}: "
                f"{result.positions_imported} positions"
            )

        return results
