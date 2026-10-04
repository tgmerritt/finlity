"""PDF text extraction child process (design 4.4, run by pdf_parser).

Run as ``python -I pdf_worker.py <limits...>`` with the PDF bytes on stdin. It
imports only the standard library and pypdf (never the app), lowers its own
memory and CPU limits, checks a content budget before extracting, and writes
one reply to stdout:

* ``OK\\n`` followed by the extracted text as UTF-8, or
* ``ERR <error_type>\\n`` with a catalog error type and nothing else.

The parent enforces a hard wall clock and kills this process on expiry, so a
page that is slow inside pypdf cannot hold a server worker. Nothing here logs
or prints statement content except the extracted text itself, to the parent.
"""

from __future__ import annotations

import io
import sys
import zlib
from typing import Any

class Rejected(Exception):
    """A limit or format rejection carrying a catalog error type."""

    def __init__(self, error_type: str) -> None:
        super().__init__(error_type)
        self.error_type = error_type


def set_resource_limits(max_address_bytes: int, max_cpu_seconds: int) -> None:
    """Cap address space and CPU time where the platform supports it.

    Linux (Heroku, Docker) enforces RLIMIT_AS; macOS may ignore or refuse it,
    in which case the parent's wall clock kill is the only bound.
    """
    try:
        import resource
    except ImportError:  # not available on Windows
        return
    for name, value in (("RLIMIT_AS", max_address_bytes), ("RLIMIT_CPU", max_cpu_seconds)):
        which = getattr(resource, name, None)
        if which is None or value <= 0:
            continue
        try:
            _soft, hard = resource.getrlimit(which)
            if hard != resource.RLIM_INFINITY:
                value = min(value, hard)
            resource.setrlimit(which, (value, hard))
        except (ValueError, OSError):
            continue


def _filters(stream: Any) -> list[str]:
    raw = stream.get("/Filter")
    if raw is None:
        return []
    raw = raw.get_object()
    if isinstance(raw, list):
        return [str(f.get_object()) for f in raw]
    return [str(raw)]


def _bounded_size(stream: Any, cap: int) -> tuple[int, bytes]:
    """Return (decoded size, decoded bytes when cheaply known), stopping past cap.

    Only FlateDecode and the ASCII filters are decoded, with a hard output
    bound; any other filter counts its raw size and is left to the parent's
    wall clock and this process's memory limit.
    """
    data: bytes = stream._data  # raw (still encoded) stream bytes
    if not isinstance(data, (bytes, bytearray)):
        raise Rejected("unreadable")
    data = bytes(data)
    for name in _filters(stream):
        if name in ("/FlateDecode", "/Fl"):
            out = zlib.decompressobj().decompress(data, cap + 1)
            data = out
        elif name in ("/ASCIIHexDecode", "/AHx", "/ASCII85Decode", "/A85"):
            from pypdf.filters import ASCII85Decode, ASCIIHexDecode

            decoder = ASCIIHexDecode if name in ("/ASCIIHexDecode", "/AHx") else ASCII85Decode
            decoded = decoder.decode(data)
            data = decoded.encode("latin-1") if isinstance(decoded, str) else bytes(decoded)
        else:
            return len(data), b""
        if len(data) > cap:
            return len(data), b""
    return len(data), data


def _page_streams(page: Any) -> list[Any]:
    """The page's content streams plus form XObjects it can draw (recursively)."""
    found: list[Any] = []
    seen: set[int] = set()

    def add(obj: Any) -> None:
        obj = obj.get_object() if obj is not None else None
        if obj is None or id(obj) in seen:
            return
        seen.add(id(obj))
        if isinstance(obj, list):
            for item in obj:
                add(item)
            return
        if hasattr(obj, "_data"):
            found.append(obj)

    def add_forms(resources: Any, depth: int) -> None:
        if resources is None or depth > 8:
            return
        resources = resources.get_object()
        xobjects = resources.get("/XObject") if hasattr(resources, "get") else None
        if xobjects is None:
            return
        xobjects = xobjects.get_object()
        for ref in list(xobjects.values()) if hasattr(xobjects, "values") else []:
            obj = ref.get_object()
            if id(obj) in seen or obj.get("/Subtype") != "/Form":
                continue
            add(obj)
            add_forms(obj.get("/Resources"), depth + 1)

    add(page.get("/Contents"))
    add_forms(page.get("/Resources"), 0)
    return found


def check_budget(reader: Any, max_page_bytes: int, max_total_bytes: int, max_page_ops: int) -> None:
    """Reject a document whose content streams are too large before extracting."""
    total = 0
    for page in reader.pages:
        page_bytes = 0
        page_ops = 0
        for stream in _page_streams(page):
            size, data = _bounded_size(stream, max_page_bytes - page_bytes)
            page_bytes += size
            if page_bytes > max_page_bytes:
                raise Rejected("pdf_text_too_large")
            # Text-showing operators; a cheap upper bound on extraction work.
            page_ops += data.count(b"Tj") + data.count(b"TJ")
            if page_ops > max_page_ops:
                raise Rejected("pdf_text_too_large")
        total += page_bytes
        if total > max_total_bytes:
            raise Rejected("pdf_text_too_large")


def extract(
    content: bytes,
    max_pages: int,
    max_text_chars: int,
    max_page_bytes: int,
    max_total_bytes: int,
    max_page_ops: int,
) -> str:
    import pypdf

    try:
        reader = pypdf.PdfReader(io.BytesIO(content), strict=False)
        if reader.is_encrypted:
            try:
                opened = reader.decrypt("")
            except Exception:
                raise Rejected("encrypted_pdf") from None
            if not opened:
                raise Rejected("encrypted_pdf")
        page_count = len(reader.pages)
        if page_count > max_pages:
            raise Rejected("too_many_pages")
        check_budget(reader, max_page_bytes, max_total_bytes, max_page_ops)
        chunks: list[str] = []
        total = 0
        for index in range(page_count):
            text = reader.pages[index].extract_text() or ""
            total += len(text)
            if total > max_text_chars:
                raise Rejected("pdf_text_too_large")
            chunks.append(text)
    except Rejected:
        raise
    except MemoryError:
        raise Rejected("pdf_text_too_large") from None
    except Exception:
        # pypdf errors can quote file content; only the error type leaves.
        raise Rejected("unreadable") from None
    return "\n".join(chunks)


def main(argv: list[str]) -> int:
    try:
        (
            max_pages,
            max_text_chars,
            max_page_bytes,
            max_total_bytes,
            max_page_ops,
            max_address_bytes,
            max_cpu_seconds,
        ) = (int(a) for a in argv[1:8])
    except ValueError:
        sys.stdout.buffer.write(b"ERR unreadable\n")
        return 0
    set_resource_limits(max_address_bytes, max_cpu_seconds)
    out = sys.stdout.buffer
    try:
        content = sys.stdin.buffer.read()
        text = extract(
            content,
            max_pages,
            max_text_chars,
            max_page_bytes,
            max_total_bytes,
            max_page_ops,
        )
        payload = b"OK\n" + text.encode("utf-8", "replace")
    except Rejected as exc:
        payload = b"ERR " + exc.error_type.encode("ascii") + b"\n"
    except MemoryError:
        payload = b"ERR pdf_text_too_large\n"
    out.write(payload)
    out.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
