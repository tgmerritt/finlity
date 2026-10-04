"""Synthetic PDF builders for smart import tests (reportlab, all fake data)."""

from __future__ import annotations

import io

from pypdf import PdfReader, PdfWriter
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas


def make_pdf(lines: list[str], lines_per_page: int = 45) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    y = 750
    count = 0
    for line in lines:
        if count and count % lines_per_page == 0:
            c.showPage()
            y = 750
        c.drawString(40, y, line)
        y -= 15
        count += 1
    c.save()
    return buf.getvalue()


def make_image_only_pdf(pages: int = 1) -> bytes:
    """Pages with drawn shapes but no text, like a scan."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    for _ in range(pages):
        c.rect(50, 50, 400, 600, fill=1)
        c.showPage()
    c.save()
    return buf.getvalue()


def make_many_pages_pdf(pages: int) -> bytes:
    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=letter)
    for n in range(pages):
        c.drawString(50, 700, f"page {n}")
        c.showPage()
    c.save()
    return buf.getvalue()


def encrypt_pdf(content: bytes, user_password: str) -> bytes:
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(content)))
    writer.encrypt(
        user_password=user_password, owner_password="owner-pw", algorithm="AES-128"
    )
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


USAA_LINES = [
    "USAA CLASSIC CHECKING",
    "Statement Period: 02/14/2026 to 03/16/2026",
    "02/17 USAA DEBIT",
    "Zelle: Test Merchant",
    "1234567890 $450.00 0",
    "$7,632.27",
    "02/18 ACH WITHDRAWAL 021826",
    "EXAMPLE BANK TRANSFER",
    "***********9999 $2,000.00 0",
    "$5,632.27",
    "02/19 POS PURCHASE 021926",
    "WHOLE FOODS MARKET",
    "***1234 $87.43 0",
    "$5,544.84",
    "02/20 ACH DEP 022026",
    "EXAMPLE CORP PAYROLL",
    "***********HAID 0",
    "$1,112.33 $6,657.17",
]

CARD_LINES = [
    "EXAMPLE CARD SERVICES",
    "Account Number: 4000123456789010",
    "Opening/Closing Date 12/15/2025 - 01/14/2026",
    "New Balance $1,234.56",
    "Minimum Payment Due $35.00",
    "Payment Due Date 02/10/2026",
    "Transactions",
    "12/20 12/21 BLUE BOTTLE COFFEE $4.50",
    "12/28 12/29 EXAMPLE MARKET #12 $87.43",
    "SPRINGFIELD ST",
    "01/03 01/04 PAYMENT THANK YOU -$500.00",
    "01/05 01/06 STREAMBOX MONTHLY $15.99",
    "01/09 01/10 RETURNED ITEM CREDIT $12.00CR",
]


def make_raw_pdf(page_streams: list[bytes], compress: bool = True) -> bytes:
    """A minimal hand-built PDF, one page per content stream (synthetic only).

    Lets tests build pages that reportlab never would, such as a single page
    with a million text operators, without spending time drawing them.
    """
    import zlib

    n_pages = len(page_streams)
    font_id = 3 + 2 * n_pages
    kids = " ".join(f"{3 + 2 * i} 0 R" for i in range(n_pages))
    objs: list[bytes] = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        f"<< /Type /Pages /Kids [{kids}] /Count {n_pages} >>".encode(),
    ]
    for i, stream in enumerate(page_streams):
        page_id, content_id = 3 + 2 * i, 4 + 2 * i
        assert len(objs) + 1 == page_id
        objs.append(
            (
                "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                f"/Resources << /Font << /F1 {font_id} 0 R >> >> "
                f"/Contents {content_id} 0 R >>"
            ).encode()
        )
        data = zlib.compress(stream) if compress else stream
        filt = b" /Filter /FlateDecode" if compress else b""
        objs.append(
            b"<< /Length %d%s >>\nstream\n" % (len(data), filt)
            + data
            + b"\nendstream"
        )
    objs.append(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, obj in enumerate(objs, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + obj + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objs) + 1,
        xref,
    )
    return bytes(out)


def text_ops_stream(ops: int, text: bytes = b"a") -> bytes:
    """A content stream with ``ops`` Tj operators."""
    return b"BT /F1 12 Tf 10 700 Td\n" + (b"(" + text + b") Tj\n") * ops + b"ET\n"
