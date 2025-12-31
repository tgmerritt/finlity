"""
Base classes and types for the plugin system.

This module defines the core abstractions that all plugins must implement.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Optional


class PluginType(str, Enum):
    """Types of plugins supported by the system."""
    IMPORTER = "importer"      # Parse brokerage files
    ANALYSIS = "analysis"      # Calculate metrics
    WIDGET = "widget"          # Dashboard components
    PROVIDER = "provider"      # External data sources
    EXPORT = "export"          # Generate reports


class DatabaseAccess(str, Enum):
    """Database access levels for plugins."""
    NONE = "none"
    READ_ONLY = "read_only"
    READ_WRITE = "read_write"


@dataclass
class PluginPermissions:
    """Permissions required by a plugin."""
    file_read: bool = False
    file_write: bool = False
    network: bool = False
    database: DatabaseAccess = DatabaseAccess.NONE
    api_keys: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "file_read": self.file_read,
            "file_write": self.file_write,
            "network": self.network,
            "database": self.database.value,
            "api_keys": self.api_keys,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "PluginPermissions":
        return cls(
            file_read=data.get("file_read", False),
            file_write=data.get("file_write", False),
            network=data.get("network", False),
            database=DatabaseAccess(data.get("database", "none")),
            api_keys=data.get("api_keys", []),
        )


@dataclass
class PluginSetting:
    """A configurable setting for a plugin."""
    key: str
    type: str  # string, number, boolean, select
    label: str
    description: str = ""
    default: Any = None
    options: list[str] = field(default_factory=list)  # For select type
    min_value: Optional[float] = None  # For number type
    max_value: Optional[float] = None  # For number type
    required: bool = False


@dataclass
class FileFormat:
    """A file format supported by an importer plugin."""
    extension: str
    mime_type: str
    description: str


@dataclass
class PluginMetric:
    """A metric provided by an analysis plugin."""
    id: str
    name: str
    description: str
    type: str  # currency, percentage, number, text


@dataclass
class WidgetConfig:
    """Configuration for a widget plugin."""
    title: str
    default_width: int = 1
    default_height: int = 1
    refresh_interval: int = 0  # 0 = no auto-refresh


@dataclass
class PluginManifest:
    """Plugin manifest containing all metadata."""
    # Required fields
    name: str
    version: str
    description: str
    author: str
    license: str
    plugin_type: PluginType

    # Entry point
    main: str
    entry_class: str

    # Dependencies
    requires_app_version: str = ">=1.0.0"
    requires_python: str = ">=3.10"
    dependencies: list[str] = field(default_factory=list)

    # Permissions
    permissions: PluginPermissions = field(default_factory=PluginPermissions)

    # Settings schema
    settings: list[PluginSetting] = field(default_factory=list)

    # Type-specific config
    supported_formats: list[FileFormat] = field(default_factory=list)  # For importers
    metrics: list[PluginMetric] = field(default_factory=list)  # For analysis
    widget: Optional[WidgetConfig] = None  # For widgets

    # Runtime info
    plugin_id: str = ""
    plugin_path: Optional[Path] = None
    is_builtin: bool = False
    enabled: bool = False
    load_error: Optional[str] = None

    def to_dict(self) -> dict:
        """Convert manifest to dictionary."""
        result = {
            "name": self.name,
            "version": self.version,
            "description": self.description,
            "author": self.author,
            "license": self.license,
            "plugin_type": self.plugin_type.value,
            "main": self.main,
            "entry_class": self.entry_class,
            "requires_app_version": self.requires_app_version,
            "requires_python": self.requires_python,
            "dependencies": self.dependencies,
            "permissions": self.permissions.to_dict(),
            "settings": [
                {
                    "key": s.key,
                    "type": s.type,
                    "label": s.label,
                    "description": s.description,
                    "default": s.default,
                    "options": s.options,
                    "required": s.required,
                }
                for s in self.settings
            ],
            "plugin_id": self.plugin_id,
            "is_builtin": self.is_builtin,
            "enabled": self.enabled,
        }

        if self.supported_formats:
            result["supported_formats"] = [
                {"extension": f.extension, "mime_type": f.mime_type, "description": f.description}
                for f in self.supported_formats
            ]

        if self.metrics:
            result["metrics"] = [
                {"id": m.id, "name": m.name, "description": m.description, "type": m.type}
                for m in self.metrics
            ]

        if self.widget:
            result["widget"] = {
                "title": self.widget.title,
                "default_width": self.widget.default_width,
                "default_height": self.widget.default_height,
                "refresh_interval": self.widget.refresh_interval,
            }

        if self.load_error:
            result["load_error"] = self.load_error

        return result


class PluginBase(ABC):
    """Base class for all plugins."""

    def __init__(self, manifest: PluginManifest, settings: dict[str, Any] = None):
        self.manifest = manifest
        self._settings = settings or {}
        self._initialized = False

    @property
    def name(self) -> str:
        return self.manifest.name

    @property
    def version(self) -> str:
        return self.manifest.version

    @property
    def plugin_type(self) -> PluginType:
        return self.manifest.plugin_type

    def get_setting(self, key: str, default: Any = None) -> Any:
        """Get a plugin setting value."""
        return self._settings.get(key, default)

    def set_setting(self, key: str, value: Any) -> None:
        """Set a plugin setting value."""
        self._settings[key] = value

    def initialize(self) -> None:
        """Called when plugin is loaded. Override for setup logic."""
        self._initialized = True

    def cleanup(self) -> None:
        """Called when plugin is unloaded. Override for cleanup logic."""
        self._initialized = False

    @abstractmethod
    def get_info(self) -> dict:
        """Return plugin information for display."""
        pass


class ImporterPlugin(PluginBase):
    """Base class for data import plugins."""

    @abstractmethod
    def can_handle(self, file_path: Path, content_preview: bytes) -> float:
        """
        Return confidence score (0.0-1.0) for handling this file.

        Args:
            file_path: Path to the file
            content_preview: First 8KB of file content

        Returns:
            Confidence score between 0.0 (cannot handle) and 1.0 (perfect match)
        """
        pass

    @abstractmethod
    def import_file(self, file_path: Path, account_type: str) -> "ImportResult":
        """
        Import positions from file.

        Args:
            file_path: Path to the file to import
            account_type: Type of account (e.g., "roth_ira", "taxable")

        Returns:
            ImportResult with positions and metadata
        """
        pass

    def get_supported_formats(self) -> list[FileFormat]:
        """Return list of supported file formats."""
        return self.manifest.supported_formats

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "importer",
            "formats": [f.extension for f in self.get_supported_formats()],
        }


@dataclass
class ImportResult:
    """Result of an import operation."""
    success: bool
    positions: list[dict] = field(default_factory=list)
    account_name: Optional[str] = None
    message: str = ""
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    source_plugin: str = ""


class AnalysisPlugin(PluginBase):
    """Base class for analysis plugins."""

    @abstractmethod
    def analyze(self, positions: list[dict], accounts: list[dict]) -> "AnalysisResult":
        """
        Perform analysis on portfolio data.

        Args:
            positions: List of position dictionaries
            accounts: List of account dictionaries

        Returns:
            AnalysisResult with metrics and insights
        """
        pass

    def get_metrics(self) -> list[PluginMetric]:
        """Return list of metrics this plugin provides."""
        return self.manifest.metrics

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "analysis",
            "metrics": [m.id for m in self.get_metrics()],
        }


@dataclass
class AnalysisResult:
    """Result of an analysis operation."""
    success: bool
    metrics: dict[str, Any] = field(default_factory=dict)
    insights: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    source_plugin: str = ""


class WidgetPlugin(PluginBase):
    """Base class for dashboard widget plugins."""

    @abstractmethod
    def render(self, positions: list[dict], accounts: list[dict]) -> "WidgetContent":
        """
        Render widget content.

        Args:
            positions: List of position dictionaries
            accounts: List of account dictionaries

        Returns:
            WidgetContent with HTML/data for display
        """
        pass

    def get_config(self) -> Optional[WidgetConfig]:
        """Return widget configuration."""
        return self.manifest.widget

    def get_info(self) -> dict:
        config = self.get_config()
        return {
            "name": self.name,
            "version": self.version,
            "type": "widget",
            "title": config.title if config else self.name,
        }


@dataclass
class WidgetContent:
    """Content rendered by a widget plugin."""
    html: str = ""
    data: dict = field(default_factory=dict)
    scripts: list[str] = field(default_factory=list)
    styles: list[str] = field(default_factory=list)


class ProviderPlugin(PluginBase):
    """Base class for external data provider plugins."""

    @abstractmethod
    def get_price(self, ticker: str) -> Optional[float]:
        """Get current price for a ticker."""
        pass

    @abstractmethod
    def get_historical_prices(
        self, ticker: str, start_date: datetime, end_date: datetime
    ) -> list[dict]:
        """Get historical prices for a ticker."""
        pass

    def get_fund_info(self, ticker: str) -> Optional[dict]:
        """Get fund information (expense ratio, holdings, etc.)."""
        return None

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "provider",
        }


class ExportPlugin(PluginBase):
    """Base class for export plugins."""

    @abstractmethod
    def export(
        self,
        positions: list[dict],
        accounts: list[dict],
        options: dict[str, Any],
    ) -> "ExportResult":
        """
        Export portfolio data.

        Args:
            positions: List of position dictionaries
            accounts: List of account dictionaries
            options: Export options

        Returns:
            ExportResult with file path or content
        """
        pass

    def get_export_options(self) -> list[PluginSetting]:
        """Return available export options."""
        return self.manifest.settings

    def get_info(self) -> dict:
        return {
            "name": self.name,
            "version": self.version,
            "type": "export",
        }


@dataclass
class ExportResult:
    """Result of an export operation."""
    success: bool
    file_path: Optional[Path] = None
    content: Optional[bytes] = None
    content_type: str = "application/octet-stream"
    filename: str = ""
    message: str = ""
    errors: list[str] = field(default_factory=list)
