"""Tests for the shared src.api.dependencies module."""

from src.api.dependencies import get_db
from src.database import Database, get_database


def test_get_db_returns_database_instance(test_env) -> None:
    db = get_db()
    assert isinstance(db, Database)


def test_get_db_matches_global_singleton(test_env) -> None:
    assert get_db() is get_database()
