"""
API endpoints for plugin management.

Provides REST endpoints for listing, enabling, disabling, and configuring plugins.
"""

from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from src.plugins import (
    get_plugin_registry,
    get_analysis_pipeline,
    get_widget_pipeline,
    get_security_manager,
    PluginType,
)


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


# ============================================================================
# Analysis Plugin Endpoints
# ============================================================================


@router.get("/analysis/metrics")
def get_analysis_metrics():
    """
    Get all available analysis metrics from enabled plugins.

    Returns metric definitions with plugin information.
    """
    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_analysis_pipeline()
    metrics = pipeline.get_available_metrics()

    return {
        "metrics": metrics,
        "count": len(metrics),
    }


@router.post("/analysis/run")
def run_analysis_plugins(
    positions: list[dict],
    accounts: list[dict],
):
    """
    Run all analysis plugins on portfolio data.

    Args:
        positions: List of position dictionaries
        accounts: List of account dictionaries

    Returns aggregated results from all analysis plugins.
    """
    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_analysis_pipeline()
    result = pipeline.run_all(positions, accounts)

    return {
        "success": result.success,
        "metrics": result.all_metrics,
        "insights": result.all_insights,
        "errors": result.errors,
        "plugin_results": [
            {
                "plugin_id": pr.plugin_id,
                "plugin_name": pr.plugin_name,
                "success": pr.result.success,
                "metrics": pr.result.metrics,
                "insights": pr.result.insights,
                "warnings": pr.result.warnings,
                "errors": pr.result.errors,
            }
            for pr in result.plugin_results
        ],
    }


@router.post("/analysis/run/{plugin_id}")
def run_analysis_plugin(
    plugin_id: str,
    positions: list[dict],
    accounts: list[dict],
):
    """
    Run a specific analysis plugin.

    Args:
        plugin_id: ID of the analysis plugin to run
        positions: List of position dictionaries
        accounts: List of account dictionaries
    """
    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_analysis_pipeline()
    result = pipeline.run_plugin(plugin_id, positions, accounts)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Analysis plugin not found: {plugin_id}"
        )

    return {
        "plugin_id": plugin_id,
        "success": result.success,
        "metrics": result.metrics,
        "insights": result.insights,
        "warnings": result.warnings,
        "errors": result.errors,
    }


@router.get("/analysis/plugins")
def list_analysis_plugins():
    """List all enabled analysis plugins."""
    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_analysis_pipeline()
    analyzers = pipeline.get_analyzers()

    return {
        "plugins": [
            {
                "plugin_id": a.manifest.plugin_id,
                "name": a.name,
                "version": a.version,
                "description": a.manifest.description,
                "metrics": [
                    {
                        "id": m.id,
                        "name": m.name,
                        "description": m.description,
                        "type": m.type,
                    }
                    for m in a.get_metrics()
                ],
                "settings": registry.get_plugin_settings(a.manifest.plugin_id),
            }
            for a in analyzers
        ],
        "count": len(analyzers),
    }


# ============================================================================
# Widget Plugin Endpoints
# ============================================================================


@router.get("/widgets")
def list_widget_plugins():
    """List all enabled widget plugins."""
    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_widget_pipeline()
    widgets_info = pipeline.get_widget_info()

    return {
        "widgets": widgets_info,
        "count": len(widgets_info),
    }


@router.post("/widgets/render")
def render_all_widgets(
    positions: list[dict],
    accounts: list[dict],
):
    """
    Render all enabled widget plugins.

    Args:
        positions: List of position dictionaries
        accounts: List of account dictionaries

    Returns rendered content from all widget plugins.
    """
    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_widget_pipeline()
    result = pipeline.render_all(positions, accounts)

    return result.to_dict()


@router.post("/widgets/render/{plugin_id}")
def render_widget(
    plugin_id: str,
    positions: list[dict],
    accounts: list[dict],
):
    """
    Render a specific widget plugin.

    Args:
        plugin_id: ID of the widget plugin to render
        positions: List of position dictionaries
        accounts: List of account dictionaries
    """
    # Ensure plugins are loaded
    registry = get_plugin_registry()
    registry.discover_plugins(auto_enable_builtin=True)
    registry.load_enabled_plugins()

    pipeline = get_widget_pipeline()
    result = pipeline.render_widget(plugin_id, positions, accounts)

    if result is None:
        raise HTTPException(
            status_code=404,
            detail=f"Widget plugin not found: {plugin_id}"
        )

    return {
        "plugin_id": result.plugin_id,
        "plugin_name": result.plugin_name,
        "config": {
            "title": result.config.title,
            "default_width": result.config.default_width,
            "default_height": result.config.default_height,
            "refresh_interval": result.config.refresh_interval,
        } if result.config else None,
        "content": {
            "html": result.content.html,
            "data": result.content.data,
            "scripts": result.content.scripts,
            "styles": result.content.styles,
        } if result.content else None,
        "success": result.success,
        "error": result.error,
    }


# ============================================================================
# Security Endpoints
# ============================================================================


class PermissionApprovalRequest(BaseModel):
    """Request model for approving plugin permissions."""
    approve: bool


@router.get("/security/audit")
def get_audit_log(
    plugin_id: Optional[str] = Query(None, description="Filter by plugin ID"),
    limit: int = Query(100, description="Maximum entries to return"),
):
    """
    Get the security audit log.

    Returns recent security events including plugin loads, permission checks,
    and security violations.
    """
    security = get_security_manager()
    entries = security.get_audit_log(plugin_id=plugin_id, limit=limit)

    return {
        "entries": entries,
        "count": len(entries),
    }


@router.get("/security/violations")
def get_security_violations(
    limit: int = Query(50, description="Maximum entries to return"),
):
    """
    Get recent security violations.

    Returns permission denials, execution timeouts, and other security issues.
    """
    security = get_security_manager()
    violations = security.get_security_violations(limit=limit)

    return {
        "violations": violations,
        "count": len(violations),
    }


@router.get("/security/permissions")
def get_all_permissions():
    """
    Get permissions for all plugins.

    Returns requested and approved permissions for each plugin.
    """
    registry = get_plugin_registry()
    security = get_security_manager()

    # Ensure plugins are discovered
    registry.discover_plugins()

    plugins_permissions = []
    for manifest in registry.get_all_manifests():
        approved = security.permission_manager.get_approved_permissions(manifest.plugin_id)
        has_sensitive = security.permission_manager.has_sensitive_permissions(manifest)

        plugins_permissions.append({
            "plugin_id": manifest.plugin_id,
            "name": manifest.name,
            "is_builtin": manifest.is_builtin,
            "requested": manifest.permissions.to_dict(),
            "approved": approved.to_dict() if approved else None,
            "has_sensitive_permissions": has_sensitive,
            "needs_approval": has_sensitive and not approved and not manifest.is_builtin,
        })

    return {
        "plugins": plugins_permissions,
        "pending_count": len([p for p in plugins_permissions if p["needs_approval"]]),
    }


@router.get("/security/permissions/{plugin_id}")
def get_plugin_permissions(plugin_id: str):
    """
    Get permission details for a specific plugin.

    Returns both requested permissions (from manifest) and approved permissions.
    """
    registry = get_plugin_registry()
    security = get_security_manager()

    manifest = registry.get_manifest(plugin_id)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    approved = security.permission_manager.get_approved_permissions(plugin_id)
    can_load, reason = security.can_load_plugin(manifest)

    return {
        "plugin_id": plugin_id,
        "name": manifest.name,
        "is_builtin": manifest.is_builtin,
        "requested": manifest.permissions.to_dict(),
        "approved": approved.to_dict() if approved else None,
        "has_sensitive_permissions": security.permission_manager.has_sensitive_permissions(manifest),
        "can_load": can_load,
        "load_reason": reason,
    }


@router.post("/security/permissions/{plugin_id}/approve")
def approve_plugin_permissions(plugin_id: str, request: PermissionApprovalRequest):
    """
    Approve or deny permissions for a plugin.

    Approving grants the plugin all permissions it requested.
    Denying prevents the plugin from being loaded.
    """
    registry = get_plugin_registry()
    security = get_security_manager()

    manifest = registry.get_manifest(plugin_id)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    if manifest.is_builtin:
        raise HTTPException(
            status_code=400,
            detail="Cannot modify permissions for built-in plugins"
        )

    if request.approve:
        security.permission_manager.approve_permissions(
            plugin_id,
            manifest.permissions,
            approved_by="user",
        )
        message = "Permissions approved"
    else:
        security.permission_manager.deny_permissions(plugin_id)
        message = "Permissions denied"

    return {
        "plugin_id": plugin_id,
        "approved": request.approve,
        "message": message,
    }


@router.post("/security/permissions/{plugin_id}/revoke")
def revoke_plugin_permissions(plugin_id: str):
    """
    Revoke all approved permissions for a plugin.

    The plugin will need to be re-approved before it can be loaded again.
    """
    registry = get_plugin_registry()
    security = get_security_manager()

    manifest = registry.get_manifest(plugin_id)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    if manifest.is_builtin:
        raise HTTPException(
            status_code=400,
            detail="Cannot modify permissions for built-in plugins"
        )

    security.permission_manager.revoke_permissions(plugin_id)

    # Disable the plugin if it's enabled
    if manifest.enabled:
        registry.disable_plugin(plugin_id)

    return {
        "plugin_id": plugin_id,
        "message": "Permissions revoked",
    }


@router.get("/security/pending")
def get_pending_approvals():
    """
    Get plugins that need permission approval.

    Returns plugins with sensitive permissions that haven't been approved yet.
    """
    registry = get_plugin_registry()
    security = get_security_manager()

    # Ensure plugins are discovered
    registry.discover_plugins()

    pending = []
    for manifest in registry.get_all_manifests():
        if manifest.is_builtin:
            continue

        has_sensitive = security.permission_manager.has_sensitive_permissions(manifest)
        approved = security.permission_manager.get_approved_permissions(manifest.plugin_id)

        if has_sensitive and not approved:
            pending.append({
                "plugin_id": manifest.plugin_id,
                "name": manifest.name,
                "description": manifest.description,
                "author": manifest.author,
                "permissions": manifest.permissions.to_dict(),
                "sensitive_permissions": [
                    p for p in ["file_write", "network", "api_keys"]
                    if getattr(manifest.permissions, p, None)
                ] + (["database_write"] if manifest.permissions.database.value == "read_write" else []),
            })

    return {
        "pending": pending,
        "count": len(pending),
    }


@router.get("/security/validate/{plugin_id}")
def validate_plugin_security(plugin_id: str):
    """
    Validate a plugin's security configuration.

    Returns any security issues or warnings for the plugin.
    """
    registry = get_plugin_registry()
    security = get_security_manager()

    manifest = registry.get_manifest(plugin_id)
    if not manifest:
        raise HTTPException(status_code=404, detail=f"Plugin not found: {plugin_id}")

    is_valid, issues = security.validate_plugin(manifest)
    can_load, reason = security.can_load_plugin(manifest)

    return {
        "plugin_id": plugin_id,
        "name": manifest.name,
        "is_valid": is_valid,
        "issues": issues,
        "can_load": can_load,
        "load_reason": reason,
    }
