"""Settings API endpoints.

Settings are stored in the database (source of truth).
config.yaml provides initial defaults for first-time setup.
"""

import json
from pathlib import Path
from typing import Optional, cast

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from src.database import get_database

router = APIRouter(prefix="/api/settings", tags=["settings"])

CONFIG_PATH = Path("config.yaml")


def _load_yaml_defaults() -> dict:
    """Load default config from config.yaml (for initial values only)."""
    if not CONFIG_PATH.exists():
        return {}
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f) or {}


def load_config() -> dict:
    """Load configuration with database values taking precedence over yaml defaults.

    The database is the source of truth. config.yaml provides initial defaults.
    """
    # Start with yaml defaults
    config = _load_yaml_defaults()

    # Override with database values
    db = get_database()

    # Load personal settings from database
    personal_json = db.get_setting("personal_settings")
    if personal_json and personal_json.value:
        try:
            db_personal = json.loads(cast(str, personal_json.value))
            if "personal" not in config:
                config["personal"] = {}
            config["personal"].update(db_personal)
        except json.JSONDecodeError:
            pass

    # Load target allocations from database
    targets_json = db.get_setting("target_allocations")
    if targets_json and targets_json.value:
        try:
            db_targets = json.loads(cast(str, targets_json.value))
            if "targets" not in config:
                config["targets"] = {}
            # Deep merge targets
            for key, value in db_targets.items():
                if key in config["targets"] and isinstance(config["targets"][key], dict):
                    config["targets"][key].update(value)
                else:
                    config["targets"][key] = value
        except json.JSONDecodeError:
            pass

    # Load market assumptions from database
    market_json = db.get_setting("market_assumptions")
    if market_json and market_json.value:
        try:
            db_market = json.loads(cast(str, market_json.value))
            if "market" not in config:
                config["market"] = {}
            config["market"].update(db_market)
        except json.JSONDecodeError:
            pass

    # Load Monte Carlo settings from database
    mc_json = db.get_setting("monte_carlo_settings")
    if mc_json and mc_json.value:
        try:
            db_mc = json.loads(cast(str, mc_json.value))
            if "monte_carlo" not in config:
                config["monte_carlo"] = {}
            config["monte_carlo"].update(db_mc)
        except json.JSONDecodeError:
            pass

    # Load withdrawal settings from database
    withdrawal_json = db.get_setting("withdrawal_settings")
    if withdrawal_json and withdrawal_json.value:
        try:
            db_withdrawal = json.loads(cast(str, withdrawal_json.value))
            if "withdrawal" not in config:
                config["withdrawal"] = {}
            config["withdrawal"].update(db_withdrawal)
        except json.JSONDecodeError:
            pass

    # SECURITY: Remove sensitive sections before returning
    # API keys should NEVER be exposed through the config endpoint
    sensitive_sections = ["api_keys", "secrets", "credentials"]
    for section in sensitive_sections:
        config.pop(section, None)

    return config


# NOTE: We intentionally do NOT provide a save_config function.
# config.yaml contains defaults only and should never be modified at runtime.
# All user settings are stored in the database (AppSettings table).


class PersonalSettings(BaseModel):
    """Personal configuration settings."""
    dob: str = Field(..., description="Date of birth (YYYY-MM-DD)")
    retirement_age: int = Field(65, ge=30, le=100, description="Target retirement age")
    withdrawal_rate: int = Field(4, ge=1, le=100, description="Withdrawal rate in retirement (%)")
    target_monthly_income: float = Field(0, ge=0, description="Target annual income in retirement ($)")


class AssetClassTargets(BaseModel):
    """Target allocations by asset class."""
    equities: float = Field(0.90, ge=0, le=1)
    bonds: float = Field(0.025, ge=0, le=1)
    alternatives: float = Field(0.05, ge=0, le=1)
    cash: float = Field(0.025, ge=0, le=1)


class SectorTargets(BaseModel):
    """Target allocations by sector."""
    technology: float = Field(0.41, ge=0, le=1)
    healthcare: float = Field(0.15, ge=0, le=1)
    consumer: float = Field(0.11, ge=0, le=1)
    industrials: float = Field(0.10, ge=0, le=1)
    financials: float = Field(0.09, ge=0, le=1)
    energy_materials: float = Field(0.05, ge=0, le=1)
    real_estate: float = Field(0.05, ge=0, le=1)
    utilities: float = Field(0.04, ge=0, le=1)


class GeographyTargets(BaseModel):
    """Target allocations by geography."""
    us_large_cap: float = Field(0.42, ge=0, le=1)
    us_mid_small_cap: float = Field(0.15, ge=0, le=1)
    foreign_large: float = Field(0.23, ge=0, le=1)
    foreign_mid_small: float = Field(0.10, ge=0, le=1)
    emerging_markets: float = Field(0.10, ge=0, le=1)


class StyleTargets(BaseModel):
    """Target allocations by style."""
    growth: float = Field(0.65, ge=0, le=1)
    value: float = Field(0.35, ge=0, le=1)


class MarketAssumptions(BaseModel):
    """Market assumptions for projections."""
    stock_mean_return: float = Field(0.09, ge=0, le=0.30)
    stock_std_dev: float = Field(0.15, ge=0, le=0.50)
    bond_mean_return: float = Field(0.04, ge=0, le=0.20)
    bond_std_dev: float = Field(0.06, ge=0, le=0.30)
    stock_bond_correlation: float = Field(-0.2, ge=-1, le=1)
    inflation_rate: float = Field(0.03, ge=0, le=0.20)
    risk_free_rate: float = Field(0.04, ge=0, le=0.20)


class MonteCarloSettings(BaseModel):
    """Monte Carlo simulation settings."""
    num_simulations: int = Field(10000, ge=100, le=100000)
    black_swan_probability: float = Field(0.02, ge=0, le=0.20)
    black_swan_impact: float = Field(-0.40, ge=-1, le=0)
    golden_swan_probability: float = Field(0.02, ge=0, le=0.20)
    golden_swan_impact: float = Field(0.27, ge=0, le=1)
    t_distribution_df: int = Field(5, ge=2, le=30)


class WithdrawalSettings(BaseModel):
    """Withdrawal strategy settings."""
    default_rate: float = Field(0.04, ge=0, le=0.20)
    floor_multiplier: float = Field(0.85, ge=0.5, le=1)
    ceiling_multiplier: float = Field(1.15, ge=1, le=2)


class AllTargets(BaseModel):
    """All target allocation settings."""
    asset_class: AssetClassTargets
    sector: SectorTargets
    geography: GeographyTargets
    style: StyleTargets


class FullConfig(BaseModel):
    """Full configuration model."""
    personal: PersonalSettings
    targets: AllTargets
    market: MarketAssumptions
    monte_carlo: MonteCarloSettings
    withdrawal: WithdrawalSettings


@router.get("/config")
def get_full_config() -> dict:
    """Get the full configuration."""
    config = load_config()
    return config


@router.get("/config/{section}")
def get_config_section(section: str) -> dict:
    """Get a specific configuration section."""
    config = load_config()
    if section not in config:
        raise HTTPException(status_code=404, detail=f"Section '{section}' not found")
    return {section: config[section]}


@router.put("/config/personal")
def update_personal_settings(settings: PersonalSettings) -> dict:
    """Update personal settings.

    Saves to database (source of truth).
    """
    db = get_database()

    # Save to database as JSON
    settings_dict = settings.model_dump()
    db.set_setting("personal_settings", json.dumps(settings_dict))

    return {"status": "updated", "personal": settings_dict}


def _update_targets_in_db(section: str, data: dict) -> dict:
    """Helper to update a targets section in the database."""
    db = get_database()

    # Load existing targets from database
    targets_json = db.get_setting("target_allocations")
    if targets_json and targets_json.value:
        try:
            targets = json.loads(cast(str, targets_json.value))
        except json.JSONDecodeError:
            targets = {}
    else:
        targets = {}

    # Update the section
    targets[section] = data

    # Save back to database
    db.set_setting("target_allocations", json.dumps(targets))

    return data


@router.put("/config/targets/asset_class")
def update_asset_class_targets(targets: AssetClassTargets) -> dict:
    """Update asset class target allocations (saves to database)."""
    result = _update_targets_in_db("asset_class", targets.model_dump())
    return {"status": "updated", "asset_class": result}


@router.put("/config/targets/sector")
def update_sector_targets(targets: SectorTargets) -> dict:
    """Update sector target allocations (saves to database)."""
    result = _update_targets_in_db("sector", targets.model_dump())
    return {"status": "updated", "sector": result}


@router.put("/config/targets/geography")
def update_geography_targets(targets: GeographyTargets) -> dict:
    """Update geography target allocations (saves to database)."""
    result = _update_targets_in_db("geography", targets.model_dump())
    return {"status": "updated", "geography": result}


@router.put("/config/targets/style")
def update_style_targets(targets: StyleTargets) -> dict:
    """Update style target allocations (saves to database)."""
    result = _update_targets_in_db("style", targets.model_dump())
    return {"status": "updated", "style": result}


@router.put("/config/market")
def update_market_assumptions(settings: MarketAssumptions) -> dict:
    """Update market assumptions (saves to database)."""
    db = get_database()
    db.set_setting("market_assumptions", json.dumps(settings.model_dump()))
    return {"status": "updated", "market": settings.model_dump()}


@router.put("/config/monte_carlo")
def update_monte_carlo_settings(settings: MonteCarloSettings) -> dict:
    """Update Monte Carlo settings (saves to database)."""
    db = get_database()
    db.set_setting("monte_carlo_settings", json.dumps(settings.model_dump()))
    return {"status": "updated", "monte_carlo": settings.model_dump()}


@router.put("/config/withdrawal")
def update_withdrawal_settings(settings: WithdrawalSettings) -> dict:
    """Update withdrawal settings (saves to database)."""
    db = get_database()
    db.set_setting("withdrawal_settings", json.dumps(settings.model_dump()))
    return {"status": "updated", "withdrawal": settings.model_dump()}


# API Key management endpoints
class ApiKeyRequest(BaseModel):
    """Request model for setting API key."""
    key: str = Field(..., description="API key name (e.g., anthropic_api_key)")
    value: str = Field(..., description="API key value")


@router.post("/api-key")
def set_api_key(request: ApiKeyRequest) -> dict:
    """Store an API key securely in the database."""
    from src.services import SecretsManager

    db = get_database()
    secrets = SecretsManager(db)
    secrets.set_api_key(request.key, request.value)
    return {"status": "stored", "key": request.key, "masked": secrets.mask_key(request.value)}


@router.get("/api-key/{key_name}")
def get_api_key_status(key_name: str) -> dict:
    """Check if an API key is set (without revealing the value)."""
    from src.services import SecretsManager

    db = get_database()
    secrets = SecretsManager(db)
    has_key = secrets.has_api_key(key_name)
    source = secrets.get_key_source(key_name) if has_key else None
    return {"key": key_name, "configured": has_key, "source": source}


@router.delete("/api-key/{key_name}")
def delete_api_key(key_name: str) -> dict:
    """Delete an API key from the database."""
    from src.services import SecretsManager
    from src.services.demo_mode import check_demo_data_protection
    check_demo_data_protection()

    db = get_database()
    secrets = SecretsManager(db)
    deleted = secrets.delete_api_key(key_name)
    return {"status": "deleted" if deleted else "not_found", "key": key_name}


# Theme settings
class ThemeSettings(BaseModel):
    """Theme preference settings."""
    mode: str = Field("dark", pattern="^(dark|light)$")


@router.get("/theme")
def get_theme() -> dict:
    """Get current theme setting."""
    db = get_database()
    setting = db.get_setting("theme_mode")
    return {"mode": setting.value if setting else "dark"}


@router.put("/theme")
def set_theme(settings: ThemeSettings) -> dict:
    """Set theme preference."""
    db = get_database()
    db.set_setting("theme_mode", settings.mode)
    return {"status": "updated", "mode": settings.mode}


# ==================== Portfolio Views ====================

class ViewCreateRequest(BaseModel):
    """Request model for creating a portfolio view."""
    name: str = Field(..., min_length=1, max_length=100)
    account_ids: list[str] = Field(..., description="List of account IDs to include")
    is_default: bool = Field(False, description="Set as default view")


class ViewUpdateRequest(BaseModel):
    """Request model for updating a portfolio view."""
    name: Optional[str] = Field(None, min_length=1, max_length=100)
    account_ids: Optional[list[str]] = None
    is_default: Optional[bool] = None


class ViewResponse(BaseModel):
    """Response model for a portfolio view."""
    id: str
    name: str
    account_ids: list[str]
    is_default: bool


@router.get("/views", response_model=list[ViewResponse])
def get_all_views() -> list[ViewResponse]:
    """Get all portfolio views."""
    db = get_database()

    # Ensure "All Accounts" view exists
    db.ensure_all_accounts_view()

    views = db.get_all_views()
    return [
        ViewResponse(
            id=cast(str, v.id),
            name=cast(str, v.name),
            account_ids=v.get_account_ids(),
            is_default=cast(bool, v.is_default),
        )
        for v in views
    ]


@router.get("/views/current")
def get_current_view() -> dict:
    """Get the current/default view."""
    db = get_database()

    view = db.get_default_view()
    if not view:
        # Ensure All Accounts view exists and get it
        view = db.ensure_all_accounts_view()

    return {
        "id": view.id,
        "name": view.name,
        "account_ids": view.get_account_ids(),
        "is_default": view.is_default,
    }


@router.post("/views", response_model=ViewResponse)
def create_view(request: ViewCreateRequest) -> ViewResponse:
    """Create a new portfolio view."""
    db = get_database()

    view = db.create_portfolio_view(
        name=request.name,
        account_ids=request.account_ids,
        is_default=request.is_default,
    )
    return ViewResponse(
        id=cast(str, view.id),
        name=cast(str, view.name),
        account_ids=view.get_account_ids(),
        is_default=cast(bool, view.is_default),
    )


@router.put("/views/{view_id}", response_model=ViewResponse)
def update_view(view_id: str, request: ViewUpdateRequest) -> ViewResponse:
    """Update a portfolio view."""
    db = get_database()

    view = db.update_view(
        view_id=view_id,
        name=request.name,
        account_ids=request.account_ids,
        is_default=request.is_default,
    )
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    return ViewResponse(
        id=cast(str, view.id),
        name=cast(str, view.name),
        account_ids=view.get_account_ids(),
        is_default=cast(bool, view.is_default),
    )


@router.delete("/views/{view_id}")
def delete_view(view_id: str) -> dict:
    """Delete a portfolio view."""
    from src.services.demo_mode import check_demo_data_protection
    check_demo_data_protection()

    db = get_database()

    # Don't allow deleting "All Accounts" view
    view = db.get_view_by_id(view_id)
    if view and view.name == "All Accounts":
        raise HTTPException(status_code=400, detail="Cannot delete 'All Accounts' view")

    if db.delete_view(view_id):
        return {"status": "deleted", "id": view_id}
    raise HTTPException(status_code=404, detail="View not found")


@router.put("/views/{view_id}/set-default")
def set_default_view(view_id: str) -> dict:
    """Set a view as the default."""
    db = get_database()

    view = db.update_view(view_id, is_default=True)
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    return {"status": "updated", "id": view_id, "name": view.name}


# ==================== API Keys Status ====================

@router.get("/api-keys/status")
def get_all_api_keys_status() -> dict:
    """Get status of all configured API keys."""
    from src.services import SecretsManager

    db = get_database()
    secrets = SecretsManager(db)

    # Check each API key
    keys = ["alpha_vantage", "massive", "finnhub", "anthropic_api_key", "gemini_api_key", "openai_api_key", "cerebras_api_key", "fmp_api_key"]
    statuses = {}

    for key in keys:
        has_key = secrets.has_api_key(key)
        source = secrets.get_key_source(key) if has_key else None
        statuses[key] = {
            "configured": has_key,
            "source": source,  # "config.yaml", "database", or "environment"
        }

    return {"api_keys": statuses}


# ==================== Demo Mode ====================

class DemoModeSettings(BaseModel):
    """Demo mode settings."""
    enabled: bool = Field(..., description="Whether demo mode is enabled")


@router.get("/demo-mode")
def get_demo_mode() -> dict:
    """Get current demo mode status (dynamic, no restart needed).

    Returns:
        enabled: Whether demo mode is currently enabled
        demo_initialized: Whether demo data exists
        protected: Whether demo data modifications are blocked (hosted site)
    """
    from src.services.demo_mode import get_demo_manager, is_demo_data_protected
    status = get_demo_manager().get_status()
    status["protected"] = is_demo_data_protected()
    return status


@router.put("/demo-mode")
def set_demo_mode(settings: DemoModeSettings) -> dict:
    """Toggle demo mode on/off dynamically (no server restart needed).

    When enabled:
    - Stores current profile ID for later restoration
    - Switches to demo database
    - Initializes demo database if it doesn't exist

    When disabled:
    - Restores the previous profile
    - Returns to personal portfolio data

    Note: PROTECT_DEMO_DATA only protects demo data from modifications,
    it does NOT prevent toggling demo mode on/off.
    """
    from src.services.demo_mode import get_demo_manager
    from src.database import get_profile_manager, reset_database_caches

    demo_manager = get_demo_manager()
    profile_manager = get_profile_manager()

    if settings.enabled:
        # Store current profile and enable demo mode
        current_profile = profile_manager.get_active_profile_id()
        result = demo_manager.enable(current_profile)
    else:
        # Disable demo mode and restore previous profile
        result = demo_manager.disable()

        # Restore the previous profile
        if "restore_profile_id" in result:
            try:
                profile_manager.activate_profile(result["restore_profile_id"])
            except Exception as e:
                result["restore_error"] = str(e)

    # CRITICAL: Reset all cached database connections to ensure fresh data
    reset_database_caches()

    # Add instruction for frontend
    result["action"] = "reload"
    result["message"] = "Demo mode toggled. Reload the page to see changes."

    # Include deployment info so frontend can update storage restrictions
    import os
    is_heroku = bool(os.environ.get("DYNO"))
    result["is_heroku"] = is_heroku
    result["server_storage_allowed"] = not is_heroku or settings.enabled

    return result


@router.get("/deployment-info")
def get_deployment_info() -> dict:
    """Get deployment environment information.

    Returns Heroku detection status and storage restrictions.
    On Heroku, server storage is only allowed in demo mode to prevent
    users from accidentally storing personal data on the hosted site.
    """
    import os
    from src.services.demo_mode import is_demo_mode

    is_heroku = bool(os.environ.get("DYNO"))
    demo_enabled = is_demo_mode()
    server_storage_allowed = not is_heroku or demo_enabled

    return {
        "is_heroku": is_heroku,
        "demo_mode": demo_enabled,
        "server_storage_allowed": server_storage_allowed,
        "server_storage_reason": (
            "Server storage is disabled on the hosted site for security. "
            "Your personal data should be stored locally on your device."
        ) if is_heroku and not demo_enabled else None,
    }


@router.post("/demo/generate")
def generate_demo_data() -> dict:
    """Generate demo portfolio data with realistic positions and prices.

    This creates a demo database with:
    - 6 account types (401k, IRA, taxable, HSA, 529)
    - ~50 diversified positions across various asset classes
    - Current prices from multiple API sources
    - CDs and cash positions with APY

    Returns status and summary of generated data.
    """
    from src.services.demo_mode import get_demo_manager, check_demo_data_protection
    check_demo_data_protection()
    return get_demo_manager().generate_demo_data()


@router.post("/demo/reset")
def reset_demo_data() -> dict:
    """Reset demo database (delete all demo data)."""
    from src.services.demo_mode import get_demo_manager, check_demo_data_protection
    check_demo_data_protection()
    return get_demo_manager().reset_demo_data()
