"""
API endpoints for plugin management.

Provides REST endpoints for listing, enabling, disabling, and configuring plugins.
"""

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from src.plugins import get_plugin_registry, PluginType


router = APIRouter(prefix="/api/plugins", tags=["plugins"])


class PluginResponse(BaseModel):
    """Response model for plugin information."""
    plugin_id: str
    name: str
    version: str
    description: str
    author: str
    license: str
    plugin_type: str
    enabled: bool
    is_builtin: bool
    load_error: Optional[str] = None
    permissions: dict
    settings_schema: list[dict] = []


class PluginSettingsUpdate(BaseModel):
    """Request model for updating plugin settings."""
    settings: dict[str, Any]


class PluginEnableRequest(BaseModel):
    """Request model for enabling a plugin."""
    enable: bool


@router.get("", response_model=list[PluginResponse])
def list_plugins(
    plugin_type: Optional[str] = Query(None, description="Filter by plugin type"),
    enabled_only: bool = Query(False, description="Only show enabled plugins"),
):
    """
    List all discovered plugins.

    Returns manifests for all plugins found in the plugins directories.
    """
    registry = get_plugin_registry()

    # Ensure plugins are discovered
    registry.discover_plugins()

    manifests = registry.get_all_manifests()

    # Filter by type if specified
    if plugin_type:
        try:
            ptype = PluginType(plugin_type)
            manifests = [m for m in manifests if m.plugin_type == ptype]
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"Invalid plugin type: {plugin_type}. "
                f"Valid types: {[t.value for t in PluginType]}"
            )

    # Filter by enabled if specified
    if enabled_only:
        manifests = [m for m in manifests if m.enabled]

    return [
        PluginResponse(
            plugin_id=m.plugin_id,
            name=m.name,
            version=m.version,
            description=m.description,
            author=m.author,
            license=m.license,
            plugin_type=m.plugin_type.value,
            enabled=m.enabled,
            is_builtin=m.is_builtin,
            load_error=m.load_error,
            permissions=m.permissions.to_dict(),
            settings_schema=[
                {
                    "key": s.key,
                    "type": s.type,
                    "label": s.label,
                    "description": s.description,
                    "default": s.default,
                    "options": s.options,
                    "required": s.required,
                }
                for s in m.settings
            ],
        )
        for m in manifests
    ]


@router.get("/{plugin_id}", response_model=PluginResponse)
def get_plugin(plugin_id: str):
    """Get details for a specific plugin."""
    registry = get_plugin_registry()
    manifest = registry.get_manifest(plugin_id)

    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    return PluginResponse(
        plugin_id=manifest.plugin_id,
        name=manifest.name,
        version=manifest.version,
        description=manifest.description,
        author=manifest.author,
        license=manifest.license,
        plugin_type=manifest.plugin_type.value,
        enabled=manifest.enabled,
        is_builtin=manifest.is_builtin,
        load_error=manifest.load_error,
        permissions=manifest.permissions.to_dict(),
        settings_schema=[
            {
                "key": s.key,
                "type": s.type,
                "label": s.label,
                "description": s.description,
                "default": s.default,
                "options": s.options,
                "required": s.required,
            }
            for s in manifest.settings
        ],
    )


@router.post("/{plugin_id}/enable", response_model=PluginResponse)
def enable_plugin(plugin_id: str, request: PluginEnableRequest):
    """
    Enable or disable a plugin.

    When enabled, the plugin will be loaded and available for use.
    """
    registry = get_plugin_registry()
    manifest = registry.get_manifest(plugin_id)

    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    if manifest.load_error and request.enable:
        raise HTTPException(
            status_code=400,
            detail=f"Cannot enable plugin with load error: {manifest.load_error}"
        )

    if request.enable:
        success = registry.enable_plugin(plugin_id)
        if not success:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to enable plugin: {plugin_id}"
            )
    else:
        registry.disable_plugin(plugin_id)

    # Refresh manifest
    manifest = registry.get_manifest(plugin_id)

    return PluginResponse(
        plugin_id=manifest.plugin_id,
        name=manifest.name,
        version=manifest.version,
        description=manifest.description,
        author=manifest.author,
        license=manifest.license,
        plugin_type=manifest.plugin_type.value,
        enabled=manifest.enabled,
        is_builtin=manifest.is_builtin,
        load_error=manifest.load_error,
        permissions=manifest.permissions.to_dict(),
        settings_schema=[
            {
                "key": s.key,
                "type": s.type,
                "label": s.label,
                "description": s.description,
                "default": s.default,
                "options": s.options,
                "required": s.required,
            }
            for s in manifest.settings
        ],
    )


@router.get("/{plugin_id}/settings")
def get_plugin_settings(plugin_id: str):
    """Get current settings for a plugin."""
    registry = get_plugin_registry()
    manifest = registry.get_manifest(plugin_id)

    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    settings = registry.get_plugin_settings(plugin_id)

    # Add default values for missing settings
    for setting in manifest.settings:
        if setting.key not in settings and setting.default is not None:
            settings[setting.key] = setting.default

    return {
        "plugin_id": plugin_id,
        "settings": settings,
        "schema": [
            {
                "key": s.key,
                "type": s.type,
                "label": s.label,
                "description": s.description,
                "default": s.default,
                "options": s.options,
                "required": s.required,
            }
            for s in manifest.settings
        ],
    }


@router.put("/{plugin_id}/settings")
def update_plugin_settings(plugin_id: str, request: PluginSettingsUpdate):
    """Update settings for a plugin."""
    registry = get_plugin_registry()
    manifest = registry.get_manifest(plugin_id)

    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    # Validate settings against schema
    for setting in manifest.settings:
        if setting.required and setting.key not in request.settings:
            raise HTTPException(
                status_code=400,
                detail=f"Missing required setting: {setting.key}"
            )

        if setting.key in request.settings:
            value = request.settings[setting.key]

            # Type validation
            if setting.type == "select" and value not in setting.options:
                raise HTTPException(
                    status_code=400,
                    detail=f"Invalid value for {setting.key}: must be one of {setting.options}"
                )

            if setting.type == "number":
                if not isinstance(value, (int, float)):
                    raise HTTPException(
                        status_code=400,
                        detail=f"Invalid value for {setting.key}: must be a number"
                    )
                if setting.min_value is not None and value < setting.min_value:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Value for {setting.key} must be >= {setting.min_value}"
                    )
                if setting.max_value is not None and value > setting.max_value:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Value for {setting.key} must be <= {setting.max_value}"
                    )

    # Save settings
    registry.set_plugin_settings(plugin_id, request.settings)

    return {
        "plugin_id": plugin_id,
        "settings": request.settings,
        "message": "Settings updated successfully",
    }


@router.post("/discover")
def discover_plugins():
    """
    Trigger plugin discovery.

    Scans the plugins directories for new or updated plugins.
    """
    registry = get_plugin_registry()
    manifests = registry.discover_plugins()

    return {
        "discovered": len(manifests),
        "plugins": [
            {
                "plugin_id": m.plugin_id,
                "name": m.name,
                "plugin_type": m.plugin_type.value,
                "enabled": m.enabled,
                "has_error": bool(m.load_error),
            }
            for m in manifests
        ],
    }


@router.post("/reload")
def reload_plugins():
    """
    Reload all enabled plugins.

    Unloads and reloads all currently enabled plugins.
    """
    registry = get_plugin_registry()

    # Get currently enabled plugins
    enabled = [m.plugin_id for m in registry.get_all_manifests() if m.enabled]

    # Unload all
    for plugin_id in enabled:
        registry.unload_plugin(plugin_id)

    # Re-discover
    registry.discover_plugins()

    # Reload enabled
    loaded = registry.load_enabled_plugins()

    return {
        "reloaded": loaded,
        "total_enabled": len(enabled),
    }


@router.get("/types")
def get_plugin_types():
    """Get available plugin types."""
    return {
        "types": [
            {
                "value": t.value,
                "label": t.value.replace("_", " ").title(),
                "description": {
                    "importer": "Parse brokerage files and import positions",
                    "analysis": "Calculate metrics and provide insights",
                    "widget": "Dashboard components and visualizations",
                    "provider": "External data sources for prices and info",
                    "export": "Generate reports and export data",
                }.get(t.value, ""),
            }
            for t in PluginType
        ]
    }
