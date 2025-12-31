"""
Plugin registry for discovering, loading, and managing plugins.

This module handles:
- Plugin discovery in the plugins directory
- Manifest parsing and validation
- Plugin loading and initialization
- Plugin enabling/disabling
- Plugin settings management
"""

import importlib.util
import json
import logging
import sys
from pathlib import Path
from typing import Any, Optional, Type

import yaml

from .base import (
    PluginBase,
    PluginManifest,
    PluginType,
    PluginPermissions,
    PluginSetting,
    FileFormat,
    PluginMetric,
    WidgetConfig,
    DatabaseAccess,
    ImporterPlugin,
    AnalysisPlugin,
    WidgetPlugin,
    ProviderPlugin,
    ExportPlugin,
)
from .events import EventBus, Event, EventType, get_event_bus

logger = logging.getLogger(__name__)


class PluginRegistry:
    """
    Central registry for all plugins.

    Handles discovery, loading, and lifecycle management of plugins.
    """

    def __init__(
        self,
        plugins_dir: str = "src/plugins",
        data_dir: str = "data/plugins",
    ):
        self.plugins_dir = Path(plugins_dir)
        self.data_dir = Path(data_dir)
        self.installed_dir = self.plugins_dir / "installed"
        self.builtin_dir = self.plugins_dir / "builtin"

        # Ensure directories exist
        self.installed_dir.mkdir(parents=True, exist_ok=True)
        self.builtin_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # Plugin storage
        self._manifests: dict[str, PluginManifest] = {}
        self._plugins: dict[str, PluginBase] = {}
        self._settings: dict[str, dict[str, Any]] = {}

        # Settings file
        self._enabled_file = self.data_dir / "enabled.json"
        self._settings_file = self.data_dir / "settings.json"

        # Load persisted state
        self._load_enabled_state()
        self._load_settings()

    def _load_enabled_state(self) -> None:
        """Load enabled plugins from file."""
        self._enabled: set[str] = set()
        if self._enabled_file.exists():
            try:
                with open(self._enabled_file) as f:
                    data = json.load(f)
                    self._enabled = set(data.get("enabled", []))
            except Exception as e:
                logger.error(f"Error loading enabled plugins: {e}")

    def _save_enabled_state(self) -> None:
        """Save enabled plugins to file."""
        try:
            with open(self._enabled_file, "w") as f:
                json.dump({"enabled": list(self._enabled)}, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving enabled plugins: {e}")

    def _load_settings(self) -> None:
        """Load plugin settings from file."""
        if self._settings_file.exists():
            try:
                with open(self._settings_file) as f:
                    self._settings = json.load(f)
            except Exception as e:
                logger.error(f"Error loading plugin settings: {e}")

    def _save_settings(self) -> None:
        """Save plugin settings to file."""
        try:
            with open(self._settings_file, "w") as f:
                json.dump(self._settings, f, indent=2)
        except Exception as e:
            logger.error(f"Error saving plugin settings: {e}")

    def discover_plugins(self, auto_enable_builtin: bool = True) -> list[PluginManifest]:
        """
        Discover all available plugins.

        Scans both builtin and installed plugin directories.

        Args:
            auto_enable_builtin: Automatically enable built-in plugins on first discovery

        Returns:
            List of discovered plugin manifests
        """
        manifests = []

        # Discover builtin plugins
        if self.builtin_dir.exists():
            for plugin_dir in self.builtin_dir.iterdir():
                if plugin_dir.is_dir():
                    manifest = self._load_manifest(plugin_dir, is_builtin=True)
                    if manifest:
                        manifests.append(manifest)
                        # Auto-enable built-in plugins that aren't in enabled state yet
                        if auto_enable_builtin and not manifest.load_error:
                            if manifest.plugin_id not in self._enabled:
                                self._enabled.add(manifest.plugin_id)
                                manifest.enabled = True
                                logger.info(f"Auto-enabled built-in plugin: {manifest.plugin_id}")

        # Discover installed plugins
        if self.installed_dir.exists():
            for plugin_dir in self.installed_dir.iterdir():
                if plugin_dir.is_dir():
                    manifest = self._load_manifest(plugin_dir, is_builtin=False)
                    if manifest:
                        manifests.append(manifest)

        # Update internal state
        self._manifests = {m.plugin_id: m for m in manifests}

        # Save enabled state if we auto-enabled any
        if auto_enable_builtin:
            self._save_enabled_state()

        logger.info(f"Discovered {len(manifests)} plugins")
        return manifests

    def _load_manifest(self, plugin_dir: Path, is_builtin: bool) -> Optional[PluginManifest]:
        """
        Load and parse a plugin manifest.

        Args:
            plugin_dir: Directory containing the plugin
            is_builtin: Whether this is a builtin plugin

        Returns:
            Parsed manifest or None if invalid
        """
        manifest_file = plugin_dir / "plugin.yaml"
        if not manifest_file.exists():
            manifest_file = plugin_dir / "plugin.yml"
        if not manifest_file.exists():
            logger.debug(f"No manifest found in {plugin_dir}")
            return None

        try:
            with open(manifest_file) as f:
                data = yaml.safe_load(f)

            manifest = self._parse_manifest(data, plugin_dir, is_builtin)
            manifest.enabled = manifest.plugin_id in self._enabled

            return manifest

        except Exception as e:
            logger.error(f"Error loading manifest from {plugin_dir}: {e}")

            # Return a manifest with error info
            return PluginManifest(
                name=plugin_dir.name,
                version="0.0.0",
                description=f"Error loading plugin: {e}",
                author="Unknown",
                license="Unknown",
                plugin_type=PluginType.IMPORTER,
                main="",
                entry_class="",
                plugin_id=plugin_dir.name,
                plugin_path=plugin_dir,
                is_builtin=is_builtin,
                load_error=str(e),
            )

    def _parse_manifest(
        self, data: dict, plugin_dir: Path, is_builtin: bool
    ) -> PluginManifest:
        """Parse manifest data into a PluginManifest object."""
        # Generate plugin ID from directory name
        plugin_id = plugin_dir.name

        # Parse permissions
        perms_data = data.get("permissions", {})
        permissions = PluginPermissions(
            file_read=perms_data.get("file_read", False),
            file_write=perms_data.get("file_write", False),
            network=perms_data.get("network", False),
            database=DatabaseAccess(perms_data.get("database", "none")),
            api_keys=perms_data.get("api_keys", []),
        )

        # Parse settings
        settings = []
        for s in data.get("settings", []):
            settings.append(
                PluginSetting(
                    key=s["key"],
                    type=s.get("type", "string"),
                    label=s.get("label", s["key"]),
                    description=s.get("description", ""),
                    default=s.get("default"),
                    options=s.get("options", []),
                    min_value=s.get("min"),
                    max_value=s.get("max"),
                    required=s.get("required", False),
                )
            )

        # Parse supported formats (for importers)
        formats = []
        for f in data.get("supported_formats", []):
            formats.append(
                FileFormat(
                    extension=f["extension"],
                    mime_type=f.get("mime_type", "application/octet-stream"),
                    description=f.get("description", ""),
                )
            )

        # Parse metrics (for analysis plugins)
        metrics = []
        for m in data.get("metrics", []):
            metrics.append(
                PluginMetric(
                    id=m["id"],
                    name=m.get("name", m["id"]),
                    description=m.get("description", ""),
                    type=m.get("type", "number"),
                )
            )

        # Parse widget config
        widget = None
        if "widget" in data:
            w = data["widget"]
            widget = WidgetConfig(
                title=w.get("title", data.get("name", plugin_id)),
                default_width=w.get("default_width", 1),
                default_height=w.get("default_height", 1),
                refresh_interval=w.get("refresh_interval", 0),
            )

        return PluginManifest(
            name=data["name"],
            version=data.get("version", "1.0.0"),
            description=data.get("description", ""),
            author=data.get("author", "Unknown"),
            license=data.get("license", "Unknown"),
            plugin_type=PluginType(data.get("plugin_type", "importer")),
            main=data.get("main", "__init__.py"),
            entry_class=data.get("class", data.get("entry_class", "")),
            requires_app_version=data.get("requires", {}).get(
                "portfolio_analyzer", ">=1.0.0"
            ),
            requires_python=data.get("requires", {}).get("python", ">=3.10"),
            dependencies=data.get("dependencies", []),
            permissions=permissions,
            settings=settings,
            supported_formats=formats,
            metrics=metrics,
            widget=widget,
            plugin_id=plugin_id,
            plugin_path=plugin_dir,
            is_builtin=is_builtin,
        )

    def load_plugin(self, plugin_id: str) -> Optional[PluginBase]:
        """
        Load and instantiate a plugin.

        Args:
            plugin_id: ID of the plugin to load

        Returns:
            Plugin instance or None if loading failed
        """
        manifest = self._manifests.get(plugin_id)
        if not manifest:
            logger.error(f"Plugin not found: {plugin_id}")
            return None

        if manifest.load_error:
            logger.error(f"Cannot load plugin with errors: {plugin_id}")
            return None

        if plugin_id in self._plugins:
            logger.debug(f"Plugin already loaded: {plugin_id}")
            return self._plugins[plugin_id]

        try:
            # Get plugin settings
            settings = self._settings.get(plugin_id, {})

            # Apply default values for missing settings
            for setting in manifest.settings:
                if setting.key not in settings and setting.default is not None:
                    settings[setting.key] = setting.default

            # Load the plugin module
            plugin_path = manifest.plugin_path / manifest.main
            spec = importlib.util.spec_from_file_location(
                f"plugins.{plugin_id}", plugin_path
            )
            if not spec or not spec.loader:
                raise ImportError(f"Could not load module from {plugin_path}")

            module = importlib.util.module_from_spec(spec)
            sys.modules[f"plugins.{plugin_id}"] = module
            spec.loader.exec_module(module)

            # Get the plugin class
            plugin_class = getattr(module, manifest.entry_class)

            # Verify it's the right type
            expected_base = self._get_expected_base_class(manifest.plugin_type)
            if not issubclass(plugin_class, expected_base):
                raise TypeError(
                    f"Plugin class {manifest.entry_class} must inherit from "
                    f"{expected_base.__name__}"
                )

            # Instantiate the plugin
            plugin = plugin_class(manifest, settings)
            plugin.initialize()

            self._plugins[plugin_id] = plugin
            logger.info(f"Loaded plugin: {plugin_id}")

            # Emit event
            get_event_bus().publish(
                Event(
                    EventType.PLUGIN_LOADED,
                    data={"plugin_id": plugin_id, "plugin_type": manifest.plugin_type.value},
                    source="registry",
                )
            )

            return plugin

        except Exception as e:
            logger.error(f"Error loading plugin {plugin_id}: {e}", exc_info=True)
            manifest.load_error = str(e)

            get_event_bus().publish(
                Event(
                    EventType.PLUGIN_ERROR,
                    data={"plugin_id": plugin_id, "error": str(e)},
                    source="registry",
                )
            )

            return None

    def _get_expected_base_class(self, plugin_type: PluginType) -> Type[PluginBase]:
        """Get the expected base class for a plugin type."""
        return {
            PluginType.IMPORTER: ImporterPlugin,
            PluginType.ANALYSIS: AnalysisPlugin,
            PluginType.WIDGET: WidgetPlugin,
            PluginType.PROVIDER: ProviderPlugin,
            PluginType.EXPORT: ExportPlugin,
        }.get(plugin_type, PluginBase)

    def unload_plugin(self, plugin_id: str) -> bool:
        """
        Unload a plugin.

        Args:
            plugin_id: ID of the plugin to unload

        Returns:
            True if plugin was unloaded
        """
        if plugin_id not in self._plugins:
            return False

        try:
            plugin = self._plugins[plugin_id]
            plugin.cleanup()

            # Unsubscribe from events
            get_event_bus().unsubscribe_all(plugin_id)

            # Remove from loaded plugins
            del self._plugins[plugin_id]

            # Remove from sys.modules
            module_name = f"plugins.{plugin_id}"
            if module_name in sys.modules:
                del sys.modules[module_name]

            logger.info(f"Unloaded plugin: {plugin_id}")

            get_event_bus().publish(
                Event(
                    EventType.PLUGIN_UNLOADED,
                    data={"plugin_id": plugin_id},
                    source="registry",
                )
            )

            return True

        except Exception as e:
            logger.error(f"Error unloading plugin {plugin_id}: {e}", exc_info=True)
            return False

    def enable_plugin(self, plugin_id: str) -> bool:
        """
        Enable a plugin.

        Args:
            plugin_id: ID of the plugin to enable

        Returns:
            True if plugin was enabled and loaded
        """
        if plugin_id not in self._manifests:
            logger.error(f"Plugin not found: {plugin_id}")
            return False

        self._enabled.add(plugin_id)
        self._manifests[plugin_id].enabled = True
        self._save_enabled_state()

        # Load the plugin
        return self.load_plugin(plugin_id) is not None

    def disable_plugin(self, plugin_id: str) -> bool:
        """
        Disable a plugin.

        Args:
            plugin_id: ID of the plugin to disable

        Returns:
            True if plugin was disabled
        """
        if plugin_id not in self._manifests:
            return False

        self._enabled.discard(plugin_id)
        self._manifests[plugin_id].enabled = False
        self._save_enabled_state()

        # Unload if loaded
        if plugin_id in self._plugins:
            self.unload_plugin(plugin_id)

        return True

    def get_plugin(self, plugin_id: str) -> Optional[PluginBase]:
        """Get a loaded plugin by ID."""
        return self._plugins.get(plugin_id)

    def get_manifest(self, plugin_id: str) -> Optional[PluginManifest]:
        """Get a plugin manifest by ID."""
        return self._manifests.get(plugin_id)

    def get_all_manifests(self) -> list[PluginManifest]:
        """Get all discovered plugin manifests."""
        return list(self._manifests.values())

    def get_enabled_plugins(self) -> list[PluginBase]:
        """Get all enabled and loaded plugins."""
        return list(self._plugins.values())

    def get_plugins_by_type(self, plugin_type: PluginType) -> list[PluginBase]:
        """Get all enabled plugins of a specific type."""
        return [
            p for p in self._plugins.values()
            if p.plugin_type == plugin_type
        ]

    def get_importers(self) -> list[ImporterPlugin]:
        """Get all enabled importer plugins."""
        return [
            p for p in self._plugins.values()
            if isinstance(p, ImporterPlugin)
        ]

    def get_analyzers(self) -> list[AnalysisPlugin]:
        """Get all enabled analysis plugins."""
        return [
            p for p in self._plugins.values()
            if isinstance(p, AnalysisPlugin)
        ]

    def get_widgets(self) -> list[WidgetPlugin]:
        """Get all enabled widget plugins."""
        return [
            p for p in self._plugins.values()
            if isinstance(p, WidgetPlugin)
        ]

    def get_plugin_settings(self, plugin_id: str) -> dict[str, Any]:
        """Get settings for a plugin."""
        return self._settings.get(plugin_id, {})

    def set_plugin_settings(self, plugin_id: str, settings: dict[str, Any]) -> None:
        """
        Update settings for a plugin.

        Args:
            plugin_id: ID of the plugin
            settings: New settings values
        """
        self._settings[plugin_id] = settings
        self._save_settings()

        # Update loaded plugin if present
        if plugin_id in self._plugins:
            plugin = self._plugins[plugin_id]
            plugin._settings = settings

    def load_enabled_plugins(self) -> int:
        """
        Load all enabled plugins.

        Returns:
            Number of plugins loaded successfully
        """
        loaded = 0
        for plugin_id in self._enabled:
            if plugin_id in self._manifests:
                if self.load_plugin(plugin_id):
                    loaded += 1
        return loaded


# Global registry instance
_registry: Optional[PluginRegistry] = None


def get_plugin_registry() -> PluginRegistry:
    """Get the global plugin registry instance."""
    global _registry
    if _registry is None:
        _registry = PluginRegistry()
    return _registry
