"""SQLAlchemy models for the portfolio database."""

import uuid
from datetime import datetime
from typing import Optional

from sqlalchemy import Column, DateTime, Float, ForeignKey, String, Text, Boolean
from sqlalchemy.orm import declarative_base, relationship

Base = declarative_base()


def generate_uuid() -> str:
    """Generate a new UUID string."""
    return str(uuid.uuid4())


class Entity(Base):
    """An entity represents an owner for financial tracking.

    Entities can be:
    - Individual: A single person
    - Household: A combined family unit
    - Trust: A legal trust entity
    - LLC: A limited liability company

    Accounts, income, and expenses are associated with entities to enable
    multi-person household tracking and separate financial views.
    """

    __tablename__ = "entities"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String, nullable=False)
    entity_type = Column(String, nullable=False, default="individual")  # individual, household, trust, llc
    is_default = Column(Boolean, default=False)  # Default entity for new items
    is_household = Column(Boolean, default=False)  # Special flag for combined view
    color = Column(String, default="#4A90D9")  # UI color for entity
    icon = Column(String, default="user")  # UI icon identifier
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships (back_populates defined on related models)
    accounts = relationship("Account", back_populates="entity")
    income_sources = relationship("BudgetIncomeSource", back_populates="entity")
    expenses = relationship("BudgetExpense", back_populates="entity")
    tax_configs = relationship("BudgetTaxConfig", back_populates="entity")
    monte_carlo_results = relationship("MonteCarloResult", back_populates="entity")


class FileImport(Base):
    """Track imported files with hash-based deduplication."""

    __tablename__ = "file_imports"

    id = Column(String, primary_key=True, default=generate_uuid)
    file_name = Column(String, nullable=False)
    file_path = Column(String, nullable=False)
    content_hash = Column(String, nullable=False, unique=True)  # SHA256
    account_type = Column(String, nullable=False)  # From subfolder name
    import_date = Column(DateTime, nullable=False, default=datetime.utcnow)
    row_count = Column(Float)
    status = Column(String, default="pending")  # pending, completed, error
    error_message = Column(Text)

    # Relationship to positions updated by this import
    positions = relationship("Position", back_populates="last_import")


class Account(Base):
    """Investment account (e.g., Roth IRA, 401k, Taxable)."""

    __tablename__ = "accounts"

    id = Column(String, primary_key=True, default=generate_uuid)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=True)  # Owner entity
    name = Column(String, nullable=False)
    account_type = Column(String, nullable=False)  # roth_ira, traditional_401k, custom:*, etc.
    brokerage = Column(String, default="other")  # schwab, fidelity, vanguard, other
    beneficiary = Column(String, nullable=True)  # For 529 accounts
    custom_type_name = Column(String, nullable=True)  # Display name for custom types
    is_retirement_account = Column(Boolean, default=False)  # User can override
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    entity = relationship("Entity", back_populates="accounts")
    positions = relationship("Position", back_populates="account", cascade="all, delete-orphan")

    @property
    def total_value(self) -> float:
        """Calculate total value of all positions."""
        return sum(p.market_value for p in self.positions if p.current_price)

    @property
    def is_retirement(self) -> bool:
        """Check if this is a retirement account."""
        # Use explicit flag if set, otherwise infer from type
        if self.is_retirement_account:
            return True
        return self.account_type in {
            "traditional_401k", "roth_401k",
            "traditional_ira", "roth_ira",
            "hsa", "pension"
        }

    @property
    def display_type(self) -> str:
        """Return human-readable account type."""
        from src.models.account_types import PREDEFINED_ACCOUNT_TYPES
        if self.account_type.startswith("custom:"):
            return self.custom_type_name or self.account_type[7:]
        return PREDEFINED_ACCOUNT_TYPES.get(self.account_type, {}).get("label", self.account_type)


class Position(Base):
    """A holding within an account."""

    __tablename__ = "positions"

    id = Column(String, primary_key=True, default=generate_uuid)
    account_id = Column(String, ForeignKey("accounts.id"), nullable=False)
    ticker = Column(String, nullable=False)  # Can be "CASH" for cash positions
    name = Column(String)
    shares = Column(Float, nullable=False)  # For cash/CDs, this is 1.0
    cost_basis = Column(Float)
    current_price = Column(Float)  # Cached from price lookup; for cash = dollar amount
    sector = Column(String)
    is_fund = Column(Boolean, default=False)
    asset_class = Column(String, default="equity")  # equity, fixed_income, alternative, cash
    position_type = Column(String, default="equity")  # equity, fund, cash, cd, bond, treasury
    maturity_date = Column(DateTime, nullable=True)  # For CDs/bonds
    interest_rate = Column(Float, nullable=True)  # Annual rate for CDs/bonds
    purchase_date = Column(DateTime, nullable=True)  # When CD/bond was purchased
    last_import_id = Column(String, ForeignKey("file_imports.id"))
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    account = relationship("Account", back_populates="positions")
    last_import = relationship("FileImport", back_populates="positions")

    @property
    def market_value(self) -> float:
        """Calculate market value."""
        if self.current_price and self.shares:
            return self.shares * self.current_price
        return 0.0

    @property
    def gain_loss(self) -> Optional[float]:
        """Calculate unrealized gain/loss."""
        if self.cost_basis and self.market_value:
            return self.market_value - self.cost_basis
        return None

    @property
    def gain_loss_pct(self) -> Optional[float]:
        """Calculate gain/loss percentage."""
        if self.cost_basis and self.cost_basis > 0 and self.gain_loss is not None:
            return (self.gain_loss / self.cost_basis) * 100
        return None


class PortfolioSnapshot(Base):
    """Historical snapshot of portfolio for trending."""

    __tablename__ = "portfolio_snapshots"

    id = Column(String, primary_key=True, default=generate_uuid)
    snapshot_date = Column(DateTime, nullable=False, unique=True)
    total_value = Column(Float)
    retirement_value = Column(Float)
    taxable_value = Column(Float)
    positions_json = Column(Text)  # JSON serialized positions for reconstruction
    created_at = Column(DateTime, default=datetime.utcnow)


class PriceCache(Base):
    """Cache for stock/fund prices."""

    __tablename__ = "price_cache"

    ticker = Column(String, primary_key=True)
    current_price = Column(Float)
    previous_close = Column(Float)
    year_high = Column(Float)
    year_low = Column(Float)
    last_updated = Column(DateTime, default=datetime.utcnow)

    def is_stale(self, max_age_hours: int = 24) -> bool:
        """Check if cache entry is stale (default 24 hours)."""
        if not self.last_updated:
            return True
        age = datetime.utcnow() - self.last_updated
        return age.total_seconds() > (max_age_hours * 3600)

    def age_hours(self) -> float:
        """Return age of cache entry in hours."""
        if not self.last_updated:
            return float('inf')
        age = datetime.utcnow() - self.last_updated
        return age.total_seconds() / 3600


class AppSettings(Base):
    """Application settings including encrypted API keys."""

    __tablename__ = "app_settings"

    key = Column(String, primary_key=True)
    value = Column(Text)
    encrypted = Column(Boolean, default=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class AllocationTrigger(Base):
    """User-configurable allocation alert triggers."""

    __tablename__ = "allocation_triggers"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String, nullable=False)  # User-friendly name
    condition_type = Column(String, nullable=False)  # ticker_value, ticker_percent, sector_percent, etc.
    ticker = Column(String, nullable=True)  # For ticker-based conditions
    account_type = Column(String, nullable=True)  # Filter by account type (optional)
    sector = Column(String, nullable=True)  # For sector-based conditions
    operator = Column(String, nullable=False)  # ">", "<", ">=", "<=", "=="
    threshold = Column(Float, nullable=False)  # The comparison value
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PortfolioView(Base):
    """User-defined portfolio views for filtering accounts."""

    __tablename__ = "portfolio_views"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String, nullable=False, unique=True)  # e.g., "My Investments", "Retirement Only"
    account_ids = Column(Text, nullable=False)  # JSON array of account IDs
    is_default = Column(Boolean, default=False)  # Only one view should be default
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def get_account_ids(self) -> list[str]:
        """Parse account IDs from JSON."""
        import json
        if not self.account_ids:
            return []
        try:
            return json.loads(self.account_ids)
        except json.JSONDecodeError:
            return []

    def set_account_ids(self, ids: list[str]):
        """Set account IDs as JSON."""
        import json
        self.account_ids = json.dumps(ids)


class MonteCarloResult(Base):
    """Cached Monte Carlo simulation results for dashboard metrics."""

    __tablename__ = "monte_carlo_results"

    id = Column(String, primary_key=True, default=generate_uuid)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=True)  # Entity for per-person results
    run_date = Column(DateTime, nullable=False, default=datetime.utcnow)

    # Input parameters
    current_age = Column(Float, nullable=False)
    retirement_age = Column(Float, nullable=False)
    portfolio_balance = Column(Float, nullable=False)
    monthly_contribution = Column(Float, default=0)
    monthly_withdrawal = Column(Float, default=0)

    # Key results
    success_rate = Column(Float, nullable=False)  # Probability of not running out by end_age
    median_final_value = Column(Float)
    worst_case_final = Column(Float)
    best_case_final = Column(Float)

    # Dashboard metrics
    earliest_retirement_age = Column(Float)  # Age where 80%+ success rate achieved
    projected_value_at_retirement = Column(Float)  # Median portfolio value at retirement age
    conservative_value_at_retirement = Column(Float)  # 25th percentile (1 std below median)

    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    entity = relationship("Entity", back_populates="monte_carlo_results")


# =============================================================================
# Budget Module Tables
# =============================================================================


class BudgetIncomeSource(Base):
    """Income source for budget tracking (employment, self-employment, etc.)."""

    __tablename__ = "budget_income_sources"

    id = Column(String, primary_key=True, default=generate_uuid)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=True)  # Owner entity
    name = Column(String, nullable=False)  # "Primary Job", "Spouse Job", etc.
    income_type = Column(String, nullable=False, default="employment")  # employment, self_employment, other
    gross_annual = Column(Float, nullable=False)  # Annual gross income
    pay_frequency = Column(String, nullable=False, default="biweekly")  # weekly, biweekly, semimonthly, monthly
    state = Column(String, default="CA")  # State for tax purposes
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    entity = relationship("Entity", back_populates="income_sources")
    deductions = relationship("BudgetPretaxDeduction", back_populates="income_source", cascade="all, delete-orphan")


class BudgetTaxConfig(Base):
    """Household tax configuration for budget calculations."""

    __tablename__ = "budget_tax_config"

    id = Column(String, primary_key=True, default=generate_uuid)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=True)  # Entity for per-person tax config
    tax_year = Column(Float, nullable=False, default=2024)
    filing_status = Column(String, nullable=False, default="single")  # single, married_joint, married_separate, head_household
    state = Column(String, default="CA")  # Primary state of residence
    ss_benefit_override = Column(Float, nullable=True)  # User-specified Social Security benefit
    additional_withholding = Column(Float, default=0)
    itemized_deduction = Column(Float, nullable=True)  # None = use standard deduction
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    entity = relationship("Entity", back_populates="tax_configs")


class BudgetExpenseCategory(Base):
    """Expense category for grouping budget expenses."""

    __tablename__ = "budget_expense_categories"

    id = Column(String, primary_key=True, default=generate_uuid)
    name = Column(String, nullable=False)
    icon = Column(String, default="")  # Icon name for UI
    color = Column(String, default="#6b7280")  # Hex color for charts
    sort_order = Column(Float, default=0)
    created_at = Column(DateTime, default=datetime.utcnow)

    # Relationships
    expenses = relationship("BudgetExpense", back_populates="category")


class BudgetExpense(Base):
    """Individual expense item for budget tracking."""

    __tablename__ = "budget_expenses"

    id = Column(String, primary_key=True, default=generate_uuid)
    entity_id = Column(String, ForeignKey("entities.id"), nullable=True)  # Owner entity
    category_id = Column(String, ForeignKey("budget_expense_categories.id"), nullable=False)
    name = Column(String, nullable=False)  # "Mortgage", "Electric Bill", etc.
    amount = Column(Float, nullable=False)
    frequency = Column(String, nullable=False, default="monthly")  # monthly, biweekly, weekly, annual, one_time
    is_pretax = Column(Boolean, default=False)  # 401k contributions, HSA, etc.
    is_mortgage = Column(Boolean, default=False)  # For mortgage breakdown
    principal_portion = Column(Float, nullable=True)  # Monthly principal (if mortgage)
    interest_portion = Column(Float, nullable=True)  # Monthly interest (if mortgage)
    is_active = Column(Boolean, default=True)
    start_date = Column(DateTime, nullable=True)  # For temporary expenses
    end_date = Column(DateTime, nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    entity = relationship("Entity", back_populates="expenses")
    category = relationship("BudgetExpenseCategory", back_populates="expenses")


class BudgetPretaxDeduction(Base):
    """Pre-tax deduction from income (401k, HSA, FSA, etc.)."""

    __tablename__ = "budget_pretax_deductions"

    id = Column(String, primary_key=True, default=generate_uuid)
    income_source_id = Column(String, ForeignKey("budget_income_sources.id"), nullable=True)
    label = Column(String, nullable=True)  # User-friendly label (e.g., "John's 401k", "Jane's HSA")
    deduction_type = Column(String, nullable=False, default="401k")  # 401k, hsa, fsa, dental, vision, other
    amount_per_period = Column(Float, nullable=False)  # Per paycheck amount
    employer_match = Column(Float, default=0)  # Employer contribution per period
    is_percentage = Column(Boolean, default=False)  # If true, amount is % of gross
    max_annual = Column(Float, nullable=True)  # Max annual contribution (for limits)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    # Relationships
    income_source = relationship("BudgetIncomeSource", back_populates="deductions")


# =============================================================================
# AI Commentary Table
# =============================================================================


class AICommentary(Base):
    """Cached AI-generated commentary for dashboard elements."""

    __tablename__ = "ai_commentary"

    id = Column(String, primary_key=True, default=generate_uuid)

    # Element identification
    element_id = Column(String, nullable=False, unique=True, index=True)
    # e.g., "dashboard.total_value", "analysis.risk.sharpe_ratio"
    element_type = Column(String, nullable=False)  # stat_card, chart, table, metric
    element_tab = Column(String, nullable=False)  # dashboard, holdings, analysis, etc.

    # Commentary content
    commentary = Column(Text, nullable=False)  # Main AI-generated text (markdown)
    comparison_data = Column(Text, nullable=True)  # JSON: web search enrichment data
    action_items = Column(Text, nullable=True)  # JSON array: actionable suggestions

    # Change detection
    data_hash = Column(String, nullable=False)  # SHA256 hash for staleness detection
    data_snapshot = Column(Text, nullable=True)  # JSON: cached data values at generation

    # Metadata
    generated_at = Column(DateTime, default=datetime.utcnow)
    # Note: model_version is set explicitly when saving; default is fallback only
    # See src/services/ai_config.py for centralized model configuration
    model_version = Column(String, default="claude-sonnet-4-20250514")
    generation_time_ms = Column(Float, nullable=True)
    token_count = Column(Float, nullable=True)
    web_search_used = Column(Boolean, default=False)

    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    def is_stale(self, current_hash: str, max_age_hours: int = 168) -> bool:
        """Check if commentary needs refresh.

        Args:
            current_hash: Hash of current data
            max_age_hours: Maximum age before forced refresh (default 7 days)

        Returns:
            True if commentary should be regenerated
        """
        # Hash mismatch = data changed
        if self.data_hash != current_hash:
            return True
        # Age check
        if not self.generated_at:
            return True
        age = datetime.utcnow() - self.generated_at
        return age.total_seconds() > (max_age_hours * 3600)

    def age_hours(self) -> float:
        """Return age of commentary in hours."""
        if not self.generated_at:
            return float('inf')
        age = datetime.utcnow() - self.generated_at
        return age.total_seconds() / 3600
