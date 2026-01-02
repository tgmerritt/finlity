"""
Widget pipeline for executing and managing widget plugins.

This module provides the integration layer between the widget plugins
and the dashboard system.
"""

from dataclasses import dataclass, field
from typing import Optional

from .base import WidgetPlugin, WidgetContent, WidgetConfig


@dataclass
class WidgetRenderResult:
    """Result from rendering a single widget."""
    plugin_id: str
    plugin_name: str
    config: Optional[WidgetConfig]
    content: Optional[WidgetContent]
    success: bool
    error: Optional[str] = None


@dataclass
class AllWidgetsResult:
    """Result from rendering all widgets."""
    success: bool
    widgets: list[WidgetRenderResult] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        """Convert to dictionary for API response."""
        return {
            "success": self.success,
            "widgets": [
                {
                    "plugin_id": w.plugin_id,
                    "plugin_name": w.plugin_name,
                    "config": {
                        "title": w.config.title,
                        "default_width": w.config.default_width,
                        "default_height": w.config.default_height,
                        "refresh_interval": w.config.refresh_interval,
                    } if w.config else None,
                    "content": {
                        "html": w.content.html,
                        "data": w.content.data,
                        "scripts": w.content.scripts,
                        "styles": w.content.styles,
                    } if w.content else None,
                    "success": w.success,
                    "error": w.error,
                }
                for w in self.widgets
            ],
            "errors": self.errors,
        }


class WidgetPipeline:
    """Pipeline for loading and rendering widget plugins."""

    def __init__(self):
        self._registry = None

    def _get_registry(self):
        """Get or create the plugin registry."""
        if self._registry is None:
            from .registry import get_plugin_registry
            self._registry = get_plugin_registry()
        return self._registry

    def get_widgets(self) -> list[WidgetPlugin]:
        """Get all enabled widget plugins."""
        registry = self._get_registry()
        return registry.get_widgets()

    def get_widget_info(self) -> list[dict]:
        """Get info about all available widgets."""
        widgets = self.get_widgets()
        result = []
        for widget in widgets:
            config = widget.get_config()
            result.append({
                "plugin_id": widget.manifest.plugin_id,
                "name": widget.name,
                "version": widget.version,
                "description": widget.manifest.description,
                "config": {
                    "title": config.title,
                    "default_width": config.default_width,
                    "default_height": config.default_height,
                    "refresh_interval": config.refresh_interval,
                } if config else None,
            })
        return result

    def render_all(
        self, positions: list[dict], accounts: list[dict]
    ) -> AllWidgetsResult:
        """
        Render all enabled widget plugins.

        Args:
            positions: List of position dictionaries
            accounts: List of account dictionaries

        Returns:
            AllWidgetsResult containing all widget render results
        """
        widgets = self.get_widgets()
        results = []
        errors = []

        for widget in widgets:
            try:
                content = widget.render(positions, accounts)
                config = widget.get_config()
                results.append(WidgetRenderResult(
                    plugin_id=widget.manifest.plugin_id,
                    plugin_name=widget.name,
                    config=config,
                    content=content,
                    success=True,
                ))
            except Exception as e:
                error_msg = f"Widget '{widget.name}' failed: {str(e)}"
                errors.append(error_msg)
                results.append(WidgetRenderResult(
                    plugin_id=widget.manifest.plugin_id,
                    plugin_name=widget.name,
                    config=widget.get_config(),
                    content=None,
                    success=False,
                    error=str(e),
                ))

        return AllWidgetsResult(
            success=len(errors) == 0,
            widgets=results,
            errors=errors,
        )

    def render_widget(
        self, plugin_id: str, positions: list[dict], accounts: list[dict]
    ) -> Optional[WidgetRenderResult]:
        """
        Render a specific widget plugin.

        Args:
            plugin_id: ID of the widget plugin
            positions: List of position dictionaries
            accounts: List of account dictionaries

        Returns:
            WidgetRenderResult or None if plugin not found
        """
        widgets = self.get_widgets()

        for widget in widgets:
            if widget.manifest.plugin_id == plugin_id:
                try:
                    content = widget.render(positions, accounts)
                    config = widget.get_config()
                    return WidgetRenderResult(
                        plugin_id=widget.manifest.plugin_id,
                        plugin_name=widget.name,
                        config=config,
                        content=content,
                        success=True,
                    )
                except Exception as e:
                    return WidgetRenderResult(
                        plugin_id=widget.manifest.plugin_id,
                        plugin_name=widget.name,
                        config=widget.get_config(),
                        content=None,
                        success=False,
                        error=str(e),
                    )

        return None


# Singleton instance
_widget_pipeline: Optional[WidgetPipeline] = None


def get_widget_pipeline() -> WidgetPipeline:
    """Get the singleton widget pipeline instance."""
    global _widget_pipeline
    if _widget_pipeline is None:
        _widget_pipeline = WidgetPipeline()
    return _widget_pipeline
