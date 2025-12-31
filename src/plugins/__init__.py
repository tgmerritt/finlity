"""
Plugin system for extending the Portfolio Analyzer.

This module provides the infrastructure for loading, managing, and running plugins
that extend the functionality of the portfolio analyzer.
"""

from .base import (
    PluginBase,
    PluginType,
    PluginManifest,
    PluginPermissions,
    ImporterPlugin,
    AnalysisPlugin,
    WidgetPlugin,
    ProviderPlugin,
    ExportPlugin,
)
from .registry import PluginRegistry, get_plugin_registry
from .events import EventBus, get_event_bus

__all__ = [
    # Base classes
    "PluginBase",
    "PluginType",
    "PluginManifest",
    "PluginPermissions",
    "ImporterPlugin",
    "AnalysisPlugin",
    "WidgetPlugin",
    "ProviderPlugin",
    "ExportPlugin",
    # Registry
    "PluginRegistry",
    "get_plugin_registry",
    # Events
    "EventBus",
    "get_event_bus",
]
