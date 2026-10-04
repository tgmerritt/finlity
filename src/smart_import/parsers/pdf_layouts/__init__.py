"""Registered PDF layout parsers, tried in order (design 4.4)."""

from __future__ import annotations

from . import generic_lines, usaa_checking

LAYOUTS = (usaa_checking, generic_lines)

__all__ = ["LAYOUTS", "generic_lines", "usaa_checking"]
