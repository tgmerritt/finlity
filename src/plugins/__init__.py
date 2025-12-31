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
    ImportResult,
    AnalysisResult,
)
from .registry import PluginRegistry, get_plugin_registry
from .events import EventBus, get_event_bus
from .import_pipeline import ImportPipeline, get_import_pipeline
from .analysis_pipeline import AnalysisPipeline, get_analysis_pipeline

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
    "ImportResult",
    "AnalysisResult",
    # Registry
    "PluginRegistry",
    "get_plugin_registry",
    # Events
    "EventBus",
    "get_event_bus",
    # Import Pipeline
    "ImportPipeline",
    "get_import_pipeline",
    # Analysis Pipeline
    "AnalysisPipeline",
    "get_analysis_pipeline",
]
