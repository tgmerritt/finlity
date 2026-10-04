"""Deployment switches for the connector core. Read at call time; nothing logs."""

from __future__ import annotations

from ..smart_import.env import env_flag, on_heroku

__all__ = ["connectors_enabled_flag", "env_flag", "on_heroku", "shared_deployment"]


def shared_deployment() -> bool:
    """True on a shared deployment.

    Mirrors ``src.services.session.is_multi_user_mode`` (MULTI_USER_MODE, DYNO,
    PROTECT_DEMO_DATA) without importing ``src.services``, whose package import
    pulls in stateful services the stateless core must not load.
    """
    return env_flag("MULTI_USER_MODE") or on_heroku() or env_flag("PROTECT_DEMO_DATA")


def connectors_enabled_flag() -> bool:
    """The operator's opt-in for real providers on Heroku (design C8)."""
    return env_flag("CONNECTORS_ENABLED")
