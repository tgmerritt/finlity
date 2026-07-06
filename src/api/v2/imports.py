"""Stateless v2 file-import parsing endpoint.

Reuses v1's parse pipeline (src/api/imports.py:parse_file) but sources the
existing-accounts list for AI/heuristic account suggestion from an optional
form field instead of `db.get_all_accounts()`, and the Claude API key from
the environment only. Nothing is persisted.
"""

import io
import json
import logging
import os
from pathlib import Path
from typing import Optional

import pandas as pd
from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from src.api.imports import (
    ParseFileResponse,
    ParsedPosition,
    _detect_account_type_from_filename,
    _detect_brokerage_from_filename,
    _suggest_account_with_ai,
)
from src.importers import FolderScanner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v2/import", tags=["v2-import"])


class _AccountLike:
    """Adapts a client-supplied account dict to the attribute access
    `_suggest_account_with_ai` expects (.id, .name, .brokerage, .account_type).
    """

    def __init__(self, d: dict):
        self.id = d.get("id")
        self.name = d.get("name", "")
        self.brokerage = d.get("brokerage")
        self.account_type = d.get("account_type")


@router.post("/parse", response_model=ParseFileResponse)
async def parse_file(
    file: UploadFile = File(...),
    accounts: Optional[str] = Form(
        None,
        description="Optional JSON list of {id,name,account_type,brokerage} for account suggestion.",
    ),
) -> ParseFileResponse:
    """Parse a brokerage export file and return positions for review.

    Uses Claude (only if an ANTHROPIC_API_KEY env var is set) plus filename
    heuristics to suggest an account from the caller-supplied `accounts`
    list. Nothing is persisted server-side.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in [".csv", ".xlsx", ".xls"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Supported: .csv, .xlsx, .xls",
        )

    account_dicts: list[dict] = []
    if accounts:
        try:
            account_dicts = json.loads(accounts)
        except json.JSONDecodeError as e:
            raise HTTPException(status_code=400, detail=f"Invalid accounts JSON: {e}") from e

    account_objs = [_AccountLike(a) for a in account_dicts]

    try:
        content = await file.read()

        detected_brokerage = _detect_brokerage_from_filename(file.filename)
        detected_account_type = _detect_account_type_from_filename(file.filename)

        if suffix in [".xlsx", ".xls"]:
            excel_file = pd.ExcelFile(io.BytesIO(content))
            df = None

            for sheet in excel_file.sheet_names:
                temp_df = pd.read_excel(excel_file, sheet_name=sheet)
                cols_lower = [str(c).lower() for c in temp_df.columns]
                if any(col in cols_lower for col in ["symbol", "ticker", "stock"]):
                    df = temp_df
                    break

            if df is None:
                df = pd.read_excel(io.BytesIO(content))
        else:
            content_str = content.decode('utf-8', errors='ignore')
            if content_str.startswith('"Positions for account'):
                df = pd.read_csv(io.StringIO(content_str), skiprows=2)
                detected_brokerage = "schwab"
            else:
                df = pd.read_csv(io.StringIO(content_str))

        # FolderScanner's column-detection/row-extraction helpers never touch
        # self.db (only its scan/import-to-DB methods do), so db=None is safe
        # for this parse-only usage.
        scanner = FolderScanner(db=None)
        detected_columns = scanner._detect_columns(df)

        if "ticker" not in detected_columns:
            raise HTTPException(
                status_code=400,
                detail=f"Could not find ticker/symbol column. Columns found: {list(df.columns)}",
            )

        positions = []
        warnings = []
        skipped_rows = 0

        for idx, row in df.iterrows():
            try:
                result = scanner._extract_position(row, detected_columns)
                if result:
                    ticker, shares, name, price, cost_basis, is_fund, option_fields = result
                    exp_str = None
                    if option_fields.get("option_expiration"):
                        exp_str = option_fields["option_expiration"].isoformat()
                    positions.append(ParsedPosition(
                        ticker=ticker,
                        name=name if name != ticker else None,
                        shares=shares,
                        price=price if price > 0 else None,
                        cost_basis=cost_basis,
                        is_fund=is_fund,
                        position_type=option_fields.get("position_type", "equity"),
                        contract_multiplier=option_fields.get("contract_multiplier"),
                        option_underlying=option_fields.get("option_underlying"),
                        option_expiration=exp_str,
                        option_strike=option_fields.get("option_strike"),
                        option_type=option_fields.get("option_type"),
                    ))
                else:
                    # _extract_position returns None (rather than raising) for
                    # rows with no ticker/shares column, an unparseable/blank
                    # ticker or share count, etc. Those rows previously
                    # vanished silently — count them so the caller can see
                    # something was skipped (rows that raise already produce
                    # a warning below).
                    skipped_rows += 1
            except Exception as e:
                warnings.append(f"Row {idx + 2}: {str(e)}")

        if skipped_rows:
            warnings.append(
                f"{skipped_rows} row(s) could not be parsed and were skipped"
            )

        if not positions:
            raise HTTPException(
                status_code=400,
                detail="No valid positions found in file. Check that the file has ticker and shares columns.",
            )

        # Claude suggestion only if an env API key is present; otherwise
        # filename heuristics only (no app_settings / SecretsManager lookup).
        claude_key = os.environ.get("ANTHROPIC_API_KEY") or None

        suggested_account = _suggest_account_with_ai(
            file.filename,
            account_objs,
            detected_brokerage,
            detected_account_type,
            api_key=claude_key,
        )

        if len(warnings) > 5:
            truncated_warnings = warnings[:5]
            truncated_warnings.append(f"...and {len(warnings) - 5} more warnings")
        else:
            truncated_warnings = warnings

        return ParseFileResponse(
            positions=positions,
            suggested_account=suggested_account,
            detected_brokerage=detected_brokerage,
            row_count=len(positions),
            warnings=truncated_warnings,
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error parsing file: {e}")
        raise HTTPException(status_code=500, detail=f"Error parsing file: {str(e)}")
