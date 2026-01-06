"""Database operations and CRUD functions."""

import hashlib
import json
from datetime import datetime, timedelta
from pathlib import Path
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

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
    PortfolioView,
    MonteCarloResult,
    BudgetIncomeSource,
    BudgetExpense,
)


class Database:
    """Database manager for portfolio data."""

    def __init__(self, db_path: str = "data/portfolio.db"):
        """Initialize database connection."""
        # Ensure data directory exists
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)

        self.db_path = db_path
        self.engine = create_engine(f"sqlite:///{db_path}", echo=False)
        Base.metadata.create_all(self.engine)
        self.SessionLocal = sessionmaker(bind=self.engine)

        # Run migrations for existing databases
        self._migrate_schema()

    def _migrate_schema(self) -> None:
        """Add missing columns to existing tables (for database upgrades)."""
        from sqlalchemy import text, inspect

        inspector = inspect(self.engine)

        with self.engine.connect() as conn:
            # Check and add missing columns to accounts table
            if "accounts" in inspector.get_table_names():
                existing_cols = {col["name"] for col in inspector.get_columns("accounts")}
                account_migrations = [
                    ("beneficiary", "TEXT"),
                    ("custom_type_name", "TEXT"),
                    ("is_retirement_account", "BOOLEAN DEFAULT 0"),
                ]
                for col_name, col_type in account_migrations:
                    if col_name not in existing_cols:
                        conn.execute(text(f"ALTER TABLE accounts ADD COLUMN {col_name} {col_type}"))
                        conn.commit()

            # Check and add missing columns to positions table
            if "positions" in inspector.get_table_names():
                existing_cols = {col["name"] for col in inspector.get_columns("positions")}
                position_migrations = [
                    ("position_type", "TEXT DEFAULT 'equity'"),
                    ("maturity_date", "DATETIME"),
                    ("interest_rate", "REAL"),
                    ("purchase_date", "DATETIME"),
                ]
                for col_name, col_type in position_migrations:
                    if col_name not in existing_cols:
                        conn.execute(text(f"ALTER TABLE positions ADD COLUMN {col_name} {col_type}"))
                        conn.commit()

            # Check and add missing columns to monte_carlo_results table
            if "monte_carlo_results" in inspector.get_table_names():
                existing_cols = {col["name"] for col in inspector.get_columns("monte_carlo_results")}
                mc_migrations = [
                    ("projected_value_at_retirement", "REAL"),
                    ("conservative_value_at_retirement", "REAL"),
                    ("earliest_retirement_age", "REAL"),
                ]
                for col_name, col_type in mc_migrations:
                    if col_name not in existing_cols:
                        conn.execute(text(f"ALTER TABLE monte_carlo_results ADD COLUMN {col_name} {col_type}"))
                        conn.commit()

            # Check and add missing columns to budget_pretax_deductions table
            if "budget_pretax_deductions" in inspector.get_table_names():
                existing_cols = {col["name"] for col in inspector.get_columns("budget_pretax_deductions")}
                deduction_migrations = [
                    ("label", "TEXT"),  # User-friendly label (e.g., "John's 401k")
                ]
                for col_name, col_type in deduction_migrations:
                    if col_name not in existing_cols:
                        conn.execute(text(f"ALTER TABLE budget_pretax_deductions ADD COLUMN {col_name} {col_type}"))
                        conn.commit()

            # Create entities table if it doesn't exist
            if "entities" not in inspector.get_table_names():
                conn.execute(text("""
                    CREATE TABLE entities (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        entity_type TEXT NOT NULL DEFAULT 'individual',
                        is_default BOOLEAN DEFAULT 0,
                        is_household BOOLEAN DEFAULT 0,
                        color TEXT DEFAULT '#4A90D9',
                        icon TEXT DEFAULT 'user',
                        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                    )
                """))
                conn.commit()

            # Add entity_id column to tables that need entity ownership
            entity_tables = [
                "accounts",
                "budget_income_sources",
                "budget_expenses",
                "budget_tax_config",
                "monte_carlo_results",
            ]
            for table_name in entity_tables:
                if table_name in inspector.get_table_names():
                    existing_cols = {col["name"] for col in inspector.get_columns(table_name)}
                    if "entity_id" not in existing_cols:
                        conn.execute(text(f"ALTER TABLE {table_name} ADD COLUMN entity_id TEXT REFERENCES entities(id)"))
                        conn.commit()

    def get_session(self) -> Session:
        """Get a new database session."""
        return self.SessionLocal()

    # ==================== File Import Operations ====================

    def compute_file_hash(self, file_path: Path) -> str:
        """Compute SHA256 hash of file contents."""
        sha256 = hashlib.sha256()
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                sha256.update(chunk)
        return sha256.hexdigest()

    def is_file_imported(self, content_hash: str) -> bool:
        """Check if a file with this hash has already been imported."""
        with self.get_session() as session:
            existing = session.query(FileImport).filter_by(content_hash=content_hash).first()
            return existing is not None

    def record_import(
        self,
        file_name: str,
        file_path: str,
        content_hash: str,
        account_type: str,
        row_count: int = 0,
        status: str = "completed",
        error_message: Optional[str] = None,
    ) -> FileImport:
        """Record a file import."""
        with self.get_session() as session:
            file_import = FileImport(
                file_name=file_name,
                file_path=file_path,
                content_hash=content_hash,
                account_type=account_type,
                row_count=row_count,
                status=status,
                error_message=error_message,
            )
            session.add(file_import)
            session.commit()
            session.refresh(file_import)
            return file_import

    def get_import_history(self, limit: int = 50) -> list[FileImport]:
        """Get recent import history."""
        with self.get_session() as session:
            return (
                session.query(FileImport)
                .order_by(FileImport.import_date.desc())
                .limit(limit)
                .all()
            )

    def get_account_from_active_import(self, file_name: str) -> Optional[Account]:
        """Get the account currently populated by a specific file import."""
        with self.get_session() as session:
            # Find an account that has positions linked to an import with this filename
            result = (
                session.query(Account)
                .join(Position, Account.id == Position.account_id)
                .join(FileImport, Position.last_import_id == FileImport.id)
                .filter(FileImport.file_name == file_name)
                .first()
            )
            return result

    # ==================== Account Operations ====================

    def get_or_create_account(
        self,
        name: str,
        account_type: str,
        brokerage: str = "other",
        beneficiary: Optional[str] = None,
        custom_type_name: Optional[str] = None,
        is_retirement_account: Optional[bool] = None,
    ) -> Account:
        """Get existing account or create new one.

        Args:
            name: Account name
            account_type: Account type (predefined or custom:name)
            brokerage: Brokerage name
            beneficiary: For 529 accounts, the beneficiary name
            custom_type_name: Display name for custom account types
            is_retirement_account: Override retirement status
        """
        with self.get_session() as session:
            # Try to find existing account
            account = (
                session.query(Account)
                .filter_by(name=name, account_type=account_type)
                .first()
            )

            if account:
                account.updated_at = datetime.utcnow()
                # Update optional fields if provided
                if beneficiary is not None:
                    account.beneficiary = beneficiary
                if custom_type_name is not None:
                    account.custom_type_name = custom_type_name
                if is_retirement_account is not None:
                    account.is_retirement_account = is_retirement_account
                session.commit()
                session.refresh(account)
                return account

            # Determine if retirement account from type
            from src.models.account_types import is_retirement_account as check_retirement
            is_retirement = is_retirement_account if is_retirement_account is not None else check_retirement(account_type)

            # Create new account
            account = Account(
                name=name,
                account_type=account_type,
                brokerage=brokerage,
                beneficiary=beneficiary,
                custom_type_name=custom_type_name,
                is_retirement_account=is_retirement,
            )
            session.add(account)
            session.commit()
            session.refresh(account)
            return account

    def get_all_accounts(self) -> list[Account]:
        """Get all accounts."""
        with self.get_session() as session:
            return session.query(Account).all()

    def get_account_by_id(self, account_id: str) -> Optional[Account]:
        """Get account by ID."""
        with self.get_session() as session:
            return session.query(Account).filter_by(id=account_id).first()

    def delete_account(self, account_id: str) -> bool:
        """Delete an account and all its positions.

        Also removes the account from any views that reference it.
        """
        with self.get_session() as session:
            account = session.query(Account).filter_by(id=account_id).first()
            if account:
                # Remove this account from any views that reference it
                views = session.query(PortfolioView).all()
                for view in views:
                    account_ids = view.get_account_ids()
                    if account_id in account_ids:
                        account_ids.remove(account_id)
                        view.set_account_ids(account_ids)

                session.delete(account)
                session.commit()
                return True
            return False

    # ==================== Position Operations ====================

    def upsert_position(
        self,
        account_id: str,
        ticker: str,
        shares: float,
        name: Optional[str] = None,
        cost_basis: Optional[float] = None,
        current_price: Optional[float] = None,
        sector: Optional[str] = None,
        is_fund: bool = False,
        asset_class: str = "equity",
        import_id: Optional[str] = None,
    ) -> Position:
        """Update or insert a position."""
        with self.get_session() as session:
            # Try to find existing position
            position = (
                session.query(Position)
                .filter_by(account_id=account_id, ticker=ticker)
                .first()
            )

            if position:
                # Update existing
                position.shares = shares
                if name:
                    position.name = name
                if cost_basis is not None:
                    position.cost_basis = cost_basis
                if current_price is not None:
                    position.current_price = current_price
                if sector:
                    position.sector = sector
                position.is_fund = is_fund
                position.asset_class = asset_class
                if import_id:
                    position.last_import_id = import_id
                position.updated_at = datetime.utcnow()
            else:
                # Create new
                position = Position(
                    account_id=account_id,
                    ticker=ticker,
                    name=name or ticker,
                    shares=shares,
                    cost_basis=cost_basis,
                    current_price=current_price,
                    sector=sector,
                    is_fund=is_fund,
                    asset_class=asset_class,
                    last_import_id=import_id,
                )
                session.add(position)

            session.commit()
            session.refresh(position)
            return position

    def get_all_positions(self) -> list[Position]:
        """Get all positions across all accounts."""
        with self.get_session() as session:
            return session.query(Position).all()

    def calculate_accrued_value(self, position: Position) -> float:
        """Calculate the current value of a position including accrued interest.

        For CDs, bonds, and cash with APY, calculates simple interest:
        accrued_value = principal * (1 + apy * years_held)

        For regular positions, returns shares * current_price.

        Args:
            position: The position to calculate value for

        Returns:
            The current value including any accrued interest
        """
        if not position.current_price:
            return 0.0

        # For CDs, bonds, treasuries, and cash with interest rates
        if position.interest_rate and position.interest_rate > 0:
            principal = position.current_price  # For CDs/cash, price IS the principal
            apy = position.interest_rate

            # Calculate time held
            if position.purchase_date:
                days_held = (datetime.utcnow() - position.purchase_date).days
                years_held = days_held / 365.0

                # Simple interest formula: Principal * (1 + APY * Time)
                accrued_value = principal * (1 + apy * years_held)
                return accrued_value

            # No purchase date, just return principal
            return principal

        # Regular positions: shares * price
        return position.shares * position.current_price

    def get_positions_by_account(self, account_id: str) -> list[Position]:
        """Get all positions for an account."""
        with self.get_session() as session:
            return session.query(Position).filter_by(account_id=account_id).all()

    def add_position(
        self,
        account_id: str,
        ticker: str,
        shares: float,
        name: Optional[str] = None,
        cost_basis: Optional[float] = None,
        current_price: Optional[float] = None,
        sector: Optional[str] = None,
        is_fund: bool = False,
        asset_class: str = "equity",
        position_type: str = "equity",
        maturity_date: Optional[datetime] = None,
        interest_rate: Optional[float] = None,
        purchase_date: Optional[datetime] = None,
        import_id: Optional[str] = None,
    ) -> Position:
        """Add a new position (always creates new, never updates existing).

        Args:
            account_id: Account to add position to
            ticker: Ticker symbol (use "CASH" for cash positions)
            shares: Number of shares (for cash/CDs, this is typically 1.0)
            name: Display name
            cost_basis: Cost basis for the position
            current_price: Current price (for cash, this is the dollar amount)
            sector: Sector classification
            is_fund: Whether this is a fund/ETF
            asset_class: Asset class (equity, fixed_income, cash, alternative)
            position_type: Type of position (equity, fund, cash, cd, bond, treasury)
            maturity_date: For CDs/bonds, when it matures
            interest_rate: Annual interest rate for CDs/bonds
            purchase_date: When the position was purchased (for CD tracking)
            import_id: ID of the import that created this position
        """
        with self.get_session() as session:
            position = Position(
                account_id=account_id,
                ticker=ticker,
                name=name or ticker,
                shares=shares,
                cost_basis=cost_basis,
                current_price=current_price,
                sector=sector,
                is_fund=is_fund,
                asset_class=asset_class,
                position_type=position_type,
                maturity_date=maturity_date,
                interest_rate=interest_rate,
                purchase_date=purchase_date,
                last_import_id=import_id,
            )
            session.add(position)
            session.commit()
            session.refresh(position)
            return position

    def delete_position(self, position_id: str) -> bool:
        """Delete a position."""
        with self.get_session() as session:
            position = session.query(Position).filter_by(id=position_id).first()
            if position:
                session.delete(position)
                session.commit()
                return True
            return False

    def get_position_by_id(self, position_id: str) -> Position | None:
        """Get a position by its ID."""
        with self.get_session() as session:
            position = session.query(Position).filter_by(id=position_id).first()
            if position:
                session.expunge(position)
            return position

    def update_position(self, position_id: str, **kwargs) -> bool:
        """Update a position's fields."""
        with self.get_session() as session:
            position = session.query(Position).filter_by(id=position_id).first()
            if not position:
                return False

            for key, value in kwargs.items():
                if hasattr(position, key):
                    setattr(position, key, value)

            session.commit()
            return True

    def update_positions_sector(self, ticker: str, sector: str) -> int:
        """Update sector for all positions with given ticker. Returns count updated."""
        with self.get_session() as session:
            updated = session.query(Position).filter(
                Position.ticker.ilike(ticker)
            ).update({"sector": sector}, synchronize_session=False)
            session.commit()
            return updated

    def clear_positions_by_import(self, import_id: str) -> int:
        """Clear all positions from a specific import. Returns count deleted."""
        with self.get_session() as session:
            count = session.query(Position).filter_by(last_import_id=import_id).delete()
            session.commit()
            return count

    def clear_account_positions(self, account_id: str) -> int:
        """Clear all positions for an account. Returns count deleted."""
        with self.get_session() as session:
            count = session.query(Position).filter_by(account_id=account_id).delete()
            session.commit()
            return count

    def find_duplicate_positions(self) -> list[dict]:
        """Find positions that are likely duplicates.

        Detects positions with the SAME ticker and EXACT same shares across
        DIFFERENT accounts. This is highly suspicious because fractional
        shares are very unlikely to match exactly between accounts.

        Returns:
            List of duplicate groups, each containing:
            - ticker: The ticker symbol
            - shares: The exact share count
            - positions: List of position details
            - reason: Why this is flagged as duplicate
        """
        with self.get_session() as session:
            # Get all positions
            all_positions = session.query(Position).all()
            accounts = {a.id: a for a in session.query(Account).all()}

            # Group by ticker + shares
            groups = {}
            for pos in all_positions:
                # Round to 6 decimal places for comparison
                key = (pos.ticker.upper(), round(pos.shares, 6))
                if key not in groups:
                    groups[key] = []
                groups[key].append(pos)

            # Find groups with positions in different accounts
            duplicates = []
            for (ticker, shares), positions in groups.items():
                if len(positions) < 2:
                    continue

                # Check if positions are in different accounts
                unique_accounts = set(p.account_id for p in positions)
                if len(unique_accounts) < 2:
                    continue  # Same account, not a duplicate issue

                # This is suspicious - same ticker, exact shares, different accounts
                account_names = [accounts.get(p.account_id).name if accounts.get(p.account_id) else "Unknown" for p in positions]

                duplicates.append({
                    "ticker": ticker,
                    "shares": shares,
                    "positions": [
                        {
                            "id": p.id,
                            "account_id": p.account_id,
                            "account_name": accounts.get(p.account_id).name if accounts.get(p.account_id) else "Unknown",
                            "name": p.name,
                            "value": p.market_value,
                        }
                        for p in positions
                    ],
                    "reason": f"Exact same quantity ({shares:,.6f}) of {ticker} found in {len(unique_accounts)} different accounts: {', '.join(account_names)}",
                })

            return duplicates

    # ==================== Snapshot Operations ====================

    def take_snapshot(self) -> PortfolioSnapshot:
        """Take a snapshot of the current portfolio state."""
        with self.get_session() as session:
            # Get all accounts with positions
            accounts = session.query(Account).all()

            total_value = 0.0
            retirement_value = 0.0
            taxable_value = 0.0
            positions_data = []

            for account in accounts:
                positions = session.query(Position).filter_by(account_id=account.id).all()
                for pos in positions:
                    value = (pos.shares * pos.current_price) if pos.current_price else 0.0
                    total_value += value

                    if account.is_retirement:
                        retirement_value += value
                    else:
                        taxable_value += value

                    positions_data.append({
                        "account_id": account.id,
                        "account_name": account.name,
                        "account_type": account.account_type,
                        "ticker": pos.ticker,
                        "name": pos.name,
                        "shares": pos.shares,
                        "price": pos.current_price,
                        "value": value,
                        "cost_basis": pos.cost_basis,
                    })

            # Check if we already have a snapshot for today
            today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
            existing = session.query(PortfolioSnapshot).filter_by(snapshot_date=today).first()

            if existing:
                # Update existing snapshot
                existing.total_value = total_value
                existing.retirement_value = retirement_value
                existing.taxable_value = taxable_value
                existing.positions_json = json.dumps(positions_data)
                session.commit()
                session.refresh(existing)
                return existing

            # Create new snapshot
            snapshot = PortfolioSnapshot(
                snapshot_date=today,
                total_value=total_value,
                retirement_value=retirement_value,
                taxable_value=taxable_value,
                positions_json=json.dumps(positions_data),
            )
            session.add(snapshot)
            session.commit()
            session.refresh(snapshot)
            return snapshot

    def get_snapshots(self, limit: int = 365) -> list[PortfolioSnapshot]:
        """Get historical snapshots."""
        with self.get_session() as session:
            return (
                session.query(PortfolioSnapshot)
                .order_by(PortfolioSnapshot.snapshot_date.desc())
                .limit(limit)
                .all()
            )

    # ==================== Price Cache Operations ====================

    def get_cached_price(self, ticker: str, max_age_hours: int = 24) -> Optional[float]:
        """Get cached price if not stale (default 24 hours)."""
        with self.get_session() as session:
            cache = session.query(PriceCache).filter_by(ticker=ticker).first()
            if cache and not cache.is_stale(max_age_hours):
                return cache.current_price
            return None

    def update_price_cache(
        self,
        ticker: str,
        current_price: float,
        previous_close: Optional[float] = None,
        year_high: Optional[float] = None,
        year_low: Optional[float] = None,
    ) -> PriceCache:
        """Update or insert price cache entry."""
        with self.get_session() as session:
            cache = session.query(PriceCache).filter_by(ticker=ticker).first()

            if cache:
                cache.current_price = current_price
                if previous_close is not None:
                    cache.previous_close = previous_close
                if year_high is not None:
                    cache.year_high = year_high
                if year_low is not None:
                    cache.year_low = year_low
                cache.last_updated = datetime.utcnow()
            else:
                cache = PriceCache(
                    ticker=ticker,
                    current_price=current_price,
                    previous_close=previous_close,
                    year_high=year_high,
                    year_low=year_low,
                )
                session.add(cache)

            session.commit()
            session.refresh(cache)
            return cache

    def get_all_cached_prices(self) -> dict[str, float]:
        """Get all cached prices as a dict."""
        with self.get_session() as session:
            caches = session.query(PriceCache).all()
            return {c.ticker: c.current_price for c in caches if c.current_price}

    def get_stale_tickers(self, max_age_hours: int = 24) -> list[str]:
        """Get list of tickers with stale or missing prices (default 24 hours)."""
        with self.get_session() as session:
            # Get all unique tickers from positions
            positions = session.query(Position.ticker).distinct().all()
            all_tickers = {p.ticker for p in positions}

            # Get cached tickers that are not stale
            fresh_caches = session.query(PriceCache).all()
            fresh_tickers = {c.ticker for c in fresh_caches if not c.is_stale(max_age_hours)}

            # Return tickers that need updating
            return list(all_tickers - fresh_tickers)

    def get_price_cache_status(self, max_age_hours: int = 24) -> dict:
        """Get status information about the price cache."""
        with self.get_session() as session:
            caches = session.query(PriceCache).all()
            positions = session.query(Position.ticker).distinct().all()
            all_tickers = {p.ticker for p in positions}

            if not caches:
                return {
                    "total_tickers": len(all_tickers),
                    "cached_tickers": 0,
                    "fresh_tickers": 0,
                    "stale_tickers": len(all_tickers),
                    "oldest_update": None,
                    "newest_update": None,
                    "all_fresh": False,
                }

            fresh_count = sum(1 for c in caches if not c.is_stale(max_age_hours))
            stale_count = len(caches) - fresh_count + len(all_tickers - {c.ticker for c in caches})

            oldest = min((c.last_updated for c in caches if c.last_updated), default=None)
            newest = max((c.last_updated for c in caches if c.last_updated), default=None)

            return {
                "total_tickers": len(all_tickers),
                "cached_tickers": len(caches),
                "fresh_tickers": fresh_count,
                "stale_tickers": stale_count,
                "oldest_update": oldest.isoformat() if oldest else None,
                "newest_update": newest.isoformat() if newest else None,
                "all_fresh": stale_count == 0,
            }

    # ==================== Portfolio Summary ====================

    def get_portfolio_summary(self) -> dict:
        """Get a summary of the entire portfolio."""
        with self.get_session() as session:
            accounts = session.query(Account).all()

            total_value = 0.0
            total_cost_basis = 0.0
            retirement_value = 0.0
            taxable_value = 0.0
            position_count = 0

            accounts_summary = []

            for account in accounts:
                positions = session.query(Position).filter_by(account_id=account.id).all()
                account_value = 0.0
                account_cost = 0.0

                for pos in positions:
                    value = (pos.shares * pos.current_price) if pos.current_price else 0.0
                    account_value += value
                    if pos.cost_basis:
                        account_cost += pos.cost_basis
                    position_count += 1

                total_value += account_value
                total_cost_basis += account_cost

                if account.is_retirement:
                    retirement_value += account_value
                else:
                    taxable_value += account_value

                from src.models.account_types import get_account_type_label

                accounts_summary.append({
                    "id": account.id,
                    "name": account.name,
                    "account_type": account.account_type,
                    "display_type": get_account_type_label(account.account_type),
                    "brokerage": account.brokerage,
                    "value": account_value,
                    "cost_basis": account_cost,
                    "position_count": len(positions),
                    "is_retirement": account.is_retirement,
                })

            return {
                "total_value": total_value,
                "total_cost_basis": total_cost_basis,
                "total_gain_loss": total_value - total_cost_basis if total_cost_basis > 0 else None,
                "retirement_value": retirement_value,
                "taxable_value": taxable_value,
                "account_count": len(accounts),
                "position_count": position_count,
                "accounts": accounts_summary,
            }

    # ==================== Settings Operations ====================

    def get_setting(self, key: str) -> Optional[AppSettings]:
        """Get a setting by key."""
        with self.get_session() as session:
            return session.query(AppSettings).filter_by(key=key).first()

    def set_setting(self, key: str, value: str, encrypted: bool = False) -> AppSettings:
        """Set a setting value."""
        with self.get_session() as session:
            setting = session.query(AppSettings).filter_by(key=key).first()
            if setting:
                setting.value = value
                setting.encrypted = encrypted
                setting.updated_at = datetime.utcnow()
            else:
                setting = AppSettings(key=key, value=value, encrypted=encrypted)
                session.add(setting)
            session.commit()
            session.refresh(setting)
            return setting

    def delete_setting(self, key: str) -> bool:
        """Delete a setting."""
        with self.get_session() as session:
            setting = session.query(AppSettings).filter_by(key=key).first()
            if setting:
                session.delete(setting)
                session.commit()
                return True
            return False

    def get_all_settings(self) -> list[AppSettings]:
        """Get all settings."""
        with self.get_session() as session:
            return session.query(AppSettings).all()

    # ==================== Trigger Operations ====================

    def create_trigger(
        self,
        name: str,
        condition_type: str,
        operator: str,
        threshold: float,
        ticker: Optional[str] = None,
        account_type: Optional[str] = None,
        sector: Optional[str] = None,
    ) -> AllocationTrigger:
        """Create a new allocation trigger."""
        with self.get_session() as session:
            trigger = AllocationTrigger(
                name=name,
                condition_type=condition_type,
                ticker=ticker,
                account_type=account_type,
                sector=sector,
                operator=operator,
                threshold=threshold,
            )
            session.add(trigger)
            session.commit()
            session.refresh(trigger)
            return trigger

    def get_all_triggers(self, active_only: bool = False) -> list[AllocationTrigger]:
        """Get all triggers."""
        with self.get_session() as session:
            query = session.query(AllocationTrigger)
            if active_only:
                query = query.filter_by(is_active=True)
            return query.all()

    def get_trigger_by_id(self, trigger_id: str) -> Optional[AllocationTrigger]:
        """Get a trigger by ID."""
        with self.get_session() as session:
            return session.query(AllocationTrigger).filter_by(id=trigger_id).first()

    def update_trigger(
        self,
        trigger_id: str,
        **kwargs,
    ) -> Optional[AllocationTrigger]:
        """Update a trigger."""
        with self.get_session() as session:
            trigger = session.query(AllocationTrigger).filter_by(id=trigger_id).first()
            if trigger:
                for key, value in kwargs.items():
                    if hasattr(trigger, key):
                        setattr(trigger, key, value)
                trigger.updated_at = datetime.utcnow()
                session.commit()
                session.refresh(trigger)
            return trigger

    def delete_trigger(self, trigger_id: str) -> bool:
        """Delete a trigger."""
        with self.get_session() as session:
            trigger = session.query(AllocationTrigger).filter_by(id=trigger_id).first()
            if trigger:
                session.delete(trigger)
                session.commit()
                return True
            return False

    # ==================== CD Maturity Operations ====================

    def check_cd_maturities(self) -> list[Position]:
        """Find CDs that have matured and convert to cash."""
        with self.get_session() as session:
            today = datetime.utcnow()
            matured = session.query(Position).filter(
                Position.position_type == "cd",
                Position.maturity_date <= today
            ).all()

            matured_positions = []
            for cd in matured:
                # Calculate final value with accrued interest
                if cd.interest_rate and cd.purchase_date:
                    days_held = (today - cd.purchase_date).days
                    years_held = days_held / 365.0
                    accrued_interest = cd.current_price * cd.interest_rate * years_held
                    cd.current_price = cd.current_price + accrued_interest

                # Convert to cash
                cd.position_type = "cash"
                cd.asset_class = "cash"
                cd.name = f"Matured CD - {cd.name or cd.ticker}"
                cd.ticker = "CASH"
                cd.maturity_date = None
                cd.interest_rate = None
                matured_positions.append(cd)

            if matured_positions:
                session.commit()

            return matured_positions

    def get_upcoming_cd_maturities(self, days: int = 30) -> list[Position]:
        """Get CDs maturing within the specified number of days."""
        with self.get_session() as session:
            future_date = datetime.utcnow() + timedelta(days=days)
            return session.query(Position).filter(
                Position.position_type == "cd",
                Position.maturity_date <= future_date,
                Position.maturity_date > datetime.utcnow()
            ).all()

    # ==================== Database Management ====================

    def reset_database(self) -> None:
        """Delete all data and recreate tables. Use with extreme caution."""
        Base.metadata.drop_all(self.engine)
        Base.metadata.create_all(self.engine)

    def export_database(self, path: str) -> dict:
        """Export database to JSON for backup."""
        with self.get_session() as session:
            data = {
                "accounts": [],
                "positions": [],
                "file_imports": [],
                "snapshots": [],
                "triggers": [],
                "settings": [],
                "exported_at": datetime.utcnow().isoformat(),
            }

            for account in session.query(Account).all():
                data["accounts"].append({
                    "id": account.id,
                    "name": account.name,
                    "account_type": account.account_type,
                    "brokerage": account.brokerage,
                    "beneficiary": account.beneficiary,
                    "custom_type_name": account.custom_type_name,
                    "is_retirement_account": account.is_retirement_account,
                })

            for pos in session.query(Position).all():
                data["positions"].append({
                    "id": pos.id,
                    "account_id": pos.account_id,
                    "ticker": pos.ticker,
                    "name": pos.name,
                    "shares": pos.shares,
                    "cost_basis": pos.cost_basis,
                    "current_price": pos.current_price,
                    "sector": pos.sector,
                    "is_fund": pos.is_fund,
                    "asset_class": pos.asset_class,
                    "position_type": pos.position_type,
                    "maturity_date": pos.maturity_date.isoformat() if pos.maturity_date else None,
                    "interest_rate": pos.interest_rate,
                    "purchase_date": pos.purchase_date.isoformat() if pos.purchase_date else None,
                })

            for trigger in session.query(AllocationTrigger).all():
                data["triggers"].append({
                    "id": trigger.id,
                    "name": trigger.name,
                    "condition_type": trigger.condition_type,
                    "ticker": trigger.ticker,
                    "account_type": trigger.account_type,
                    "sector": trigger.sector,
                    "operator": trigger.operator,
                    "threshold": trigger.threshold,
                    "is_active": trigger.is_active,
                })

            # Write to file
            with open(path, "w") as f:
                json.dump(data, f, indent=2)

            return data

    def import_database(self, path: str) -> dict:
        """Import database from JSON backup. Clears existing data first."""
        with open(path, "r") as f:
            data = json.load(f)

        # Reset database
        self.reset_database()

        with self.get_session() as session:
            # Import accounts
            for acc_data in data.get("accounts", []):
                account = Account(**{k: v for k, v in acc_data.items() if v is not None})
                session.add(account)

            # Import positions
            for pos_data in data.get("positions", []):
                if pos_data.get("maturity_date"):
                    pos_data["maturity_date"] = datetime.fromisoformat(pos_data["maturity_date"])
                if pos_data.get("purchase_date"):
                    pos_data["purchase_date"] = datetime.fromisoformat(pos_data["purchase_date"])
                position = Position(**{k: v for k, v in pos_data.items() if v is not None})
                session.add(position)

            # Import triggers
            for trigger_data in data.get("triggers", []):
                trigger = AllocationTrigger(**{k: v for k, v in trigger_data.items() if v is not None})
                session.add(trigger)

            session.commit()

        return {"imported": True, "accounts": len(data.get("accounts", [])), "positions": len(data.get("positions", []))}

    # ==================== Portfolio Views ====================

    def create_portfolio_view(
        self,
        name: str,
        account_ids: list[str],
        is_default: bool = False,
    ) -> PortfolioView:
        """Create a new portfolio view."""
        with self.get_session() as session:
            # If setting as default, unset other defaults
            if is_default:
                session.query(PortfolioView).filter(
                    PortfolioView.is_default.is_(True)
                ).update({PortfolioView.is_default: False})

            view = PortfolioView(
                name=name,
                account_ids=json.dumps(account_ids),
                is_default=is_default,
            )
            session.add(view)
            session.commit()
            session.refresh(view)
            return view

    def get_all_views(self) -> list[PortfolioView]:
        """Get all portfolio views."""
        with self.get_session() as session:
            return session.query(PortfolioView).order_by(PortfolioView.name).all()

    def get_view_by_id(self, view_id: str) -> Optional[PortfolioView]:
        """Get a specific portfolio view by ID."""
        with self.get_session() as session:
            return session.query(PortfolioView).filter(PortfolioView.id == view_id).first()

    def get_default_view(self) -> Optional[PortfolioView]:
        """Get the default portfolio view."""
        with self.get_session() as session:
            return session.query(PortfolioView).filter(PortfolioView.is_default.is_(True)).first()

    def update_view(
        self,
        view_id: str,
        name: str = None,
        account_ids: list[str] = None,
        is_default: bool = None,
    ) -> Optional[PortfolioView]:
        """Update a portfolio view."""
        with self.get_session() as session:
            view = session.query(PortfolioView).filter(PortfolioView.id == view_id).first()
            if not view:
                return None

            if name is not None:
                view.name = name
            if account_ids is not None:
                view.account_ids = json.dumps(account_ids)
            if is_default is not None:
                if is_default:
                    # Unset other defaults first
                    session.query(PortfolioView).filter(
                        PortfolioView.is_default.is_(True),
                        PortfolioView.id != view_id
                    ).update({PortfolioView.is_default: False})
                view.is_default = is_default

            session.commit()
            session.refresh(view)
            return view

    def delete_view(self, view_id: str) -> bool:
        """Delete a portfolio view."""
        with self.get_session() as session:
            view = session.query(PortfolioView).filter(PortfolioView.id == view_id).first()
            if view:
                session.delete(view)
                session.commit()
                return True
            return False

    def ensure_all_accounts_view(self) -> PortfolioView:
        """Ensure an 'All Accounts' view exists and is up to date.

        The 'All Accounts' view is special - it always includes ALL current accounts.
        We update it every time to ensure it stays in sync.
        """
        with self.get_session() as session:
            # Get all current account IDs
            all_account_ids = [a.id for a in session.query(Account).all()]

            # Check if "All Accounts" view exists
            all_view = session.query(PortfolioView).filter(
                PortfolioView.name == "All Accounts"
            ).first()

            if not all_view:
                # Check if any view is default
                has_default = session.query(PortfolioView).filter(
                    PortfolioView.is_default.is_(True)
                ).first() is not None

                all_view = PortfolioView(
                    name="All Accounts",
                    account_ids=json.dumps(all_account_ids),
                    is_default=not has_default,  # Make default if no other default exists
                )
                session.add(all_view)
            else:
                # Update the account IDs to include all current accounts
                all_view.set_account_ids(all_account_ids)

            session.commit()
            session.refresh(all_view)

            return all_view

    def get_positions_for_view(self, view_id: str = None) -> list[Position]:
        """Get positions filtered by a portfolio view. If view_id is None, return all."""
        with self.get_session() as session:
            if view_id:
                view = session.query(PortfolioView).filter(PortfolioView.id == view_id).first()
                if view:
                    account_ids = view.get_account_ids()
                    if account_ids:
                        return session.query(Position).filter(
                            Position.account_id.in_(account_ids)
                        ).all()
            # Return all positions if no view or empty view
            return session.query(Position).all()

    # ==================== Monte Carlo Results ====================

    def save_monte_carlo_result(
        self,
        current_age: float,
        retirement_age: float,
        portfolio_balance: float,
        success_rate: float,
        monthly_contribution: float = 0,
        monthly_withdrawal: float = 0,
        median_final_value: float = None,
        worst_case_final: float = None,
        best_case_final: float = None,
        earliest_retirement_age: float = None,
        projected_value_at_retirement: float = None,
        conservative_value_at_retirement: float = None,
    ) -> MonteCarloResult:
        """Save a Monte Carlo simulation result."""
        with self.get_session() as session:
            result = MonteCarloResult(
                current_age=current_age,
                retirement_age=retirement_age,
                portfolio_balance=portfolio_balance,
                monthly_contribution=monthly_contribution,
                monthly_withdrawal=monthly_withdrawal,
                success_rate=success_rate,
                median_final_value=median_final_value,
                worst_case_final=worst_case_final,
                best_case_final=best_case_final,
                earliest_retirement_age=earliest_retirement_age,
                projected_value_at_retirement=projected_value_at_retirement,
                conservative_value_at_retirement=conservative_value_at_retirement,
                run_date=datetime.utcnow(),
            )
            session.add(result)
            session.commit()
            session.refresh(result)
            return result

    def get_latest_monte_carlo_result(self) -> Optional[MonteCarloResult]:
        """Get the most recent Monte Carlo simulation result."""
        with self.get_session() as session:
            return session.query(MonteCarloResult).order_by(
                MonteCarloResult.run_date.desc()
            ).first()

    def get_monte_carlo_history(self, limit: int = 10) -> list[MonteCarloResult]:
        """Get recent Monte Carlo simulation results."""
        with self.get_session() as session:
            return session.query(MonteCarloResult).order_by(
                MonteCarloResult.run_date.desc()
            ).limit(limit).all()

    # ==================== Entity Operations ====================

    def create_entity(
        self,
        name: str,
        entity_type: str = "individual",
        is_default: bool = False,
        is_household: bool = False,
        color: Optional[str] = None,
        icon: Optional[str] = None,
    ) -> Entity:
        """Create a new entity."""
        import uuid as uuid_module

        with self.get_session() as session:
            # If setting as default, unset other defaults
            if is_default:
                session.query(Entity).filter(
                    Entity.is_default.is_(True)
                ).update({Entity.is_default: False})

            entity = Entity(
                id=str(uuid_module.uuid4()),
                name=name,
                entity_type=entity_type,
                is_default=is_default,
                is_household=is_household,
                color=color or "#4A90D9",
                icon=icon or ("users" if is_household else "user"),
            )
            session.add(entity)
            session.commit()
            session.refresh(entity)
            return entity

    def get_all_entities(self) -> list[Entity]:
        """Get all entities."""
        with self.get_session() as session:
            return session.query(Entity).order_by(Entity.name).all()

    def get_entity_by_id(self, entity_id: str) -> Optional[Entity]:
        """Get entity by ID."""
        with self.get_session() as session:
            return session.query(Entity).filter_by(id=entity_id).first()

    def get_default_entity(self) -> Optional[Entity]:
        """Get the default entity."""
        with self.get_session() as session:
            return session.query(Entity).filter_by(is_default=True).first()

    def get_household_entity(self) -> Optional[Entity]:
        """Get the household entity (combined family view)."""
        with self.get_session() as session:
            return session.query(Entity).filter_by(is_household=True).first()

    def update_entity(
        self,
        entity_id: str,
        name: Optional[str] = None,
        entity_type: Optional[str] = None,
        is_default: Optional[bool] = None,
        color: Optional[str] = None,
        icon: Optional[str] = None,
    ) -> Optional[Entity]:
        """Update an entity."""
        with self.get_session() as session:
            entity = session.query(Entity).filter_by(id=entity_id).first()
            if entity:
                if name is not None:
                    entity.name = name
                if entity_type is not None:
                    entity.entity_type = entity_type
                if is_default is not None:
                    if is_default:
                        # Unset other defaults first
                        session.query(Entity).filter(
                            Entity.is_default.is_(True),
                            Entity.id != entity_id
                        ).update({Entity.is_default: False})
                    entity.is_default = is_default
                if color is not None:
                    entity.color = color
                if icon is not None:
                    entity.icon = icon
                entity.updated_at = datetime.utcnow()
                session.commit()
                session.refresh(entity)
            return entity

    def delete_entity(self, entity_id: str) -> bool:
        """Delete an entity.

        Args:
            entity_id: ID of the entity to delete

        Returns:
            True if deleted successfully, False if entity not found

        Raises:
            ValueError: If entity has associated accounts, income sources, or expenses
        """
        with self.get_session() as session:
            entity = session.query(Entity).filter_by(id=entity_id).first()
            if not entity:
                return False

            # Check for associated accounts
            account_count = session.query(Account).filter_by(entity_id=entity_id).count()
            if account_count > 0:
                raise ValueError(
                    f"Cannot delete entity with {account_count} associated accounts"
                )

            # Check for associated income sources
            income_count = (
                session.query(BudgetIncomeSource).filter_by(entity_id=entity_id).count()
            )
            if income_count > 0:
                raise ValueError(
                    f"Cannot delete entity with {income_count} associated income sources"
                )

            # Check for associated expenses
            expense_count = (
                session.query(BudgetExpense).filter_by(entity_id=entity_id).count()
            )
            if expense_count > 0:
                raise ValueError(
                    f"Cannot delete entity with {expense_count} associated expenses"
                )

            session.delete(entity)
            session.commit()
            return True

    def ensure_household_entity(self) -> Entity:
        """Ensure a household entity exists and return it."""
        with self.get_session() as session:
            household = session.query(Entity).filter_by(is_household=True).first()

            if not household:
                import uuid as uuid_module
                household = Entity(
                    id=str(uuid_module.uuid4()),
                    name="Household",
                    entity_type="household",
                    is_household=True,
                    icon="users",
                    color="#2ECC71",
                )
                session.add(household)
                session.commit()
                session.refresh(household)

            return household

    # ==================== Entity-Filtered Queries ====================

    def get_accounts_by_entity(self, entity_id: str) -> list[Account]:
        """Get all accounts for a specific entity."""
        with self.get_session() as session:
            return session.query(Account).filter_by(entity_id=entity_id).all()

    def get_income_sources_by_entity(self, entity_id: str) -> list[BudgetIncomeSource]:
        """Get all income sources for a specific entity."""
        with self.get_session() as session:
            return session.query(BudgetIncomeSource).filter_by(entity_id=entity_id).all()

    def get_expenses_by_entity(self, entity_id: str) -> list[BudgetExpense]:
        """Get all expenses for a specific entity."""
        with self.get_session() as session:
            return session.query(BudgetExpense).filter_by(entity_id=entity_id).all()

    def get_portfolio_summary_by_entity(self, entity_id: Optional[str] = None) -> dict:
        """Get portfolio summary filtered by entity.

        If entity_id is None, returns combined household summary (all accounts).
        """
        with self.get_session() as session:
            if entity_id:
                accounts = session.query(Account).filter_by(entity_id=entity_id).all()
            else:
                accounts = session.query(Account).all()

            total_value = 0.0
            total_cost = 0.0
            retirement_value = 0.0
            taxable_value = 0.0
            account_list = []

            for account in accounts:
                positions = session.query(Position).filter_by(account_id=account.id).all()
                account_value = sum(p.market_value for p in positions if p.current_price)
                account_cost = sum(p.cost_basis or 0 for p in positions)

                total_value += account_value
                total_cost += account_cost

                if account.is_retirement:
                    retirement_value += account_value
                else:
                    taxable_value += account_value

                account_list.append({
                    "id": account.id,
                    "name": account.name,
                    "type": account.account_type,
                    "display_type": account.display_type,
                    "value": account_value,
                    "is_retirement": account.is_retirement,
                })

            total_gain_loss = total_value - total_cost if total_cost > 0 else 0

            return {
                "total_value": total_value,
                "total_cost": total_cost,
                "total_gain_loss": total_gain_loss,
                "retirement_value": retirement_value,
                "taxable_value": taxable_value,
                "accounts": account_list,
            }

    def get_latest_monte_carlo_result_by_entity(
        self, entity_id: Optional[str] = None
    ) -> Optional[MonteCarloResult]:
        """Get the most recent Monte Carlo simulation result for an entity.

        If entity_id is None, gets the household/global result (entity_id IS NULL).
        """
        with self.get_session() as session:
            query = session.query(MonteCarloResult)
            if entity_id:
                query = query.filter_by(entity_id=entity_id)
            else:
                query = query.filter(MonteCarloResult.entity_id.is_(None))
            return query.order_by(MonteCarloResult.run_date.desc()).first()

    def save_monte_carlo_result_for_entity(
        self,
        entity_id: Optional[str],
        current_age: float,
        retirement_age: float,
        portfolio_balance: float,
        monthly_contribution: float,
        monthly_withdrawal: float,
        success_rate: float,
        median_final_value: Optional[float] = None,
        worst_case_final: Optional[float] = None,
        best_case_final: Optional[float] = None,
        earliest_retirement_age: Optional[float] = None,
        projected_value_at_retirement: Optional[float] = None,
        conservative_value_at_retirement: Optional[float] = None,
    ) -> MonteCarloResult:
        """Save a Monte Carlo simulation result for a specific entity."""
        import uuid as uuid_module

        with self.get_session() as session:
            result = MonteCarloResult(
                id=str(uuid_module.uuid4()),
                entity_id=entity_id,
                current_age=current_age,
                retirement_age=retirement_age,
                portfolio_balance=portfolio_balance,
                monthly_contribution=monthly_contribution,
                monthly_withdrawal=monthly_withdrawal,
                success_rate=success_rate,
                median_final_value=median_final_value,
                worst_case_final=worst_case_final,
                best_case_final=best_case_final,
                earliest_retirement_age=earliest_retirement_age,
                projected_value_at_retirement=projected_value_at_retirement,
                conservative_value_at_retirement=conservative_value_at_retirement,
                run_date=datetime.utcnow(),
            )
            session.add(result)
            session.commit()
            session.refresh(result)
            return result

    def assign_account_to_entity(self, account_id: str, entity_id: Optional[str]) -> bool:
        """Assign an account to an entity."""
        with self.get_session() as session:
            account = session.query(Account).filter_by(id=account_id).first()
            if account:
                account.entity_id = entity_id
                account.updated_at = datetime.utcnow()
                session.commit()
                return True
            return False

    def assign_income_source_to_entity(self, income_id: str, entity_id: Optional[str]) -> bool:
        """Assign an income source to an entity."""
        with self.get_session() as session:
            income = session.query(BudgetIncomeSource).filter_by(id=income_id).first()
            if income:
                income.entity_id = entity_id
                income.updated_at = datetime.utcnow()
                session.commit()
                return True
            return False

    def assign_expense_to_entity(self, expense_id: str, entity_id: Optional[str]) -> bool:
        """Assign an expense to an entity."""
        with self.get_session() as session:
            expense = session.query(BudgetExpense).filter_by(id=expense_id).first()
            if expense:
                expense.entity_id = entity_id
                expense.updated_at = datetime.utcnow()
                session.commit()
                return True
            return False
