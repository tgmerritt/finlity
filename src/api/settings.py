"""Settings API endpoints for managing config.yaml."""

from pathlib import Path
from typing import Any, Optional

import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

router = APIRouter(prefix="/api/settings", tags=["settings"])

CONFIG_PATH = Path("config.yaml")


def load_config() -> dict:
    """Load config.yaml file."""
    if not CONFIG_PATH.exists():
        return {}
    with open(CONFIG_PATH) as f:
        return yaml.safe_load(f) or {}


def save_config(config: dict) -> None:
    """Save config.yaml file."""
    with open(CONFIG_PATH, "w") as f:
        yaml.dump(config, f, default_flow_style=False, sort_keys=False)


class PersonalSettings(BaseModel):
    """Personal configuration settings."""
    dob: str = Field(..., description="Date of birth (YYYY-MM-DD)")
    retirement_age: int = Field(65, ge=30, le=100, description="Target retirement age")


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
    """Update personal settings."""
    config = load_config()
    config["personal"] = settings.model_dump()
    save_config(config)
    return {"status": "updated", "personal": config["personal"]}


@router.put("/config/targets/asset_class")
def update_asset_class_targets(targets: AssetClassTargets) -> dict:
    """Update asset class target allocations."""
    config = load_config()
    if "targets" not in config:
        config["targets"] = {}
    config["targets"]["asset_class"] = targets.model_dump()
    save_config(config)
    return {"status": "updated", "asset_class": config["targets"]["asset_class"]}


@router.put("/config/targets/sector")
def update_sector_targets(targets: SectorTargets) -> dict:
    """Update sector target allocations."""
    config = load_config()
    if "targets" not in config:
        config["targets"] = {}
    config["targets"]["sector"] = targets.model_dump()
    save_config(config)
    return {"status": "updated", "sector": config["targets"]["sector"]}


@router.put("/config/targets/geography")
def update_geography_targets(targets: GeographyTargets) -> dict:
    """Update geography target allocations."""
    config = load_config()
    if "targets" not in config:
        config["targets"] = {}
    config["targets"]["geography"] = targets.model_dump()
    save_config(config)
    return {"status": "updated", "geography": config["targets"]["geography"]}


@router.put("/config/targets/style")
def update_style_targets(targets: StyleTargets) -> dict:
    """Update style target allocations."""
    config = load_config()
    if "targets" not in config:
        config["targets"] = {}
    config["targets"]["style"] = targets.model_dump()
    save_config(config)
    return {"status": "updated", "style": config["targets"]["style"]}


@router.put("/config/market")
def update_market_assumptions(settings: MarketAssumptions) -> dict:
    """Update market assumptions."""
    config = load_config()
    config["market"] = settings.model_dump()
    save_config(config)
    return {"status": "updated", "market": config["market"]}


@router.put("/config/monte_carlo")
def update_monte_carlo_settings(settings: MonteCarloSettings) -> dict:
    """Update Monte Carlo settings."""
    config = load_config()
    config["monte_carlo"] = settings.model_dump()
    save_config(config)
    return {"status": "updated", "monte_carlo": config["monte_carlo"]}


@router.put("/config/withdrawal")
def update_withdrawal_settings(settings: WithdrawalSettings) -> dict:
    """Update withdrawal settings."""
    config = load_config()
    config["withdrawal"] = settings.model_dump()
    save_config(config)
    return {"status": "updated", "withdrawal": config["withdrawal"]}


# API Key management endpoints
class ApiKeyRequest(BaseModel):
    """Request model for setting API key."""
    key: str = Field(..., description="API key name (e.g., anthropic_api_key)")
    value: str = Field(..., description="API key value")


@router.post("/api-key")
def set_api_key(request: ApiKeyRequest) -> dict:
    """Store an API key securely in the database."""
    from src.database import Database
    from src.services import SecretsManager

    db = Database()
    secrets = SecretsManager(db)
    secrets.set_api_key(request.key, request.value)
    return {"status": "stored", "key": request.key, "masked": secrets.mask_key(request.value)}


@router.get("/api-key/{key_name}")
def get_api_key_status(key_name: str) -> dict:
    """Check if an API key is set (without revealing the value)."""
    from src.database import Database
    from src.services import SecretsManager

    db = Database()
    secrets = SecretsManager(db)
    has_key = secrets.has_api_key(key_name)
    source = secrets.get_key_source(key_name) if has_key else None
    return {"key": key_name, "configured": has_key, "source": source}


@router.delete("/api-key/{key_name}")
def delete_api_key(key_name: str) -> dict:
    """Delete an API key from the database."""
    from src.database import Database
    from src.services import SecretsManager

    db = Database()
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
    from src.database import Database
    db = Database()
    setting = db.get_setting("theme_mode")
    return {"mode": setting.value if setting else "dark"}


@router.put("/theme")
def set_theme(settings: ThemeSettings) -> dict:
    """Set theme preference."""
    from src.database import Database
    db = Database()
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
    from src.database import Database
    db = Database()

    # Ensure "All Accounts" view exists
    db.ensure_all_accounts_view()

    views = db.get_all_views()
    return [
        ViewResponse(
            id=v.id,
            name=v.name,
            account_ids=v.get_account_ids(),
            is_default=v.is_default,
        )
        for v in views
    ]


@router.get("/views/current")
def get_current_view() -> dict:
    """Get the current/default view."""
    from src.database import Database
    db = Database()

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
    from src.database import Database
    db = Database()

    view = db.create_portfolio_view(
        name=request.name,
        account_ids=request.account_ids,
        is_default=request.is_default,
    )
    return ViewResponse(
        id=view.id,
        name=view.name,
        account_ids=view.get_account_ids(),
        is_default=view.is_default,
    )


@router.put("/views/{view_id}", response_model=ViewResponse)
def update_view(view_id: str, request: ViewUpdateRequest) -> ViewResponse:
    """Update a portfolio view."""
    from src.database import Database
    db = Database()

    view = db.update_view(
        view_id=view_id,
        name=request.name,
        account_ids=request.account_ids,
        is_default=request.is_default,
    )
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    return ViewResponse(
        id=view.id,
        name=view.name,
        account_ids=view.get_account_ids(),
        is_default=view.is_default,
    )


@router.delete("/views/{view_id}")
def delete_view(view_id: str) -> dict:
    """Delete a portfolio view."""
    from src.database import Database
    db = Database()

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
    from src.database import Database
    db = Database()

    view = db.update_view(view_id, is_default=True)
    if not view:
        raise HTTPException(status_code=404, detail="View not found")

    return {"status": "updated", "id": view_id, "name": view.name}


# ==================== API Keys Status ====================

@router.get("/api-keys/status")
def get_all_api_keys_status() -> dict:
    """Get status of all configured API keys."""
    from src.database import Database
    from src.services import SecretsManager

    db = Database()
    secrets = SecretsManager(db)

    # Check each API key
    keys = ["alpha_vantage", "massive", "finnhub", "anthropic_api_key"]
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
    """Get current demo mode status."""
    config = load_config()
    demo_config = config.get("demo", {})
    return {
        "enabled": demo_config.get("enabled", False),
        "database": demo_config.get("database", "data/demo/demo.db"),
    }


@router.put("/demo-mode")
def set_demo_mode(settings: DemoModeSettings) -> dict:
    """Toggle demo mode on/off. Requires server restart to take effect."""
    import os

    config = load_config()
    if "demo" not in config:
        config["demo"] = {}
    config["demo"]["enabled"] = settings.enabled
    save_config(config)

    return {
        "status": "updated",
        "enabled": settings.enabled,
        "message": "Restart server for changes to take effect",
    }
