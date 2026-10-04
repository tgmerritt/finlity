"""PDF statement parser (design 4.4).

Text extraction only: nothing is rendered, and JavaScript, forms, attachments
and XFA are never read. Limits come from limits.py and are enforced page by
page. Errors carry fixed messages; nothing here logs or echoes content.
"""

from __future__ import annotations

import hashlib
import math
import os
import pathlib
import re
import subprocess
import sys
import threading
from dataclasses import dataclass, field
from typing import Any

from .. import limits
from ..errors import SmartImportError
from ..normalize import finalize_statement, mask_description
from ..types import NormalizedStatement
from .pdf_layouts import LAYOUTS
from .pdf_layouts._common import (
    DATE_TOKEN,
    MAX_LINE_CHARS,
    TRAILING_MONEY_RE,
    clean_lines,
)

_DATE_START_RE = re.compile(rf"^{DATE_TOKEN}\s")


@dataclass(frozen=True)
class NeedsAiLayout:
    """No layout parser could read the statement (design 4.4 step 4, 6.3).

    ``lines`` are candidate transaction lines (a date and a money token, plus
    the following line), already masked, at most 400. ``line_count`` is
    ``len(lines)``.
    """

    lines: list[str] = field(default_factory=list)
    line_count: int = 0
    file_hash: str = ""


_WORKER = pathlib.Path(__file__).with_name("pdf_worker.py")
# Bounds the extraction children per process (each may use up to
# PDF_CHILD_MAX_ADDRESS_BYTES and a CPU for PDF_WALL_CLOCK_SECONDS).
_PDF_SLOTS = threading.BoundedSemaphore(limits.MAX_CONCURRENT_PDF_READS)
# Error types the child may report; anything else is treated as unreadable.
_CHILD_ERRORS = frozenset(
    {"encrypted_pdf", "too_many_pages", "pdf_text_too_large", "unreadable"}
)
# Environment passed to the child: enough to start Python, no secrets.
_CHILD_ENV_KEYS = ("PATH", "SYSTEMROOT", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH")


def extract_text(content: bytes) -> str:
    """Extract text in a child process under page, size, memory and time limits.

    The child (pdf_worker.py, run with ``python -I``) receives only the bytes
    on stdin and the limits on its command line, and returns only the text or
    an error type. A content stream budget is checked before extraction, and
    the child is killed when the wall clock runs out, so one hostile page can
    neither spin a server worker nor grow its memory. At most
    ``MAX_CONCURRENT_PDF_READS`` children run at once; past that the call
    fails fast with ``busy``. Limits are read from
    ``limits`` at call time so tests can lower them.
    """
    timeout = float(limits.PDF_WALL_CLOCK_SECONDS)
    args = [
        sys.executable,
        "-I",
        str(_WORKER),
        str(int(limits.MAX_PDF_PAGES)),
        str(int(limits.MAX_PDF_TEXT_CHARS)),
        str(int(limits.MAX_PDF_PAGE_CONTENT_BYTES)),
        str(int(limits.MAX_PDF_TOTAL_CONTENT_BYTES)),
        str(int(limits.MAX_PDF_PAGE_TEXT_OPS)),
        str(int(limits.PDF_CHILD_MAX_ADDRESS_BYTES)),
        str(max(1, math.ceil(timeout)) + 1),
    ]
    env = {k: os.environ[k] for k in _CHILD_ENV_KEYS if k in os.environ}
    if not _PDF_SLOTS.acquire(blocking=False):
        raise SmartImportError("busy")
    try:
        # Fixed argument list, no shell; the input is only the PDF bytes.
        done = subprocess.run(
            args,
            input=content,
            capture_output=True,
            timeout=timeout,
            env=env,
            check=False,
        )
    except subprocess.TimeoutExpired:
        raise SmartImportError("parse_timeout") from None
    except OSError:
        raise SmartImportError("unreadable") from None
    finally:
        _PDF_SLOTS.release()
    out = done.stdout
    if out.startswith(b"OK\n"):
        text = out[3:].decode("utf-8", "replace")
        if len(text) > limits.MAX_PDF_TEXT_CHARS:
            raise SmartImportError("pdf_text_too_large")
        return text
    if out.startswith(b"ERR "):
        error_type = out[4:].strip().decode("ascii", "replace")
        if error_type in _CHILD_ERRORS:
            raise SmartImportError(error_type)
    if done.returncode < 0:
        # Killed by the CPU or memory limit.
        raise SmartImportError("pdf_text_too_large")
    raise SmartImportError("unreadable")


def _candidate_lines(text: str) -> list[str]:
    lines = clean_lines(text)
    picked: list[str] = []
    seen: set[int] = set()
    for i, line in enumerate(lines):
        if _DATE_START_RE.match(line) and TRAILING_MONEY_RE.search(
            line[:MAX_LINE_CHARS]
        ):
            for k in (i, i + 1):
                if k < len(lines) and lines[k] and k not in seen:
                    seen.add(k)
                    picked.append(mask_description(lines[k]))
        if len(picked) >= limits.MAX_AI_LINES:
            break
    return [ln for ln in picked[: limits.MAX_AI_LINES] if ln]


def parse_pdf(
    content: bytes, file_name: str, context: dict[str, Any]
) -> NormalizedStatement | NeedsAiLayout:
    text = extract_text(content)
    if not text.strip():
        raise SmartImportError("no_text_layer")
    file_hash = hashlib.sha256(content).hexdigest()
    for layout in LAYOUTS:
        try:
            if not layout.matches(text):
                continue
            statement: NormalizedStatement = layout.parse(text)
        except SmartImportError:
            raise
        except Exception:
            continue  # a layout that chokes is treated as not matching
        if statement["transactions"]:
            statement["file_hash"] = file_hash
            return finalize_statement(statement, context, file_name)
    lines = _candidate_lines(text)
    return NeedsAiLayout(lines=lines, line_count=len(lines), file_hash=file_hash)
