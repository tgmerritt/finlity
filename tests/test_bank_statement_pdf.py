import pytest
import io
from datetime import datetime
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from src.api.bank_statements import _parse_amount, _normalize_name, _detect_recurring, _parse_usaa_pdf

def create_synthetic_pdf(lines: list[str]) -> bytes:
    """Helper to create an in-memory PDF with specific text lines."""
    buffer = io.BytesIO()
    c = canvas.Canvas(buffer, pagesize=letter)
    y = 750
    for line in lines:
        c.drawString(50, y, line)
        y -= 15
    c.save()
    buffer.seek(0)
    return buffer.getvalue()

def test_parse_amount():
    """Validates currency string parsing including negatives in parentheses."""
    assert _parse_amount('$1,234.56') == 1234.56
    assert _parse_amount('(100.00)') == -100.00
    assert _parse_amount('0') == 0.0
    assert _parse_amount('') is None
    assert _parse_amount(None) is None

def test_normalize_name():
    """Validates name cleaning: stripping trailing digit codes and applying title case."""
    # Strips 6-digit ACH date code from anywhere in the string
    assert _normalize_name('EXAMPLE BANK TRANSFER 010100') == 'Example Bank Transfer'
    # ***********9999 has no space between asterisks and digits, so the whole
    # token stays intact (regex requires whitespace before trailing digits)
    assert _normalize_name('Zelle: Jane Doe ***********9999') == 'Zelle: Jane Doe ***********9999'
    # Strips trailing long digit sequence (with space separator)
    assert _normalize_name('USAA DEBIT 1234567890') == 'Usaa Debit'
    # Title case
    assert _normalize_name('walmart') == 'Walmart'
    # Trailing 4-digit number stripped, but 'Payment' remains (not empty)
    assert _normalize_name('PAYMENT 4567') == 'Payment'
    # ACH code in middle is stripped
    assert _normalize_name('TRANSFER 021726 TO LOAN') == 'Transfer To Loan'
    # Space-separated trailing digits are stripped
    assert _normalize_name('WALMART 9999') == 'Walmart'

def test_parse_usaa_pdf_success():
    """Validates successful parsing of a standard USAA statement PDF."""
    lines = [
        'Statement Period: 02/14/2026 to 03/16/2026',
        '02/17 USAA DEBIT',
        'Zelle: Test Merchant',
        '1234567890 $450.00 0',
        '$7,632.27',
        '02/18 ACH WITHDRAWAL 021826',
        'EXAMPLE BANK TRANSFER',
        '***********9999 $2,000.00 0',
        '$5,632.27',
        '02/19 POS PURCHASE 021926',
        'WHOLE FOODS MARKET',
        '***1234 $87.43 0',
        '$5,544.84',
        '02/20 ACH DEP 022026',
        'UNEEQ, INC. Bill.com',
        '***********HAID 0',
        '$1,112.33 $6,657.17'
    ]
    pdf_bytes = create_synthetic_pdf(lines)
    result = _parse_usaa_pdf(pdf_bytes)
    
    # Only debits (negative amounts) should be returned. 
    # In the provided lines, the $1,112.33 is a deposit (credit).
    # The logic expects debits.
    assert len(result) == 3
    
    # First transaction
    assert result[0]['date'] == datetime(2026, 2, 17)
    assert result[0]['amount'] == 450.00
    assert 'Test Merchant' in result[0]['name']

    # Second transaction
    assert result[1]['date'] == datetime(2026, 2, 18)
    assert result[1]['amount'] == 2000.00

    # Third transaction
    assert result[2]['date'] == datetime(2026, 2, 19)
    assert result[2]['amount'] == 87.43

def test_parse_usaa_pdf_credit_only():
    """Validates that a PDF containing only credits returns an empty list of debits."""
    # Credit lines have no dollar sign before the trailing 0 (Credits column is non-zero)
    lines = [
        'Statement Period: 01/01/2026 to 01/31/2026',
        '01/05 ACH DEP 010526',
        'EMPLOYER PAYROLL',
        '***********1234 0',
        '$5,000.00 $5,000.00'
    ]
    pdf_bytes = create_synthetic_pdf(lines)
    result = _parse_usaa_pdf(pdf_bytes)
    assert result == []

def test_parse_usaa_pdf_malformed():
    """Validates that malformed PDF bytes do not cause a crash and return empty list."""
    result = _parse_usaa_pdf(b'not a pdf')
    assert result == []

def test_parse_usaa_pdf_year_derivation():
    """Validates that transaction years are correctly derived from the statement period."""
    lines = [
        'Statement Period: 12/14/2025 to 01/16/2026',
        '12/28 TEST MERCHANT',
        '***1234 $10.00 0',
        '$10.00',
        '01/05 ANOTHER MERCHANT',
        '***1234 $20.00 0',
        '$20.00'
    ]
    pdf_bytes = create_synthetic_pdf(lines)
    result = _parse_usaa_pdf(pdf_bytes)
    
    assert result[0]['date'] == datetime(2025, 12, 28)
    assert result[1]['date'] == datetime(2026, 1, 5)

def test_detect_recurring():
    """Validates recurring detection: returns candidate dicts sorted by amount desc.

    _detect_recurring returns aggregated candidates [{name, amount, frequency, occurrences}],
    not the original transaction rows. Groups with < 3 occurrences or inconsistent amounts
    are excluded. Dates must be datetime objects.
    """
    transactions = [
        # Netflix: 4 occurrences, same amount -> included
        {'name': 'Netflix', 'amount': 15.99, 'date': datetime(2023, 1, 1)},
        {'name': 'Netflix', 'amount': 15.99, 'date': datetime(2023, 2, 1)},
        {'name': 'Netflix', 'amount': 15.99, 'date': datetime(2023, 3, 1)},
        {'name': 'Netflix', 'amount': 15.99, 'date': datetime(2023, 4, 1)},

        # Grocery: only 2 occurrences (below MIN_OCCURRENCES=3) -> excluded
        {'name': 'Grocery', 'amount': 50.00, 'date': datetime(2023, 1, 1)},
        {'name': 'Grocery', 'amount': 75.00, 'date': datetime(2023, 1, 15)},

        # Rent: 3 occurrences, same amount -> included
        {'name': 'Rent', 'amount': 2000.00, 'date': datetime(2023, 1, 1)},
        {'name': 'Rent', 'amount': 2000.00, 'date': datetime(2023, 2, 1)},
        {'name': 'Rent', 'amount': 2000.00, 'date': datetime(2023, 3, 1)},
    ]

    candidates = _detect_recurring(transactions)
    names = [c['name'] for c in candidates]

    assert 'Netflix' in names
    assert 'Rent' in names
    assert 'Grocery' not in names

    # Results are sorted by amount descending
    assert candidates[0]['name'] == 'Rent'
    assert candidates[1]['name'] == 'Netflix'

    # Each candidate has the expected keys
    for c in candidates:
        assert {'name', 'amount', 'frequency', 'occurrences'}.issubset(c.keys())

def test_upload_endpoint_smoke(client):
    """Smoke test for the upload endpoint to ensure no 500 errors occur."""
    lines = [
        'Statement Period: 01/01/2024 to 01/31/2024',
        '01/01 TEST',
        '***1234 $10.00 0',
        '$10.00'
    ]
    pdf_bytes = create_synthetic_pdf(lines)
    
    response = client.post(
        '/api/budget/bank-statements/upload',
        files={'file': ('test.pdf', pdf_bytes, 'application/pdf')}
    )
    
    # We expect 200 (success) or 422 (validation error), but never 500 (crash)
    assert response.status_code in [200, 422]