"""Environment switches shared by the smart import routes. Nothing here logs."""

from __future__ import annotations

import os

TRUE_VALUES = frozenset({"1", "true", "yes"})


def env_flag(name: str) -> bool:
    """True when the variable is set to 1, true or yes (any case, trimmed)."""
    return os.environ.get(name, "").strip().lower() in TRUE_VALUES


def on_heroku() -> bool:
    """Heroku sets DYNO on every dyno; it marks a public, shared deployment."""
    return bool(os.environ.get("DYNO"))
