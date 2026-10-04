"""Read the profile's ``smart_import`` settings row (design section 8).

Read only: the settings endpoint that writes this row arrives with the data
layer. Used here for server-mode AI consent. A missing or unreadable row means
the defaults, so AI stays off unless the user turned it on.
"""

from __future__ import annotations

import json
from typing import Any

SETTINGS_KEY = "smart_import"

DEFAULTS: dict[str, Any] = {
    "retention_months": 24,
    "ai_enabled": False,
    "pdf_ai_enabled": False,
    "csv_layouts": {},
    "accounts": {},
}

_BOOL_KEYS = ("ai_enabled", "pdf_ai_enabled")


def read_settings(db: Any) -> dict[str, Any]:
    """Return the settings merged over the defaults. Consent flags must be true booleans."""
    settings = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULTS.items()}
    row = db.get_setting(SETTINGS_KEY)
    raw = getattr(row, "value", None) if row is not None else None
    if not raw:
        return settings
    try:
        stored = json.loads(raw)
    except (TypeError, ValueError):
        return settings
    if not isinstance(stored, dict):
        return settings
    for key in DEFAULTS:
        if key in stored:
            settings[key] = stored[key]
    for key in _BOOL_KEYS:
        settings[key] = stored.get(key) is True
    return settings
