"""
Plugin installer for managing plugin installation from various sources.

Supports:
- Git repositories (GitHub, GitLab, etc.)
- ZIP file uploads
- Local directory copies
- Plugin updates and uninstallation
"""

import json
import logging
import os
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

import yaml

from .base import PluginManifest, PluginType

logger = logging.getLogger(__name__)


@dataclass
class InstallResult:
    """Result of a plugin installation."""
    success: bool
    plugin_id: str = ""
    plugin_name: str = ""
    version: str = ""
    message: str = ""
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


@dataclass
class PluginSource:
    """Information about where a plugin was installed from."""
    source_type: str  # "git", "zip", "local"
    source_url: str = ""
    installed_at: datetime = field(default_factory=datetime.now)
    installed_version: str = ""
    git_commit: str = ""


class PluginInstaller:
    """
    Handles plugin installation, updates, and uninstallation.

    Supports multiple installation sources:
    - Git: github:user/repo, gitlab:user/repo, or full URLs
    - ZIP: Upload via API
    - Local: Copy from local directory
    """

    def __init__(
        self,
        installed_dir: str = "src/plugins/installed",
        data_dir: str = "data/plugins",
    ):
        self.installed_dir = Path(installed_dir)
        self.data_dir = Path(data_dir)
        self.sources_file = self.data_dir / "sources.json"

        # Ensure directories exist
        self.installed_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # Load source tracking
        self._sources: dict[str, PluginSource] = {}
        self._load_sources()

    def _load_sources(self) -> None:
        """Load plugin source information."""
        if self.sources_file.exists():
            try:
                with open(self.sources_file) as f:
                    data = json.load(f)
                    for plugin_id, source_data in data.items():
                        self._sources[plugin_id] = PluginSource(
                            source_type=source_data["source_type"],
                            source_url=source_data.get("source_url", ""),
                            installed_at=datetime.fromisoformat(source_data["installed_at"]),
                            installed_version=source_data.get("installed_version", ""),
                            git_commit=source_data.get("git_commit", ""),
                        )
            except Exception as e:
                logger.warning(f"Failed to load plugin sources: {e}")

    def _save_sources(self) -> None:
        """Save plugin source information."""
        try:
            data = {}
            for plugin_id, source in self._sources.items():
                data[plugin_id] = {
                    "source_type": source.source_type,
                    "source_url": source.source_url,
                    "installed_at": source.installed_at.isoformat(),
                    "installed_version": source.installed_version,
                    "git_commit": source.git_commit,
                }
            with open(self.sources_file, "w") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save plugin sources: {e}")

    def install_from_git(self, source: str) -> InstallResult:
        """
        Install a plugin from a Git repository.

        Args:
            source: Git source in format:
                - github:user/repo
                - gitlab:user/repo
                - https://github.com/user/repo.git

        Returns:
            InstallResult with status and details
        """
        # Parse the source URL
        git_url = self._parse_git_source(source)
        if not git_url:
            return InstallResult(
                success=False,
                message=f"Invalid git source: {source}",
                errors=[f"Could not parse git source: {source}"],
            )

        # Clone to temp directory
        temp_dir = None
        try:
            temp_dir = tempfile.mkdtemp(prefix="plugin_")
            clone_dir = Path(temp_dir) / "repo"

            # Clone the repository
            logger.info(f"Cloning {git_url} to {clone_dir}")
            result = subprocess.run(
                ["git", "clone", "--depth", "1", git_url, str(clone_dir)],
                capture_output=True,
                text=True,
                timeout=60,
            )

            if result.returncode != 0:
                return InstallResult(
                    success=False,
                    message="Git clone failed",
                    errors=[result.stderr],
                )

            # Get git commit hash
            commit_result = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                cwd=clone_dir,
            )
            git_commit = commit_result.stdout.strip() if commit_result.returncode == 0 else ""

            # Install from the cloned directory
            install_result = self._install_from_directory(clone_dir, source_type="git")

            # Track source
            if install_result.success:
                self._sources[install_result.plugin_id] = PluginSource(
                    source_type="git",
                    source_url=source,
                    installed_version=install_result.version,
                    git_commit=git_commit,
                )
                self._save_sources()

            return install_result

        except subprocess.TimeoutExpired:
            return InstallResult(
                success=False,
                message="Git clone timed out",
                errors=["Clone operation exceeded 60 second timeout"],
            )
        except Exception as e:
            return InstallResult(
                success=False,
                message=f"Installation failed: {str(e)}",
                errors=[str(e)],
            )
        finally:
            # Clean up temp directory
            if temp_dir and os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)

    def install_from_zip(self, zip_path: Path) -> InstallResult:
        """
        Install a plugin from a ZIP file.

        Args:
            zip_path: Path to the ZIP file

        Returns:
            InstallResult with status and details
        """
        if not zip_path.exists():
            return InstallResult(
                success=False,
                message="ZIP file not found",
                errors=[f"File not found: {zip_path}"],
            )

        temp_dir = None
        try:
            temp_dir = tempfile.mkdtemp(prefix="plugin_")
            extract_dir = Path(temp_dir) / "extracted"

            # Extract ZIP
            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(extract_dir)

            # Find the plugin directory (may be nested)
            plugin_dir = self._find_plugin_dir(extract_dir)
            if not plugin_dir:
                return InstallResult(
                    success=False,
                    message="No valid plugin found in ZIP",
                    errors=["ZIP must contain a plugin.yaml manifest"],
                )

            # Install from extracted directory
            install_result = self._install_from_directory(plugin_dir, source_type="zip")

            # Track source
            if install_result.success:
                self._sources[install_result.plugin_id] = PluginSource(
                    source_type="zip",
                    source_url=str(zip_path.name),
                    installed_version=install_result.version,
                )
                self._save_sources()

            return install_result

        except zipfile.BadZipFile:
            return InstallResult(
                success=False,
                message="Invalid ZIP file",
                errors=["The file is not a valid ZIP archive"],
            )
        except Exception as e:
            return InstallResult(
                success=False,
                message=f"Installation failed: {str(e)}",
                errors=[str(e)],
            )
        finally:
            if temp_dir and os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)

    def install_from_zip_bytes(self, zip_data: bytes, filename: str = "plugin.zip") -> InstallResult:
        """
        Install a plugin from ZIP file bytes (for API uploads).

        Args:
            zip_data: ZIP file contents as bytes
            filename: Original filename

        Returns:
            InstallResult with status and details
        """
        temp_dir = None
        try:
            temp_dir = tempfile.mkdtemp(prefix="plugin_")
            zip_path = Path(temp_dir) / filename

            # Write bytes to temp file
            with open(zip_path, "wb") as f:
                f.write(zip_data)

            return self.install_from_zip(zip_path)

        finally:
            if temp_dir and os.path.exists(temp_dir):
                shutil.rmtree(temp_dir)

    def install_from_directory(self, source_dir: Path) -> InstallResult:
        """
        Install a plugin from a local directory.

        Args:
            source_dir: Path to the plugin directory

        Returns:
            InstallResult with status and details
        """
        if not source_dir.exists():
            return InstallResult(
                success=False,
                message="Directory not found",
                errors=[f"Directory not found: {source_dir}"],
            )

        install_result = self._install_from_directory(source_dir, source_type="local")

        # Track source
        if install_result.success:
            self._sources[install_result.plugin_id] = PluginSource(
                source_type="local",
                source_url=str(source_dir),
                installed_version=install_result.version,
            )
            self._save_sources()

        return install_result

    def _install_from_directory(self, source_dir: Path, source_type: str) -> InstallResult:
        """
        Internal method to install from a directory.

        Args:
            source_dir: Directory containing the plugin
            source_type: Type of source (git, zip, local)

        Returns:
            InstallResult with status and details
        """
        # Find and validate manifest
        manifest_path = source_dir / "plugin.yaml"
        if not manifest_path.exists():
            manifest_path = source_dir / "plugin.yml"
        if not manifest_path.exists():
            return InstallResult(
                success=False,
                message="No manifest found",
                errors=["Plugin must contain plugin.yaml or plugin.yml"],
            )

        try:
            with open(manifest_path) as f:
                manifest_data = yaml.safe_load(f)
        except Exception as e:
            return InstallResult(
                success=False,
                message="Invalid manifest",
                errors=[f"Failed to parse manifest: {e}"],
            )

        # Validate required fields
        required_fields = ["name", "version", "plugin_type", "main", "class"]
        missing = [f for f in required_fields if f not in manifest_data]
        if missing:
            return InstallResult(
                success=False,
                message="Invalid manifest",
                errors=[f"Missing required fields: {missing}"],
            )

        # Generate plugin ID from name
        plugin_id = manifest_data["name"].lower().replace(" ", "-")
        plugin_id = "".join(c for c in plugin_id if c.isalnum() or c == "-")

        # Check if already installed
        target_dir = self.installed_dir / plugin_id
        if target_dir.exists():
            # Check version for upgrade
            existing_manifest = target_dir / "plugin.yaml"
            if existing_manifest.exists():
                with open(existing_manifest) as f:
                    existing_data = yaml.safe_load(f)
                    existing_version = existing_data.get("version", "0.0.0")
                    new_version = manifest_data.get("version", "0.0.0")

                    if self._compare_versions(new_version, existing_version) <= 0:
                        return InstallResult(
                            success=False,
                            plugin_id=plugin_id,
                            message="Already installed",
                            errors=[f"Version {new_version} is not newer than installed {existing_version}"],
                        )

            # Remove old version
            shutil.rmtree(target_dir)

        # Copy plugin files
        shutil.copytree(source_dir, target_dir)

        # Validate the main module exists
        main_file = target_dir / manifest_data["main"]
        if not main_file.exists():
            shutil.rmtree(target_dir)
            return InstallResult(
                success=False,
                message="Invalid plugin",
                errors=[f"Main module not found: {manifest_data['main']}"],
            )

        logger.info(f"Installed plugin: {plugin_id} v{manifest_data.get('version', '?')}")

        return InstallResult(
            success=True,
            plugin_id=plugin_id,
            plugin_name=manifest_data["name"],
            version=manifest_data.get("version", "1.0.0"),
            message=f"Successfully installed {manifest_data['name']}",
        )

    def uninstall(self, plugin_id: str) -> InstallResult:
        """
        Uninstall a plugin.

        Args:
            plugin_id: ID of the plugin to uninstall

        Returns:
            InstallResult with status
        """
        target_dir = self.installed_dir / plugin_id
        if not target_dir.exists():
            return InstallResult(
                success=False,
                plugin_id=plugin_id,
                message="Plugin not found",
                errors=[f"Plugin not installed: {plugin_id}"],
            )

        try:
            # Remove directory
            shutil.rmtree(target_dir)

            # Remove from sources
            if plugin_id in self._sources:
                del self._sources[plugin_id]
                self._save_sources()

            logger.info(f"Uninstalled plugin: {plugin_id}")

            return InstallResult(
                success=True,
                plugin_id=plugin_id,
                message=f"Successfully uninstalled {plugin_id}",
            )

        except Exception as e:
            return InstallResult(
                success=False,
                plugin_id=plugin_id,
                message="Uninstall failed",
                errors=[str(e)],
            )

    def check_for_updates(self, plugin_id: str) -> Optional[dict]:
        """
        Check if a plugin has updates available.

        Args:
            plugin_id: ID of the plugin to check

        Returns:
            Dict with update info or None if no update
        """
        source = self._sources.get(plugin_id)
        if not source or source.source_type != "git":
            return None

        # For git sources, check the remote for new commits
        git_url = self._parse_git_source(source.source_url)
        if not git_url:
            return None

        try:
            # Use git ls-remote to check latest commit
            result = subprocess.run(
                ["git", "ls-remote", git_url, "HEAD"],
                capture_output=True,
                text=True,
                timeout=30,
            )

            if result.returncode != 0:
                return None

            remote_commit = result.stdout.split()[0] if result.stdout else ""

            if remote_commit and remote_commit != source.git_commit:
                return {
                    "plugin_id": plugin_id,
                    "current_commit": source.git_commit[:8],
                    "latest_commit": remote_commit[:8],
                    "source_url": source.source_url,
                    "has_update": True,
                }

            return None

        except Exception as e:
            logger.warning(f"Failed to check updates for {plugin_id}: {e}")
            return None

    def update_plugin(self, plugin_id: str) -> InstallResult:
        """
        Update a plugin to the latest version.

        Args:
            plugin_id: ID of the plugin to update

        Returns:
            InstallResult with status
        """
        source = self._sources.get(plugin_id)
        if not source:
            return InstallResult(
                success=False,
                plugin_id=plugin_id,
                message="Source not found",
                errors=["Cannot update: installation source unknown"],
            )

        if source.source_type == "git":
            # Reinstall from git
            return self.install_from_git(source.source_url)
        elif source.source_type == "local":
            # Reinstall from local directory
            return self.install_from_directory(Path(source.source_url))
        else:
            return InstallResult(
                success=False,
                plugin_id=plugin_id,
                message="Cannot update",
                errors=[f"Updates not supported for {source.source_type} installations"],
            )

    def get_installed_plugins(self) -> list[dict]:
        """Get list of installed (non-builtin) plugins with source info."""
        plugins = []

        for plugin_dir in self.installed_dir.iterdir():
            if not plugin_dir.is_dir():
                continue

            manifest_path = plugin_dir / "plugin.yaml"
            if not manifest_path.exists():
                manifest_path = plugin_dir / "plugin.yml"
            if not manifest_path.exists():
                continue

            try:
                with open(manifest_path) as f:
                    manifest = yaml.safe_load(f)

                plugin_id = plugin_dir.name
                source = self._sources.get(plugin_id)

                plugins.append({
                    "plugin_id": plugin_id,
                    "name": manifest.get("name", plugin_id),
                    "version": manifest.get("version", "?"),
                    "description": manifest.get("description", ""),
                    "author": manifest.get("author", "Unknown"),
                    "plugin_type": manifest.get("plugin_type", "unknown"),
                    "source": {
                        "type": source.source_type if source else "unknown",
                        "url": source.source_url if source else "",
                        "installed_at": source.installed_at.isoformat() if source else "",
                    } if source else None,
                })

            except Exception as e:
                logger.warning(f"Failed to read plugin {plugin_dir.name}: {e}")

        return plugins

    def _parse_git_source(self, source: str) -> Optional[str]:
        """Parse a git source string into a clone URL."""
        # Handle shorthand formats
        if source.startswith("github:"):
            repo = source[7:]
            return f"https://github.com/{repo}.git"
        elif source.startswith("gitlab:"):
            repo = source[7:]
            return f"https://gitlab.com/{repo}.git"
        elif source.startswith("http://") or source.startswith("https://"):
            return source
        elif source.startswith("git@"):
            return source
        else:
            # Assume GitHub if just user/repo format
            if "/" in source and not source.startswith("/"):
                return f"https://github.com/{source}.git"

        return None

    def _find_plugin_dir(self, extract_dir: Path) -> Optional[Path]:
        """Find the plugin directory within an extracted archive."""
        # Check if manifest is at root
        if (extract_dir / "plugin.yaml").exists() or (extract_dir / "plugin.yml").exists():
            return extract_dir

        # Check subdirectories (common in GitHub downloads)
        for subdir in extract_dir.iterdir():
            if subdir.is_dir():
                if (subdir / "plugin.yaml").exists() or (subdir / "plugin.yml").exists():
                    return subdir

        return None

    def _compare_versions(self, v1: str, v2: str) -> int:
        """Compare two version strings. Returns: -1 if v1<v2, 0 if equal, 1 if v1>v2."""
        def parse_version(v):
            parts = v.split(".")
            result = []
            for p in parts:
                try:
                    result.append(int(p))
                except ValueError:
                    result.append(0)
            return result

        parts1 = parse_version(v1)
        parts2 = parse_version(v2)

        # Pad to same length
        max_len = max(len(parts1), len(parts2))
        parts1.extend([0] * (max_len - len(parts1)))
        parts2.extend([0] * (max_len - len(parts2)))

        for p1, p2 in zip(parts1, parts2):
            if p1 < p2:
                return -1
            elif p1 > p2:
                return 1

        return 0


# Singleton instance
_installer: Optional[PluginInstaller] = None


def get_plugin_installer() -> PluginInstaller:
    """Get the singleton plugin installer instance."""
    global _installer
    if _installer is None:
        _installer = PluginInstaller()
    return _installer
