"""Stateless statement analysis: sniff the type, call the parser, apply rules.

Pure function of its inputs: no database, no files, no logging of content.
Every failure leaves as a ``SmartImportError`` with a fixed message.
"""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from typing import Any

from .errors import SmartImportError
from .limits import sniff_type
from .parsers.csv_parser import parse_csv
from .parsers.ofx_parser import parse_ofx
from .parsers.pdf_parser import NeedsAiLayout, parse_pdf


def _check_context(context: Mapping[str, Any] | None) -> dict[str, Any]:
    if context is None:
        return {}
    if not isinstance(context, Mapping):
        raise SmartImportError("bad_context")
    ctx = dict(context)
    categories = ctx.get("categories")
    if categories is not None:
        if not isinstance(categories, list) or not all(
            isinstance(c, Mapping) and "id" in c and "name" in c for c in categories
        ):
            raise SmartImportError("bad_context")
    rules = ctx.get("rules")
    if rules is not None and not isinstance(rules, (list, dict)):
        raise SmartImportError("bad_context")
    return ctx


def analyze_file(
    content: bytes, file_name: str, context: Mapping[str, Any] | None
) -> dict[str, Any]:
    """Analyze one uploaded statement.

    Returns ``{"status": "ok", "statements": [...]}``,
    ``{"status": "needs_mapping", "headers": [...], "sample_rows": [...]}`` or
    ``{"status": "needs_ai_layout", "file_hash", "line_count", "lines"}``.
    """
    ctx = _check_context(context)
    kind = sniff_type(file_name, content[:4096])
    try:
        if kind == "csv":
            csv_result = parse_csv(content, file_name, ctx)
            if csv_result.get("status") == "needs_mapping":
                return dict(csv_result)
            statements: list[Any] = [csv_result]
        elif kind == "ofx":
            statements = list(parse_ofx(content, file_name, ctx))
        else:
            pdf_result = parse_pdf(content, file_name, ctx)
            if isinstance(pdf_result, NeedsAiLayout):
                return {
                    "status": "needs_ai_layout",
                    "file_hash": pdf_result.file_hash
                    or hashlib.sha256(content).hexdigest(),
                    "line_count": pdf_result.line_count,
                    "lines": list(pdf_result.lines),
                }
            # Every parser finalizes its statements (rules, file name,
            # origin) through normalize.finalize_statement.
            statements = [pdf_result]
    except SmartImportError:
        raise
    except Exception:
        # The original exception may quote file content; callers get the
        # catalog message only.
        raise SmartImportError("unreadable") from None
    return {"status": "ok", "statements": statements}
