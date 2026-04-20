"""Path-handling utilities with traversal protection."""

from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath


class UnsafePathError(ValueError):
    """Raised when a user-supplied filename would escape its base directory."""


def safe_join(base: Path, user_filename: str) -> Path:
    """Resolve ``base / user_filename`` and verify it stays within ``base``.

    Protects against:
    - ``../`` traversal (POSIX and Windows-style)
    - Absolute paths supplied by the user (``/etc/passwd``, ``C:\\...``)
    - Null-byte injection
    - Symlink escapes (via ``Path.resolve``)

    Args:
        base: The directory user-supplied files must stay inside.
        user_filename: Untrusted filename from a request.

    Returns:
        Absolute ``Path`` guaranteed to be a descendant of ``base``.

    Raises:
        UnsafePathError: If ``user_filename`` would escape ``base``.
    """
    if not user_filename:
        raise UnsafePathError("Empty filename")

    if "\x00" in user_filename:
        raise UnsafePathError("Null byte in filename")

    if PurePosixPath(user_filename).is_absolute() or PureWindowsPath(
        user_filename
    ).is_absolute():
        raise UnsafePathError(f"Absolute paths not allowed: {user_filename!r}")

    base_resolved = base.resolve()
    candidate = (base_resolved / user_filename).resolve()

    try:
        candidate.relative_to(base_resolved)
    except ValueError as exc:
        raise UnsafePathError(
            f"Path escapes base directory: {user_filename!r}"
        ) from exc

    return candidate
