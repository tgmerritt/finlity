"""Stateless v2 bank-statement parsing endpoint.

Reuses v1's `_parse_file_rows` and `_detect_recurring` (already module-level
functions in src/api/bank_statements.py, just underscore-prefixed — no move
needed). No DB writes: no BankStatementImport/RecurringCandidate rows, and
no dedup-by-content-hash (the client is responsible for dedup).
"""

import hashlib

from fastapi import APIRouter, File, HTTPException, UploadFile
from pydantic import BaseModel

from src.api.bank_statements import (
    MAX_FILE_COUNT,
    MAX_TOTAL_FILE_SIZE,
    _detect_recurring,
    _parse_file_rows,
)

router = APIRouter(prefix="/api/v2/bank-statements", tags=["v2-bank-statements"])


class ParsedImportResponse(BaseModel):
    file_name: str
    content_hash: str
    row_count: int


class RecurringCandidateV2(BaseModel):
    name: str
    amount: float
    frequency: str
    occurrences: int


class BankStatementParseResponse(BaseModel):
    imports: list[ParsedImportResponse]
    candidates: list[RecurringCandidateV2]


@router.post("/parse", response_model=BankStatementParseResponse)
async def parse_bank_statements(
    files: list[UploadFile] = File(...),
) -> BankStatementParseResponse:
    """Parse one or more bank statements (CSV or PDF) and return recurring
    transaction candidates. Nothing is persisted server-side — the client
    dedupes by content hash and stores accepted candidates itself.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    if len(files) > MAX_FILE_COUNT:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {MAX_FILE_COUNT} files allowed; received {len(files)}.",
        )

    imports: list[ParsedImportResponse] = []
    all_rows: list[dict] = []
    total_size = 0

    for upload in files:
        content = await upload.read()
        total_size += len(content)
        if total_size > MAX_TOTAL_FILE_SIZE:
            raise HTTPException(
                status_code=413,
                detail=f"Total upload size exceeds {MAX_TOTAL_FILE_SIZE // (1024 * 1024)} MB limit.",
            )

        filename = upload.filename or "unknown"
        content_hash = hashlib.sha256(content).hexdigest()
        file_rows = _parse_file_rows(filename, content)

        imports.append(ParsedImportResponse(
            file_name=filename,
            content_hash=content_hash,
            row_count=len(file_rows),
        ))
        all_rows.extend(file_rows)

    candidates_data = _detect_recurring(all_rows)

    return BankStatementParseResponse(
        imports=imports,
        candidates=[
            RecurringCandidateV2(
                name=c["name"],
                amount=c["amount"],
                frequency=c["frequency"],
                occurrences=c["occurrences"],
            )
            for c in candidates_data
        ],
    )
