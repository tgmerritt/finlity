"""Shared FastAPI dependencies.

Centralises the profile-aware database lookup so every router does not
re-import and re-define ``get_db`` locally. Routers should::

    from fastapi import Depends
    from src.api.dependencies import get_db

    @router.get(...)
    def endpoint(db: Database = Depends(get_db)):
        ...
"""

from __future__ import annotations

from src.database import Database, get_database


def get_db() -> Database:
    """Return the active, profile-aware ``Database`` instance."""
    return get_database()


__all__ = ["get_db"]
