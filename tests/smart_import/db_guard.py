"""Make any database open fail loudly (v2 smart import routes must never open one)."""

from __future__ import annotations

from typing import Any

import pytest


def _boom(*args: Any, **kwargs: Any) -> Any:
    raise AssertionError("a v2 smart import route opened the database")


def forbid_database(monkeypatch: pytest.MonkeyPatch) -> None:
    import src.database as database
    import src.database.operations as operations
    import src.database.profile_manager as profile_manager

    monkeypatch.setattr(database, "get_database", _boom)
    monkeypatch.setattr(database, "Database", _boom)
    monkeypatch.setattr(operations, "Database", _boom)
    monkeypatch.setattr(profile_manager, "get_database", _boom)
