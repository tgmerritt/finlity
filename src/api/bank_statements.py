"""
Bank Statement upload and recurring transaction detection API.

Accepts CSV or PDF files (one or many). Upload -> parse -> detect recurring
transactions (same normalized merchant name, >=3 occurrences across all
uploaded files combined, amount within 10% of median) -> store as
RecurringCandidate rows. Users accept (creates BudgetExpense) or reject.
"""

from __future__ import annotations

import csv
import hashlib
import io
import logging
import re
import statistics
from collections import defaultdict
from datetime import datetime
from typing import Optional

import pypdf
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from pydantic import BaseModel
from sqlalchemy import func
from sqlalchemy.orm import Session

from src.api.dependencies import get_db
from src.database import get_database
from src.database.models import (
    BankStatementImport,
    BudgetExpense,
    BudgetExpenseCategory,
    RecurringCandidate,
)

# ---------------------------------------------------------------------------
# Configuration constants
# ---------------------------------------------------------------------------

# Maximum total file size per upload request: 50 MB
MAX_TOTAL_FILE_SIZE = 50 * 1024 * 1024

# Maximum number of files per upload request
MAX_FILE_COUNT = 20

# Minimum occurrences for recurring detection
MIN_OCCURRENCES = 3

# Amount tolerance: fraction of median allowed (10%)
AMOUNT_TOLERANCE = 0.10

# Supported file extensions
ALLOWED_EXTENSIONS = (".csv", ".pdf")

# Supported bank parsers — extendable registry
# Each entry: (extension_tuple, parser_fn)
ParserEntry = tuple[tuple[str, ...], callable]
PARSER_REGISTRY: list[ParserEntry] = []

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/budget/bank-statements", tags=["bank-statements"])

# ---------------------------------------------------------------------------
# Pydantic response models
# ---------------------------------------------------------------------------


class RecurringCandidateResponse(BaseModel):
    id: str
    import_id: str
    name: str
    amount: float
    frequency: str
    occurrences: int
    status: str
    created_expense_id: Optional[str] = None


class BankStatementImportResponse(BaseModel):
    id: str
    file_name: str
    row_count: int
    status: str
    error_message: Optional[str] = None
    uploaded_at: str
    analyzed_at: Optional[str] = None
    candidates: list[RecurringCandidateResponse] = []


class BankStatementBatchResponse(BaseModel):
    files_imported: int
    files_skipped: int
    total_rows: int
    candidates: list[RecurringCandidateResponse] = []


class AcceptCandidateRequest(BaseModel):
    category_id: Optional[str] = None
    frequency: Optional[str] = None
    amount: Optional[float] = None


# ---------------------------------------------------------------------------
# Column name heuristics
# ---------------------------------------------------------------------------

_AMOUNT_COLUMNS = ["amount", "debit", "credit", "withdrawal", "deposit", "transaction amount"]
_DATE_COLUMNS = ["date", "transaction date", "posted date", "post date"]
_DESC_COLUMNS = ["description", "merchant", "payee", "memo", "transaction description", "name"]


def _find_column(headers: list[str], candidates_list: list[str]) -> Optional[str]:
    """Return the first header (case-insensitive) matching one of the candidates."""
    lower = {h.lower().strip(): h for h in headers}
    for c in candidates_list:
        if c in lower:
            return lower[c]
    return None


def _parse_amount(raw: str) -> Optional[float]:
    """Parse a dollar-amount string, handling commas, $ signs, and parentheses (negatives)."""
    if not raw:
        return None
    raw = raw.strip().replace("$", "").replace(",", "")
    negative = raw.startswith("(") and raw.endswith(")")
    raw = raw.strip("()")
    try:
        val = float(raw)
        return -val if negative else val
    except ValueError:
        return None


def _parse_usaa_pdf(content: bytes) -> list[dict]:
    """
    Parse a USAA bank statement PDF into a list of transaction dicts.

    Each dict has keys: name (str), amount (float|None), date (datetime|None).
    Debit amounts are stored as positive floats.  Credit transactions (deposits,
    transfers-in) are skipped so paychecks do not appear as recurring candidates.

    USAA PDF line structure (from pypdf text extraction):
      - Transaction header: 'MM/DD <first description words>'
      - Optional continuation lines: merchant name, account mask
      - Amount line for DEBITS:  '<mask or desc> $N,NNN.NN 0'
          The trailing '0' is the Credits column (zero for a debit).
      - Amount line for CREDITS: '<mask or desc> 0'  (no dollar sign)
          Followed by '$credit $balance' on the next line.
      - Balance line: '$N,NNN.NN' alone, or appended to previous line.

    Year derivation:
      Dates in the PDF are MM/DD only.  The year is parsed from the
      'Statement Period: MM/DD/YYYY to MM/DD/YYYY' header.
      Month rollover (Dec→Jan statements) increments the year.
    """
    try:
        reader = pypdf.PdfReader(io.BytesIO(content))
    except Exception:
        return []

    full_text = "\n".join(
        page.extract_text() or "" for page in reader.pages
    )

    # Derive statement year and start month from header
    year = datetime.utcnow().year
    start_month = 1
    period_match = re.search(
        r'Statement Period[:\s]+(\d{2})/(\d{2})/(\d{4})', full_text
    )
    if period_match:
        start_month = int(period_match.group(1))
        year = int(period_match.group(3))

    lines = [ln.strip() for ln in full_text.splitlines()]

    # Pattern: transaction header starts with MM/DD then a space and text
    txn_pat = re.compile(r'^(\d{2})/(\d{2})\s+(.+)$')
    # Dollar amount pattern
    money_pat = re.compile(r'\$([\d,]+\.\d{2})')
    # A debit amount line ends with '0' (Credits column) after a dollar amount
    # e.g.  '$1,079.97 0'  or  '***HAID $450.00 0'
    debit_line_pat = re.compile(r'\$([\d,]+\.\d{2})\s+0\s*$')
    # A credit amount line has just '0' at the end, no dollar sign before
    # e.g.  '***HAID 0'  or  'CONF# 1234567890 0'
    credit_only_pat = re.compile(r'^[^$]*\s0\s*$')

    # Rows to skip (matched against lower-cased description)
    skip_names = {'beginning balance', 'ending balance', 'iod interest paid'}

    # Page header/footer lines to skip while scanning inside a transaction
    _is_header = re.compile(
        r'^(Page \d|USAA CLASSIC|for Account|Online:|Statement Period|'
        r'\d{8,12}\s*$|Date Description|Transactions)'
    )

    rows: list[dict] = []
    n = len(lines)
    i = 0

    while i < n:
        line = lines[i]
        m = txn_pat.match(line)
        if not m:
            i += 1
            continue

        month = int(m.group(1))
        day = int(m.group(2))
        first_text = m.group(3).strip()  # everything after 'MM/DD '

        # Gather description lines and find the debit/credit indicator line
        desc_parts: list[str] = []
        debit_amount: Optional[float] = None
        j = i + 1

        # First, check if the debit marker is already in first_text
        # e.g. 'TRANSFER TO LOAN 9319 $1,079.97 0'
        dm = debit_line_pat.search(first_text)
        if dm:
            debit_amount = float(dm.group(1).replace(',', ''))
            # Strip the amount part from the description
            desc_clean = debit_line_pat.sub('', first_text).strip()
            desc_parts.append(desc_clean)
        elif re.match(r'^.*\s0\s0\s*$', first_text):
            # 'Beginning Balance 0 0' or similar — both debit and credit are 0
            desc_clean = re.sub(r'\s+0\s+0\s*$', '', first_text).strip()
            desc_parts.append(desc_clean)
            # debit_amount stays None → will be skipped
        else:
            desc_parts.append(first_text)
            # Scan continuation lines
            while j < n:
                peek = lines[j]
                if txn_pat.match(peek):
                    break
                if _is_header.match(peek):
                    j += 1
                    continue

                dm2 = debit_line_pat.search(peek)
                if dm2:
                    # This is the debit amount line
                    debit_amount = float(dm2.group(1).replace(',', ''))
                    j += 1
                    break

                # Credit-only indicator: line ends with '0' and has no '$'
                # e.g. '***********HAID 0'  or  'CONF# 1234567890 0'
                if credit_only_pat.match(peek) and '$' not in peek:
                    # Credit transaction — skip the rest
                    j += 1
                    break

                # Money-only line (standalone balance or credit $amount $balance)
                if money_pat.search(peek) and not debit_line_pat.search(peek):
                    # Could be balance line or credit dollar line — skip
                    j += 1
                    break

                if peek:
                    desc_parts.append(peek)
                j += 1

        # Build and clean the description
        raw_desc = ' '.join(p for p in desc_parts if p).strip()
        # Remove ACH date codes (e.g. '021726', '030226') from descriptions
        raw_desc = re.sub(r'\b\d{6}\b', '', raw_desc).strip()
        # Remove masked account numbers like '***********XXXX'
        raw_desc = re.sub(r'\*{3,}\S+', '', raw_desc).strip()
        raw_desc = re.sub(r'\s{2,}', ' ', raw_desc).strip()

        if not raw_desc or raw_desc.lower() in skip_names:
            i = j
            continue

        if debit_amount is not None and debit_amount > 0:
            # Handle year rollover for statements spanning Dec→Jan
            txn_year = year
            if month < start_month:
                txn_year = year + 1
            try:
                parsed_date: Optional[datetime] = datetime(txn_year, month, day)
            except ValueError:
                parsed_date = None

            rows.append({
                'name': _normalize_name(raw_desc),
                'amount': round(debit_amount, 2),
                'date': parsed_date,
            })

        i = j

    return rows


# ---------------------------------------------------------------------------
# Recurring-transaction detection
# ---------------------------------------------------------------------------


def _infer_frequency(dates: list[datetime]) -> str:
    """Infer payment cadence from a list of transaction dates.

    Returns one of: 'weekly', 'biweekly', 'monthly', 'annual', or 'unknown'.
    'unknown' is returned when there are fewer than 2 dates to infer a gap.
    """
    if len(dates) < 2:
        return "unknown"
    sorted_dates = sorted(dates)
    gaps = [(sorted_dates[i + 1] - sorted_dates[i]).days for i in range(len(sorted_dates) - 1)]
    avg_gap = statistics.mean(gaps)
    if avg_gap <= 9:
        return "weekly"
    if avg_gap <= 18:
        return "biweekly"
    if avg_gap <= 45:
        return "monthly"
    return "annual"


def _normalize_name(raw: str) -> str:
    """Strip transaction IDs and noise from merchant descriptions.

    Preserves order numbers, invoice refs, and masked account identifiers
    that look like '*NNNNNNNNNN' patterns.  Strips:
      - 6-digit ACH date codes (e.g. '021726')
      - Trailing 4+ digit sequences that look like transaction IDs
      - Trailing date-like suffixes (MM/DD or MM/DD/YYYY)
    """
    name = raw.strip()
    # Remove 6-digit ACH date codes embedded in the middle of the string
    name = re.sub(r'\b\d{6}\b', '', name)
    # Strip trailing 4+ digit sequences (transaction IDs, order numbers)
    name = re.sub(r"\s+\d{4,}$", "", name)
    # Strip trailing date-like suffixes (e.g. "01/15" or "01/15/2026")
    name = re.sub(r"\s+\d{1,2}[/-]\d{1,2}(/\d{2,4})?$", "", name)
    # Collapse multiple spaces
    name = re.sub(r"\s+", " ", name).strip()
    return name.title() if name else ""


def _detect_recurring(rows: list[dict]) -> list[dict]:
    """
    Identify recurring transactions.

    Groups rows by normalized merchant name.  Keeps groups that have at least
    MIN_OCCURRENCES positive-amount transactions whose amounts are all within
    AMOUNT_TOLERANCE of the group median.  Returns results sorted by amount
    descending so the user sees the highest-cost subscriptions first.
    """
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[row["name"]].append(row)

    candidates = []
    for name, txns in groups.items():
        if len(txns) < MIN_OCCURRENCES:
            continue
        amounts = [t["amount"] for t in txns if t["amount"] is not None and t["amount"] > 0]
        if len(amounts) < MIN_OCCURRENCES:
            continue
        median_amt = statistics.median(amounts)
        if median_amt <= 0:
            continue
        consistent = all(abs(a - median_amt) / median_amt <= AMOUNT_TOLERANCE for a in amounts)
        if not consistent:
            continue
        dates = [t["date"] for t in txns if t["date"] is not None]
        freq = _infer_frequency(dates)
        candidates.append(
            {
                "name": name,
                "amount": round(median_amt, 2),
                "frequency": freq,
                "occurrences": len(txns),
            }
        )
    candidates.sort(key=lambda x: x["amount"], reverse=True)
    return candidates


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


def _parse_file_rows(filename: str, content: bytes) -> list[dict]:
    """Parse a single uploaded file (CSV or PDF) into transaction row dicts."""
    if not filename or not any(filename.lower().endswith(ext) for ext in ALLOWED_EXTENSIONS):
        raise HTTPException(
            status_code=400,
            detail=f"{filename!r}: only {', '.join(ALLOWED_EXTENSIONS)} files are accepted.",
        )

    if filename.lower().endswith(".pdf"):
        rows = _parse_usaa_pdf(content)
        if not rows:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{filename!r}: no transactions could be parsed. "
                    "Currently only USAA checking account statements are supported. "
                    "Please upload a USAA PDF statement."
                ),
            )
        return rows

    try:
        text_content = content.decode("utf-8-sig")
        reader = csv.DictReader(io.StringIO(text_content))
        headers = list(reader.fieldnames or [])

        desc_col = _find_column(headers, _DESC_COLUMNS)
        amount_col = _find_column(headers, _AMOUNT_COLUMNS)

        if not desc_col or not amount_col:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{filename!r}: could not find required columns. "
                    f"Need a description column (e.g. 'Description', 'Merchant') "
                    f"and an amount column (e.g. 'Amount', 'Debit'). "
                    f"Columns found: {headers}"
                ),
            )

        date_col = _find_column(headers, _DATE_COLUMNS)
        date_formats = ["%m/%d/%Y", "%Y-%m-%d", "%m-%d-%Y", "%m/%d/%y"]

        rows = []
        for row in reader:
            name = _normalize_name(row.get(desc_col, ""))
            if not name:
                continue
            amount = _parse_amount(row.get(amount_col, ""))
            parsed_date: Optional[datetime] = None
            if date_col:
                raw_date = row.get(date_col, "").strip()
                for fmt in date_formats:
                    try:
                        parsed_date = datetime.strptime(raw_date, fmt)
                        break
                    except ValueError:
                        continue
            rows.append({"name": name, "amount": amount, "date": parsed_date})
        return rows

    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to parse bank statement CSV: %s", filename)
        raise HTTPException(status_code=422, detail=f"{filename!r}: CSV parse error: {exc}") from exc


@router.post("/upload", response_model=BankStatementBatchResponse)
async def upload_bank_statement(
    files: list[UploadFile] = File(...),
    entity_id: Optional[str] = Form(None),
    db: Session = Depends(get_db),
) -> BankStatementBatchResponse:
    """
    Upload one or more bank statements (CSV or PDF).

    All files are parsed together and recurring-transaction detection runs
    across the combined transaction history so monthly statements can be
    batched to find subscriptions that appear once per file.

    Duplicate files (same SHA-256) are silently skipped.
    Returns all detected recurring candidates across the batch.

    Limits:
    - Maximum 20 files per request
    - Maximum 50 MB total size across all files

    The optional ``entity_id`` form field associates the import with a
    specific entity so that accepted expenses inherit the correct owner.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    if len(files) > MAX_FILE_COUNT:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {MAX_FILE_COUNT} files allowed; received {len(files)}.",
        )

    # Read all files and check total size before any DB work
    file_contents: list[tuple[str, bytes]] = []  # (filename, content)
    total_size = 0
    for upload in files:
        content = await upload.read()
        total_size += len(content)
        if total_size > MAX_TOTAL_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"Total upload size exceeds {MAX_TOTAL_FILE_SIZE // (1024 * 1024)} MB limit.",
            )
        file_contents.append((upload.filename or "unknown", content))

    now = datetime.utcnow()

    with db.get_session() as session:
        all_rows: list[dict] = []
        import_records: list[BankStatementImport] = []
        duplicate_import_ids: list[str] = []
        files_skipped = 0

        for filename, content in file_contents:
            content_hash = hashlib.sha256(content).hexdigest()

            existing = session.query(BankStatementImport).filter(
                BankStatementImport.content_hash == content_hash
            ).first()
            if existing:
                files_skipped += 1
                duplicate_import_ids.append(existing.id)
                # Still include its rows in the combined analysis so previously
                # imported months contribute to recurring detection on mixed uploads.
                try:
                    file_rows = _parse_file_rows(filename, content)
                    all_rows.extend(file_rows)
                except HTTPException:
                    pass
                continue

            file_rows = _parse_file_rows(filename, content)

            import_record = BankStatementImport(
                file_name=filename,
                content_hash=content_hash,
                entity_id=entity_id,
                row_count=len(file_rows),
                status="analyzed",
                analyzed_at=now,
            )
            session.add(import_record)
            session.flush()

            import_records.append(import_record)
            all_rows.extend(file_rows)

        # Run detection only when there's at least one new import. Re-detecting
        # on an all-duplicate upload would just recreate identical candidates.
        candidate_objs: list[RecurringCandidate] = []
        if import_records:
            primary_import = import_records[0]
            candidates_data = _detect_recurring(all_rows)
            for c in candidates_data:
                cand = RecurringCandidate(
                    import_id=primary_import.id,
                    name=c["name"],
                    amount=c["amount"],
                    frequency=c["frequency"],
                    occurrences=float(c["occurrences"]),
                )
                session.add(cand)
                candidate_objs.append(cand)

        # Always surface still-pending candidates from any duplicate imports so
        # the user can accept ones they missed on the original upload.
        existing_pending: list[RecurringCandidate] = []
        if duplicate_import_ids:
            existing_pending = (
                session.query(RecurringCandidate)
                .filter(RecurringCandidate.import_id.in_(duplicate_import_ids))
                .filter(RecurringCandidate.status == "pending")
                .all()
            )

        session.commit()
        for cand in candidate_objs:
            session.refresh(cand)
        for cand in existing_pending:
            session.refresh(cand)

        # Merge while avoiding double-listing if a new candidate happens to
        # share id with an existing one (shouldn't, but defensive).
        seen_ids: set[str] = set()
        merged: list[RecurringCandidate] = []
        for cand in candidate_objs + existing_pending:
            if cand.id in seen_ids:
                continue
            seen_ids.add(cand.id)
            merged.append(cand)

        return BankStatementBatchResponse(
            files_imported=len(import_records),
            files_skipped=files_skipped,
            total_rows=len(all_rows),
            candidates=[
                RecurringCandidateResponse(
                    id=c.id,
                    import_id=c.import_id,
                    name=c.name,
                    amount=c.amount,
                    frequency=c.frequency,
                    occurrences=int(c.occurrences),
                    status=c.status,
                    created_expense_id=c.created_expense_id,
                )
                for c in merged
            ],
        )


@router.get("/imports", response_model=list[BankStatementImportResponse])
async def list_imports() -> list[BankStatementImportResponse]:
    """List all bank statement imports with their candidates, newest first."""
    db = get_database()
    with db.get_session() as session:
        imports = (
            session.query(BankStatementImport)
            .order_by(BankStatementImport.uploaded_at.desc())
            .all()
        )
        result = []
        for imp in imports:
            candidates = (
                session.query(RecurringCandidate)
                .filter(RecurringCandidate.import_id == imp.id)
                .all()
            )
            result.append(
                BankStatementImportResponse(
                    id=imp.id,
                    file_name=imp.file_name,
                    row_count=int(imp.row_count),
                    status=imp.status,
                    error_message=imp.error_message,
                    uploaded_at=imp.uploaded_at.isoformat(),
                    analyzed_at=imp.analyzed_at.isoformat() if imp.analyzed_at else None,
                    candidates=[
                        RecurringCandidateResponse(
                            id=c.id,
                            import_id=c.import_id,
                            name=c.name,
                            amount=c.amount,
                            frequency=c.frequency,
                            occurrences=int(c.occurrences),
                            status=c.status,
                            created_expense_id=c.created_expense_id,
                        )
                        for c in candidates
                    ],
                )
            )
        return result


@router.post("/candidates/{candidate_id}/accept")
async def accept_candidate(
    candidate_id: str,
    request: AcceptCandidateRequest,
    db: Session = Depends(get_db),
) -> dict:
    """
    Accept a recurring candidate, creating a BudgetExpense entry.

    The expense inherits the candidate's name, amount, and frequency unless
    overridden in the request body.  Defaults to the 'Other' expense category
    if no category_id is provided.

    Propagates entity_id from the import record to the created expense so
    multi-entity household workflows remain consistent.
    """
    with db.get_session() as session:
        candidate = (
            session.query(RecurringCandidate)
            .filter(RecurringCandidate.id == candidate_id)
            .first()
        )
        if not candidate:
            raise HTTPException(status_code=404, detail="Candidate not found.")
        if candidate.status != "pending":
            raise HTTPException(
                status_code=409, detail=f"Candidate is already {candidate.status}."
            )

        target_name = candidate.name
        target_frequency = request.frequency or candidate.frequency

        # Resolve entity_id from the import record so the expense belongs to
        # the same entity as the bank statement import.
        entity_id: Optional[str] = None
        if candidate.import_record and candidate.import_record.entity_id:
            entity_id = candidate.import_record.entity_id

        # Dedupe: if the user already has an active expense matching this
        # name + frequency (case-insensitive on name), reuse it instead of
        # creating a duplicate row.  Handles the case where the same statement
        # is re-uploaded after a prior accept, or the user manually added the
        # expense before discovering the import flow.
        existing_expense = (
            session.query(BudgetExpense)
            .filter(BudgetExpense.is_active.is_(True))
            .filter(BudgetExpense.frequency == target_frequency)
            .filter(func.lower(BudgetExpense.name) == target_name.lower())
            .first()
        )
        if existing_expense:
            candidate.status = "accepted"
            candidate.created_expense_id = existing_expense.id
            session.commit()
            return {
                "status": "accepted",
                "expense_id": existing_expense.id,
                "candidate_id": candidate_id,
                "deduped": True,
            }

        category_id = request.category_id
        if not category_id:
            other_cat = (
                session.query(BudgetExpenseCategory)
                .filter(BudgetExpenseCategory.name == "Other")
                .first()
            )
            if not other_cat:
                other_cat = BudgetExpenseCategory(
                    name="Other", icon="tag", color="#6b7280", sort_order=99
                )
                session.add(other_cat)
                session.flush()
            category_id = other_cat.id

        expense = BudgetExpense(
            entity_id=entity_id,
            category_id=category_id,
            name=target_name,
            amount=request.amount if request.amount is not None else candidate.amount,
            frequency=target_frequency,
            is_active=True,
        )
        session.add(expense)
        session.flush()

        candidate.status = "accepted"
        candidate.created_expense_id = expense.id
        session.commit()

        return {
            "status": "accepted",
            "expense_id": expense.id,
            "candidate_id": candidate_id,
            "deduped": False,
        }


@router.post("/candidates/{candidate_id}/reject")
async def reject_candidate(candidate_id: str) -> dict:
    """Reject a recurring candidate, dismissing it without creating an expense."""
    db = get_database()
    with db.get_session() as session:
        candidate = (
            session.query(RecurringCandidate)
            .filter(RecurringCandidate.id == candidate_id)
            .first()
        )
        if not candidate:
            raise HTTPException(status_code=404, detail="Candidate not found.")
        if candidate.status != "pending":
            raise HTTPException(
                status_code=409, detail=f"Candidate is already {candidate.status}."
            )
        candidate.status = "rejected"
        session.commit()
        return {"status": "rejected", "candidate_id": candidate_id}