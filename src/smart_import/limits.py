"""Hard limits for statement parsing (design 4.1).

Enforced before and during parsing. csv.field_size_limit is process global, so
it is never changed; parsers check field sizes themselves.
"""

from __future__ import annotations

from typing import Protocol

from .errors import SmartImportError

MAX_FILES_PER_BATCH = 12  # enforced by the client; listed here for the status endpoint
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_CONTEXT_BYTES = 256 * 1024
MAX_CSV_ROWS = 20_000
MAX_CSV_FIELD_CHARS = 10_000
MAX_CSV_COLUMNS = 256
MAX_OFX_TAGS = 200_000
MAX_OFX_TAG_NAME = 32
MAX_OFX_VALUE_CHARS = 2_000
MAX_OFX_STATEMENTS = 12
MAX_PDF_PAGES = 60
MAX_PDF_TEXT_CHARS = 2_000_000
PDF_WALL_CLOCK_SECONDS = 20.0
# Decoded content stream budget, checked before any text is extracted.
MAX_PDF_PAGE_CONTENT_BYTES = 256 * 1024
MAX_PDF_TOTAL_CONTENT_BYTES = 4 * 1024 * 1024
MAX_PDF_PAGE_TEXT_OPS = 20_000
# Address space for the extraction child process (enforced on Linux, where
# pypdf has been checked to read a statement under 256 MiB).
PDF_CHILD_MAX_ADDRESS_BYTES = 512 * 1024 * 1024
# PDF extraction children running at once per process; another upload is
# refused with ``busy`` rather than queued, so it cannot hold a worker.
MAX_CONCURRENT_PDF_READS = 2
MAX_TRANSACTIONS_PER_STATEMENT = 10_000
# Candidate lines a PDF hands to AI extract, and lines one extract request takes.
MAX_AI_LINES = 400
MAX_DESCRIPTION_CHARS = 120

ALLOWED_EXTENSIONS: dict[str, str] = {
    ".csv": "csv",
    ".txt": "csv",
    ".ofx": "ofx",
    ".qfx": "ofx",
    ".pdf": "pdf",
}


class _AsyncReader(Protocol):
    async def read(self, size: int = -1) -> bytes: ...


async def read_limited(upload: _AsyncReader, max_bytes: int = MAX_FILE_BYTES) -> bytes:
    """Read at most max_bytes + 1 bytes and raise file_too_large past max_bytes."""
    data = await upload.read(max_bytes + 1)
    if len(data) > max_bytes:
        raise SmartImportError("file_too_large")
    return data


def sniff_type(file_name: str, head: bytes) -> str:
    """Return 'csv', 'ofx' or 'pdf' from the extension, checked against content.

    Raises unsupported_type for an unknown extension or a content mismatch
    (for example a .pdf that does not start with ``%PDF-``).
    """
    name = (file_name or "").lower()
    dot = name.rfind(".")
    expected = ALLOWED_EXTENSIONS.get(name[dot:]) if dot >= 0 else None
    if expected is None:
        raise SmartImportError("unsupported_type")

    start = head[:4096].lstrip(b"\xef\xbb\xbf \t\r\n")
    is_pdf = start.startswith(b"%PDF-")
    upper = start.upper()
    is_ofx = upper.startswith(b"OFXHEADER") or b"<OFX>" in upper
    if expected == "pdf" and not is_pdf:
        raise SmartImportError("unsupported_type")
    if expected == "ofx" and not is_ofx:
        raise SmartImportError("unsupported_type")
    if expected == "csv" and (is_pdf or is_ofx):
        raise SmartImportError("unsupported_type")
    return expected
