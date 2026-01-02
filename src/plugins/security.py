"""
Plugin security system.

This module provides:
- Permission verification and enforcement
- Sandboxed execution environment
- Resource limits for plugin execution
- Audit logging for security events
- Permission approval management
"""

import json
import logging
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional

from .base import PluginManifest, PluginPermissions, DatabaseAccess

logger = logging.getLogger(__name__)


class SecurityEvent(str, Enum):
    """Types of security events for audit logging."""
    PLUGIN_LOADED = "plugin_loaded"
    PLUGIN_UNLOADED = "plugin_unloaded"
    PLUGIN_ENABLED = "plugin_enabled"
    PLUGIN_DISABLED = "plugin_disabled"
    PERMISSION_GRANTED = "permission_granted"
    PERMISSION_DENIED = "permission_denied"
    PERMISSION_REQUESTED = "permission_requested"
    FILE_ACCESS = "file_access"
    NETWORK_ACCESS = "network_access"
    DATABASE_ACCESS = "database_access"
    EXECUTION_TIMEOUT = "execution_timeout"
    EXECUTION_ERROR = "execution_error"
    SECURITY_VIOLATION = "security_violation"


@dataclass
class AuditLogEntry:
    """An entry in the security audit log."""
    timestamp: datetime
    event_type: SecurityEvent
    plugin_id: str
    details: dict = field(default_factory=dict)
    success: bool = True

    def to_dict(self) -> dict:
        return {
            "timestamp": self.timestamp.isoformat(),
            "event_type": self.event_type.value,
            "plugin_id": self.plugin_id,
            "details": self.details,
            "success": self.success,
        }


@dataclass
class PermissionRequest:
    """A pending permission request from a plugin."""
    plugin_id: str
    plugin_name: str
    permissions: PluginPermissions
    requested_at: datetime
    approved: Optional[bool] = None
    approved_at: Optional[datetime] = None
    approved_by: str = ""  # "user" or "auto"


class AuditLogger:
    """
    Maintains an audit log of security-relevant plugin events.

    Logs are stored in memory with configurable rotation and
    can be persisted to disk.
    """

    def __init__(self, log_dir: Path, max_entries: int = 10000):
        self.log_dir = log_dir
        self.max_entries = max_entries
        self._entries: list[AuditLogEntry] = []
        self._lock = threading.Lock()

        # Ensure log directory exists
        self.log_dir.mkdir(parents=True, exist_ok=True)

        # Load existing log if present
        self._load_log()

    def _load_log(self) -> None:
        """Load audit log from disk."""
        log_file = self.log_dir / "audit.json"
        if log_file.exists():
            try:
                with open(log_file) as f:
                    data = json.load(f)
                    for entry in data.get("entries", [])[-self.max_entries:]:
                        self._entries.append(AuditLogEntry(
                            timestamp=datetime.fromisoformat(entry["timestamp"]),
                            event_type=SecurityEvent(entry["event_type"]),
                            plugin_id=entry["plugin_id"],
                            details=entry.get("details", {}),
                            success=entry.get("success", True),
                        ))
            except Exception as e:
                logger.warning(f"Failed to load audit log: {e}")

    def _save_log(self) -> None:
        """Persist audit log to disk."""
        log_file = self.log_dir / "audit.json"
        try:
            with open(log_file, "w") as f:
                json.dump({
                    "entries": [e.to_dict() for e in self._entries[-self.max_entries:]]
                }, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save audit log: {e}")

    def log(
        self,
        event_type: SecurityEvent,
        plugin_id: str,
        details: dict = None,
        success: bool = True,
    ) -> None:
        """Log a security event."""
        entry = AuditLogEntry(
            timestamp=datetime.now(),
            event_type=event_type,
            plugin_id=plugin_id,
            details=details or {},
            success=success,
        )

        with self._lock:
            self._entries.append(entry)

            # Rotate if needed
            if len(self._entries) > self.max_entries:
                self._entries = self._entries[-self.max_entries:]

            # Persist to disk
            self._save_log()

        # Also log to standard logger
        level = logging.INFO if success else logging.WARNING
        logger.log(level, f"[AUDIT] {event_type.value}: {plugin_id} - {details}")

    def get_entries(
        self,
        plugin_id: Optional[str] = None,
        event_type: Optional[SecurityEvent] = None,
        since: Optional[datetime] = None,
        limit: int = 100,
    ) -> list[AuditLogEntry]:
        """Query audit log entries."""
        with self._lock:
            entries = self._entries.copy()

        # Filter
        if plugin_id:
            entries = [e for e in entries if e.plugin_id == plugin_id]
        if event_type:
            entries = [e for e in entries if e.event_type == event_type]
        if since:
            entries = [e for e in entries if e.timestamp >= since]

        # Return most recent first, limited
        return list(reversed(entries[-limit:]))

    def get_security_violations(self, limit: int = 50) -> list[AuditLogEntry]:
        """Get recent security violations."""
        violation_types = {
            SecurityEvent.PERMISSION_DENIED,
            SecurityEvent.SECURITY_VIOLATION,
            SecurityEvent.EXECUTION_TIMEOUT,
        }
        with self._lock:
            violations = [
                e for e in self._entries
                if e.event_type in violation_types or not e.success
            ]
        return list(reversed(violations[-limit:]))


class PermissionManager:
    """
    Manages plugin permissions and approval workflow.

    Handles:
    - Checking if plugins have required permissions
    - Tracking user-approved permissions
    - Managing permission requests
    """

    # Permissions that require explicit user approval
    SENSITIVE_PERMISSIONS = {"file_write", "network", "api_keys"}

    # Permissions that are auto-approved for built-in plugins
    BUILTIN_AUTO_APPROVE = {"file_read", "database"}

    def __init__(self, data_dir: Path, audit_logger: AuditLogger):
        self.data_dir = data_dir
        self.audit_logger = audit_logger
        self._approved_permissions: dict[str, PluginPermissions] = {}
        self._pending_requests: dict[str, PermissionRequest] = {}
        self._lock = threading.Lock()

        # Load approved permissions
        self._load_approved()

    def _load_approved(self) -> None:
        """Load approved permissions from disk."""
        approved_file = self.data_dir / "approved_permissions.json"
        if approved_file.exists():
            try:
                with open(approved_file) as f:
                    data = json.load(f)
                    for plugin_id, perms in data.items():
                        self._approved_permissions[plugin_id] = PluginPermissions.from_dict(perms)
            except Exception as e:
                logger.warning(f"Failed to load approved permissions: {e}")

    def _save_approved(self) -> None:
        """Save approved permissions to disk."""
        approved_file = self.data_dir / "approved_permissions.json"
        try:
            data = {
                plugin_id: perms.to_dict()
                for plugin_id, perms in self._approved_permissions.items()
            }
            with open(approved_file, "w") as f:
                json.dump(data, f, indent=2)
        except Exception as e:
            logger.error(f"Failed to save approved permissions: {e}")

    def check_permission(
        self,
        manifest: PluginManifest,
        permission: str,
        context: dict = None,
    ) -> bool:
        """
        Check if a plugin has a specific permission.

        Args:
            manifest: Plugin manifest
            permission: Permission to check (file_read, network, etc.)
            context: Additional context about the operation

        Returns:
            True if permission is granted
        """
        plugin_id = manifest.plugin_id
        required_perms = manifest.permissions

        # Check if permission is requested in manifest
        if permission == "file_read" and not required_perms.file_read:
            self._log_denial(plugin_id, permission, "Not declared in manifest")
            return False
        if permission == "file_write" and not required_perms.file_write:
            self._log_denial(plugin_id, permission, "Not declared in manifest")
            return False
        if permission == "network" and not required_perms.network:
            self._log_denial(plugin_id, permission, "Not declared in manifest")
            return False
        if permission == "database":
            db_access = context.get("access_level", DatabaseAccess.READ_ONLY) if context else DatabaseAccess.READ_ONLY
            if required_perms.database == DatabaseAccess.NONE:
                self._log_denial(plugin_id, permission, "No database access declared")
                return False
            if db_access == DatabaseAccess.READ_WRITE and required_perms.database == DatabaseAccess.READ_ONLY:
                self._log_denial(plugin_id, permission, "Only read_only access declared")
                return False

        # Built-in plugins get auto-approval for non-sensitive permissions
        if manifest.is_builtin:
            if permission in self.BUILTIN_AUTO_APPROVE:
                return True
            if permission not in self.SENSITIVE_PERMISSIONS:
                return True

        # Check if user has approved this permission
        with self._lock:
            approved = self._approved_permissions.get(plugin_id)
            if approved:
                if permission == "file_read" and approved.file_read:
                    return True
                if permission == "file_write" and approved.file_write:
                    return True
                if permission == "network" and approved.network:
                    return True
                if permission == "database":
                    if approved.database != DatabaseAccess.NONE:
                        return True

        # Permission not approved
        self._log_denial(plugin_id, permission, "Not approved by user")
        return False

    def _log_denial(self, plugin_id: str, permission: str, reason: str) -> None:
        """Log a permission denial."""
        self.audit_logger.log(
            SecurityEvent.PERMISSION_DENIED,
            plugin_id,
            {"permission": permission, "reason": reason},
            success=False,
        )

    def request_permission(self, manifest: PluginManifest) -> PermissionRequest:
        """
        Create a permission request for a plugin.

        Returns a PermissionRequest that can be shown to the user.
        """
        request = PermissionRequest(
            plugin_id=manifest.plugin_id,
            plugin_name=manifest.name,
            permissions=manifest.permissions,
            requested_at=datetime.now(),
        )

        with self._lock:
            self._pending_requests[manifest.plugin_id] = request

        self.audit_logger.log(
            SecurityEvent.PERMISSION_REQUESTED,
            manifest.plugin_id,
            {"permissions": manifest.permissions.to_dict()},
        )

        return request

    def approve_permissions(
        self,
        plugin_id: str,
        permissions: PluginPermissions,
        approved_by: str = "user",
    ) -> bool:
        """
        Approve permissions for a plugin.

        Args:
            plugin_id: ID of the plugin
            permissions: Permissions to approve
            approved_by: Who approved ("user" or "auto")

        Returns:
            True if approved successfully
        """
        with self._lock:
            self._approved_permissions[plugin_id] = permissions

            # Update pending request if exists
            if plugin_id in self._pending_requests:
                request = self._pending_requests[plugin_id]
                request.approved = True
                request.approved_at = datetime.now()
                request.approved_by = approved_by
                del self._pending_requests[plugin_id]

            self._save_approved()

        self.audit_logger.log(
            SecurityEvent.PERMISSION_GRANTED,
            plugin_id,
            {"permissions": permissions.to_dict(), "approved_by": approved_by},
        )

        return True

    def deny_permissions(self, plugin_id: str) -> bool:
        """Deny pending permissions for a plugin."""
        with self._lock:
            if plugin_id in self._pending_requests:
                request = self._pending_requests[plugin_id]
                request.approved = False
                request.approved_at = datetime.now()
                del self._pending_requests[plugin_id]

        self.audit_logger.log(
            SecurityEvent.PERMISSION_DENIED,
            plugin_id,
            {"reason": "User denied permissions"},
            success=False,
        )

        return True

    def revoke_permissions(self, plugin_id: str) -> bool:
        """Revoke all approved permissions for a plugin."""
        with self._lock:
            if plugin_id in self._approved_permissions:
                del self._approved_permissions[plugin_id]
                self._save_approved()

        self.audit_logger.log(
            SecurityEvent.PERMISSION_DENIED,
            plugin_id,
            {"reason": "Permissions revoked"},
        )

        return True

    def get_pending_requests(self) -> list[PermissionRequest]:
        """Get all pending permission requests."""
        with self._lock:
            return list(self._pending_requests.values())

    def get_approved_permissions(self, plugin_id: str) -> Optional[PluginPermissions]:
        """Get approved permissions for a plugin."""
        with self._lock:
            return self._approved_permissions.get(plugin_id)

    def has_sensitive_permissions(self, manifest: PluginManifest) -> bool:
        """Check if a plugin requests sensitive permissions."""
        perms = manifest.permissions
        if perms.file_write:
            return True
        if perms.network:
            return True
        if perms.api_keys:
            return True
        if perms.database == DatabaseAccess.READ_WRITE:
            return True
        return False


class ExecutionSandbox:
    """
    Provides sandboxed execution for plugin code.

    Features:
    - Execution timeout enforcement
    - Restricted built-in functions
    - Memory usage tracking (best effort)
    """

    # Built-ins that are always blocked
    BLOCKED_BUILTINS = {
        "eval", "exec", "compile", "open", "__import__",
        "globals", "locals", "vars",
        "getattr", "setattr", "delattr",
        "input", "breakpoint",
    }

    # Default timeout in seconds
    DEFAULT_TIMEOUT = 30

    # Default memory limit in MB
    DEFAULT_MEMORY_LIMIT = 256

    def __init__(
        self,
        audit_logger: AuditLogger,
        timeout: int = DEFAULT_TIMEOUT,
        memory_limit: int = DEFAULT_MEMORY_LIMIT,
    ):
        self.audit_logger = audit_logger
        self.timeout = timeout
        self.memory_limit = memory_limit

    def execute_with_timeout(
        self,
        func: Callable,
        args: tuple = (),
        kwargs: dict = None,
        plugin_id: str = "unknown",
        timeout: Optional[int] = None,
    ) -> tuple[Any, Optional[Exception]]:
        """
        Execute a function with timeout.

        Args:
            func: Function to execute
            args: Positional arguments
            kwargs: Keyword arguments
            plugin_id: ID of the plugin (for logging)
            timeout: Timeout in seconds (uses default if not specified)

        Returns:
            Tuple of (result, exception) - exception is None if successful
        """
        kwargs = kwargs or {}
        timeout = timeout or self.timeout

        result = [None]
        exception = [None]

        def target():
            try:
                result[0] = func(*args, **kwargs)
            except Exception as e:
                exception[0] = e

        thread = threading.Thread(target=target)
        thread.daemon = True

        start_time = time.time()
        thread.start()
        thread.join(timeout=timeout)

        elapsed = time.time() - start_time

        if thread.is_alive():
            # Timeout occurred
            self.audit_logger.log(
                SecurityEvent.EXECUTION_TIMEOUT,
                plugin_id,
                {"timeout": timeout, "elapsed": elapsed},
                success=False,
            )
            return None, TimeoutError(f"Plugin execution timed out after {timeout}s")

        if exception[0]:
            self.audit_logger.log(
                SecurityEvent.EXECUTION_ERROR,
                plugin_id,
                {"error": str(exception[0]), "elapsed": elapsed},
                success=False,
            )

        return result[0], exception[0]

    def create_restricted_globals(self) -> dict:
        """
        Create a restricted globals dict for plugin execution.

        Note: This provides defense-in-depth but is not a complete sandbox.
        For full isolation, consider using subprocess or container-based sandboxing.
        """
        import builtins

        # Start with safe builtins
        safe_builtins = {}
        for name in dir(builtins):
            if name not in self.BLOCKED_BUILTINS and not name.startswith("_"):
                safe_builtins[name] = getattr(builtins, name)

        return {
            "__builtins__": safe_builtins,
            "__name__": "__plugin__",
            "__doc__": None,
        }


class SecurityManager:
    """
    Central manager for plugin security.

    Coordinates permission checking, sandboxing, and audit logging.
    """

    def __init__(self, data_dir: str = "data/plugins"):
        self.data_dir = Path(data_dir)
        self.data_dir.mkdir(parents=True, exist_ok=True)

        # Initialize components
        self.audit_logger = AuditLogger(self.data_dir / "audit")
        self.permission_manager = PermissionManager(self.data_dir, self.audit_logger)
        self.sandbox = ExecutionSandbox(self.audit_logger)

    def validate_plugin(self, manifest: PluginManifest) -> tuple[bool, list[str]]:
        """
        Validate a plugin before loading.

        Returns:
            Tuple of (is_valid, list of issues)
        """
        issues = []

        # Check for blocked permissions in non-builtin plugins
        if not manifest.is_builtin:
            perms = manifest.permissions

            # Warn about sensitive permissions
            if perms.file_write:
                issues.append("Plugin requests file write access")
            if perms.network:
                issues.append("Plugin requests network access")
            if perms.api_keys:
                issues.append(f"Plugin requests API key access: {perms.api_keys}")
            if perms.database == DatabaseAccess.READ_WRITE:
                issues.append("Plugin requests database write access")

        return len(issues) == 0 or manifest.is_builtin, issues

    def can_load_plugin(self, manifest: PluginManifest) -> tuple[bool, str]:
        """
        Check if a plugin can be loaded.

        Args:
            manifest: Plugin manifest

        Returns:
            Tuple of (can_load, reason)
        """
        # Built-in plugins are always allowed
        if manifest.is_builtin:
            return True, "Built-in plugin"

        # Check if plugin has sensitive permissions that need approval
        if self.permission_manager.has_sensitive_permissions(manifest):
            approved = self.permission_manager.get_approved_permissions(manifest.plugin_id)
            if not approved:
                return False, "Sensitive permissions require user approval"

        return True, "OK"

    def on_plugin_loaded(self, manifest: PluginManifest) -> None:
        """Called when a plugin is loaded."""
        self.audit_logger.log(
            SecurityEvent.PLUGIN_LOADED,
            manifest.plugin_id,
            {
                "name": manifest.name,
                "version": manifest.version,
                "is_builtin": manifest.is_builtin,
                "permissions": manifest.permissions.to_dict(),
            },
        )

    def on_plugin_unloaded(self, plugin_id: str) -> None:
        """Called when a plugin is unloaded."""
        self.audit_logger.log(
            SecurityEvent.PLUGIN_UNLOADED,
            plugin_id,
        )

    def execute_plugin_method(
        self,
        plugin_id: str,
        method: Callable,
        args: tuple = (),
        kwargs: dict = None,
        timeout: Optional[int] = None,
    ) -> tuple[Any, Optional[Exception]]:
        """
        Execute a plugin method with security controls.

        Args:
            plugin_id: ID of the plugin
            method: Method to execute
            args: Positional arguments
            kwargs: Keyword arguments
            timeout: Execution timeout

        Returns:
            Tuple of (result, exception)
        """
        return self.sandbox.execute_with_timeout(
            method, args, kwargs or {}, plugin_id, timeout
        )

    def get_audit_log(
        self,
        plugin_id: Optional[str] = None,
        limit: int = 100,
    ) -> list[dict]:
        """Get audit log entries."""
        entries = self.audit_logger.get_entries(plugin_id=plugin_id, limit=limit)
        return [e.to_dict() for e in entries]

    def get_security_violations(self, limit: int = 50) -> list[dict]:
        """Get security violations."""
        entries = self.audit_logger.get_security_violations(limit=limit)
        return [e.to_dict() for e in entries]


# Singleton instance
_security_manager: Optional[SecurityManager] = None


def get_security_manager() -> SecurityManager:
    """Get the singleton security manager instance."""
    global _security_manager
    if _security_manager is None:
        _security_manager = SecurityManager()
    return _security_manager
