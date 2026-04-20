"""Tests for safe_join path-traversal protection."""

from pathlib import Path

import pytest

from src.utils.paths import UnsafePathError, safe_join


def test_safe_join_accepts_plain_filename(tmp_path: Path) -> None:
    result = safe_join(tmp_path, "report.csv")
    assert result == tmp_path / "report.csv"


def test_safe_join_rejects_parent_traversal(tmp_path: Path) -> None:
    with pytest.raises(UnsafePathError):
        safe_join(tmp_path, "../../etc/passwd")


def test_safe_join_rejects_absolute_path(tmp_path: Path) -> None:
    with pytest.raises(UnsafePathError):
        safe_join(tmp_path, "/etc/passwd")


def test_safe_join_rejects_null_byte(tmp_path: Path) -> None:
    with pytest.raises(UnsafePathError):
        safe_join(tmp_path, "benign.csv\x00../../evil")


def test_safe_join_allows_backslashes_on_posix(tmp_path: Path) -> None:
    # Backslashes are literal filename chars on POSIX; so long as the result
    # stays inside base, it is safe. safe_join must not falsely reject.
    result = safe_join(tmp_path, "weird\\name.csv")
    assert result.is_relative_to(tmp_path.resolve())


def test_safe_join_rejects_windows_absolute_path(tmp_path: Path) -> None:
    with pytest.raises(UnsafePathError):
        safe_join(tmp_path, "C:\\Windows\\system32\\cmd.exe")


def test_safe_join_rejects_symlink_escape(tmp_path: Path) -> None:
    outside = tmp_path.parent / "outside"
    outside.mkdir(exist_ok=True)
    link = tmp_path / "escape"
    link.symlink_to(outside)
    with pytest.raises(UnsafePathError):
        safe_join(tmp_path, "escape/secret.txt")
