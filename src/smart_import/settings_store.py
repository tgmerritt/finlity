"""The profile's ``smart_import`` settings row (design section 8).

One fixed row in ``app_settings`` under ``SETTINGS_KEY``. Reads sanitize every
field, so a hand-edited or corrupt row falls back to the defaults. Writes go
through ``SettingsUpdate`` only: the five known fields with validated values,
never an arbitrary key. Used for the settings endpoints and for server-mode AI
consent. Never log setting values (account labels are user text).
"""

from __future__ import annotations

import json
import logging
import re
from typing import Annotated, Any, Optional

from pydantic import BaseModel, ConfigDict, Field, StrictBool, StrictInt, field_validator

from .parsers.csv_parser import _MAPPABLE as MAPPABLE_FIELDS

logger = logging.getLogger(__name__)

SETTINGS_KEY = "smart_import"
RETENTION_CHOICES = (0, 12, 24, 36)  # months; 0 keeps everything
MAX_CSV_LAYOUTS = 50
MAX_ACCOUNT_LABELS = 200
MAX_HEADER_NAME_CHARS = 200
MAX_ACCOUNT_LABEL_CHARS = 120

DEFAULTS: dict[str, Any] = {
    "retention_months": 24,
    "ai_enabled": False,
    "pdf_ai_enabled": False,
    "csv_layouts": {},
    "accounts": {},
}

_BOOL_KEYS = ("ai_enabled", "pdf_ai_enabled")
_LAYOUT_SIGNATURE = re.compile(r"[0-9a-f]{64}")
_ACCOUNT_KEY = re.compile(r"(acct|label):[^\x00-\x1f\x7f]{1,190}")

HeaderName = Annotated[str, Field(min_length=1, max_length=MAX_HEADER_NAME_CHARS)]
CsvMapping = dict[str, HeaderName]
AccountLabel = Annotated[str, Field(min_length=1, max_length=MAX_ACCOUNT_LABEL_CHARS)]


def _valid_mapping(mapping: Any) -> bool:
    return (
        isinstance(mapping, dict)
        and 0 < len(mapping) <= len(MAPPABLE_FIELDS)
        and all(
            k in MAPPABLE_FIELDS
            and isinstance(v, str)
            and 0 < len(v) <= MAX_HEADER_NAME_CHARS
            for k, v in mapping.items()
        )
    )


def _clean_layouts(raw: Any) -> dict[str, dict[str, str]]:
    if not isinstance(raw, dict):
        return {}
    clean = {
        sig: dict(mapping)
        for sig, mapping in raw.items()
        if isinstance(sig, str) and _LAYOUT_SIGNATURE.fullmatch(sig) and _valid_mapping(mapping)
    }
    return dict(list(clean.items())[:MAX_CSV_LAYOUTS])


def _clean_accounts(raw: Any) -> dict[str, str]:
    if not isinstance(raw, dict):
        return {}
    clean = {
        key: label
        for key, label in raw.items()
        if isinstance(key, str)
        and _ACCOUNT_KEY.fullmatch(key)
        and isinstance(label, str)
        and 0 < len(label) <= MAX_ACCOUNT_LABEL_CHARS
    }
    return dict(list(clean.items())[:MAX_ACCOUNT_LABELS])


def sanitize(stored: Any) -> dict[str, Any]:
    """The five known settings from a stored value, defaults for anything invalid."""
    settings = {k: (dict(v) if isinstance(v, dict) else v) for k, v in DEFAULTS.items()}
    if not isinstance(stored, dict):
        return settings
    months = stored.get("retention_months")
    if isinstance(months, int) and not isinstance(months, bool) and months in RETENTION_CHOICES:
        settings["retention_months"] = months
    for key in _BOOL_KEYS:
        settings[key] = stored.get(key) is True
    settings["csv_layouts"] = _clean_layouts(stored.get("csv_layouts"))
    settings["accounts"] = _clean_accounts(stored.get("accounts"))
    return settings


def read_settings(db: Any) -> dict[str, Any]:
    """Return the settings merged over the defaults. Consent flags must be true booleans."""
    row = db.get_setting(SETTINGS_KEY)
    raw = getattr(row, "value", None) if row is not None else None
    if not raw:
        return sanitize(None)
    try:
        stored = json.loads(raw)
    except (TypeError, ValueError):
        return sanitize(None)
    return sanitize(stored)


class SettingsUpdate(BaseModel):
    """A partial settings write: only these fields, each validated, none nullable.

    A field that is present replaces that setting (``csv_layouts`` and
    ``accounts`` are replaced as whole maps); an absent field keeps its value.
    """

    model_config = ConfigDict(extra="forbid")

    retention_months: Optional[StrictInt] = None
    ai_enabled: Optional[StrictBool] = None
    pdf_ai_enabled: Optional[StrictBool] = None
    csv_layouts: Optional[
        Annotated[dict[str, CsvMapping], Field(max_length=MAX_CSV_LAYOUTS)]
    ] = None
    accounts: Optional[
        Annotated[dict[str, AccountLabel], Field(max_length=MAX_ACCOUNT_LABELS)]
    ] = None

    @field_validator("retention_months")
    @classmethod
    def _retention_choice(cls, value: Optional[int]) -> Optional[int]:
        if value is not None and value not in RETENTION_CHOICES:
            raise ValueError("retention_months must be 0, 12, 24 or 36")
        return value

    @field_validator("csv_layouts")
    @classmethod
    def _layouts(
        cls, value: Optional[dict[str, dict[str, str]]]
    ) -> Optional[dict[str, dict[str, str]]]:
        for sig, mapping in (value or {}).items():
            if not _LAYOUT_SIGNATURE.fullmatch(sig) or not _valid_mapping(mapping):
                raise ValueError("invalid csv layout")
        return value

    @field_validator("accounts")
    @classmethod
    def _account_keys(cls, value: Optional[dict[str, str]]) -> Optional[dict[str, str]]:
        for key in value or {}:
            if not _ACCOUNT_KEY.fullmatch(key):
                raise ValueError("invalid account key")
        return value

    @field_validator("retention_months", "ai_enabled", "pdf_ai_enabled", "csv_layouts", "accounts", mode="before")
    @classmethod
    def _not_null(cls, value: Any) -> Any:
        if value is None:
            raise ValueError("null is not allowed")
        return value


def write_settings(db: Any, update: SettingsUpdate) -> dict[str, Any]:
    """Merge ``update`` over the stored settings and save the fixed row. Returns the result."""
    settings = read_settings(db)
    changes = update.model_dump(exclude_unset=True)
    if not changes:
        return settings  # an empty PUT writes nothing, not even the default row
    settings.update(changes)
    db.set_setting(SETTINGS_KEY, json.dumps(settings, sort_keys=True))
    return settings
