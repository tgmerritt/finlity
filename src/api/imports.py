"""Import management API endpoints."""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional
from pathlib import Path
import shutil
import tempfile
import re
import logging

from src.database import Database
from src.importers import FolderScanner

router = APIRouter(prefix="/api/imports", tags=["imports"])
import_router = APIRouter(prefix="/api/import", tags=["import"])

logger = logging.getLogger(__name__)


def get_db() -> Database:
    """Dependency to get database instance (profile-aware)."""
    from src.database import get_database
    return get_database()


def check_demo_mode_write():
    """Raise error if demo mode is enabled (prevents data pollution).

    Demo mode should be read-only with pre-generated data.
    Importing real data would pollute the demo database.
    """
    from src.services.demo_mode import is_demo_mode
    if is_demo_mode():
        raise HTTPException(
            status_code=403,
            detail="Imports are disabled in demo mode. Disable demo mode to import your data."
        )


class PendingFileResponse(BaseModel):
    """Pending file response model."""
    path: str
    file_name: str
    account_type: str
    row_count: int
    detected_columns: dict[str, str]


class ImportHistoryResponse(BaseModel):
    """Import history entry."""
    id: str
    file_name: str
    file_path: str
    account_type: str
    import_date: str
    row_count: Optional[int]
    status: str
    error_message: Optional[str]


class ImportResultResponse(BaseModel):
    """Result of processing imports."""
    files_processed: int
    total_positions_imported: int
    results: list[dict]


@router.get("/scan", response_model=list[PendingFileResponse])
def scan_for_new_files(db: Database = Depends(get_db)) -> list[PendingFileResponse]:
    """Scan import folder for new files not yet imported."""
    scanner = FolderScanner(db)
    pending = scanner.scan_for_new_files()

    return [
        PendingFileResponse(
            path=str(p.path),
            file_name=p.path.name,
            account_type=p.account_type,
            row_count=p.row_count,
            detected_columns=p.detected_columns,
        )
        for p in pending
    ]


@router.post("/process", response_model=ImportResultResponse)
def process_pending_imports(
    brokerage: str = "other",
    fetch_prices: bool = True,
    db: Database = Depends(get_db),
) -> ImportResultResponse:
    """Process all pending imports."""
    check_demo_mode_write()  # Prevent imports in demo mode
    scanner = FolderScanner(db)
    results = scanner.process_all_pending(
        brokerage=brokerage,
        fetch_prices=fetch_prices,
    )

    total_positions = sum(r.positions_imported for r in results)

    return ImportResultResponse(
        files_processed=len(results),
        total_positions_imported=total_positions,
        results=[
            {
                "file": str(r.file_path.name),
                "success": r.success,
                "positions_imported": r.positions_imported,
                "error": r.error_message,
            }
            for r in results
        ],
    )


@router.get("/history", response_model=list[ImportHistoryResponse])
def get_import_history(
    limit: int = 50,
    db: Database = Depends(get_db),
) -> list[ImportHistoryResponse]:
    """Get recent import history."""
    history = db.get_import_history(limit)

    return [
        ImportHistoryResponse(
            id=h.id,
            file_name=h.file_name,
            file_path=h.file_path,
            account_type=h.account_type,
            import_date=h.import_date.isoformat() if h.import_date else "",
            row_count=int(h.row_count) if h.row_count else None,
            status=h.status or "unknown",
            error_message=h.error_message,
        )
        for h in history
    ]


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    account_type: str = "taxable",
    brokerage: str = "other",
    fetch_prices: bool = True,
    db: Database = Depends(get_db),
):
    """
    Upload a file directly and import it.

    The file will be saved to the appropriate import folder based on account_type.
    """
    check_demo_mode_write()  # Prevent imports in demo mode

    # Validate account type
    valid_account_types = [
        "roth_ira", "traditional_ira", "traditional_401k",
        "roth_401k", "taxable", "hsa",
    ]
    if account_type not in valid_account_types:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid account_type. Must be one of: {valid_account_types}",
        )

    # Validate file extension
    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in [".csv", ".xlsx", ".xls"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Supported: .csv, .xlsx, .xls",
        )

    # Save to import folder
    import_dir = Path("data/imports") / account_type
    import_dir.mkdir(parents=True, exist_ok=True)

    file_path = import_dir / file.filename

    # Check if file already exists
    if file_path.exists():
        # Check if it's the same content
        content = await file.read()
        await file.seek(0)

        import hashlib
        new_hash = hashlib.sha256(content).hexdigest()

        if db.is_file_imported(new_hash):
            return {
                "message": "File already imported (duplicate content)",
                "status": "skipped",
            }

    # Save file
    with open(file_path, "wb") as f:
        content = await file.read()
        f.write(content)

    # Process the file
    scanner = FolderScanner(db)
    pending = scanner.scan_for_new_files()

    # Find and process our file
    for p in pending:
        if p.path == file_path:
            result = scanner.import_file(p, brokerage=brokerage, fetch_prices=fetch_prices)
            return {
                "message": "File imported successfully" if result.success else "Import failed",
                "status": "success" if result.success else "error",
                "positions_imported": result.positions_imported,
                "error": result.error_message,
            }

    return {
        "message": "File saved but could not be processed (check column format)",
        "status": "error",
        "file_path": str(file_path),
    }


@router.get("/price-status")
def get_price_status(db: Database = Depends(get_db)):
    """Get status of price cache - freshness, last update times."""
    status = db.get_price_cache_status()
    return status


@router.post("/refresh-prices")
def refresh_prices(force: bool = False, db: Database = Depends(get_db)):
    """Refresh prices for all positions with stale data.

    Args:
        force: If True, refresh all prices regardless of staleness.
    """
    if force:
        # Get all tickers
        positions = db.get_all_positions()
        all_tickers = list({p.ticker for p in positions if p.ticker not in ("CASH", "CD")})
        stale_tickers = all_tickers
    else:
        stale_tickers = db.get_stale_tickers()

    if not stale_tickers:
        status = db.get_price_cache_status()
        return {
            "message": "All prices are up to date (less than 24 hours old)",
            "updated": 0,
            "all_fresh": True,
            "newest_update": status.get("newest_update"),
        }

    scanner = FolderScanner(db)
    scanner._fetch_and_update_prices(stale_tickers)

    status = db.get_price_cache_status()
    return {
        "message": f"Updated prices for {len(stale_tickers)} tickers",
        "updated": len(stale_tickers),
        "tickers": stale_tickers,
        "all_fresh": status.get("all_fresh", False),
        "newest_update": status.get("newest_update"),
    }


@router.get("/price-sources")
def get_price_source_status():
    """Get status of all configured price data sources."""
    from src.data.prices import PriceService

    price_service = PriceService()
    sources = price_service.get_source_status()

    return {
        "sources": sources,
        "total_sources": len(sources),
        "available_sources": sum(1 for s in sources if s["available"]),
        "message": "OK" if sources else "No price sources configured - add API keys to config.yaml",
    }


# ==================== New File Import API ====================

class ParsedPosition(BaseModel):
    """Position parsed from file."""
    ticker: str
    name: Optional[str] = None
    shares: Optional[float] = None
    price: Optional[float] = None
    cost_basis: Optional[float] = None
    is_fund: bool = False


class SuggestedAccount(BaseModel):
    """AI-suggested account for import."""
    id: Optional[str] = None
    name: str
    reason: str
    account_type: Optional[str] = None
    brokerage: Optional[str] = None


class ParseFileResponse(BaseModel):
    """Response from parsing a file."""
    positions: list[ParsedPosition]
    suggested_account: Optional[SuggestedAccount] = None
    detected_brokerage: Optional[str] = None
    row_count: int
    warnings: list[str] = []


class ImportPositionInput(BaseModel):
    """Position to import."""
    ticker: str
    name: Optional[str] = None
    shares: float
    price: Optional[float] = None
    cost_basis: Optional[float] = None
    is_fund: bool = False


class ImportPositionsRequest(BaseModel):
    """Request to import positions."""
    account_id: str
    positions: list[ImportPositionInput]
    replace_existing: bool = True


class ImportPositionsResponse(BaseModel):
    """Response from importing positions."""
    imported_count: int
    account_name: str
    message: str


def _detect_brokerage_from_filename(filename: str) -> Optional[str]:
    """Try to detect brokerage from filename."""
    filename_lower = filename.lower()

    if "schwab" in filename_lower:
        return "schwab"
    elif "fidelity" in filename_lower:
        return "fidelity"
    elif "vanguard" in filename_lower:
        return "vanguard"
    elif "etrade" in filename_lower or "e-trade" in filename_lower:
        return "etrade"
    elif "robinhood" in filename_lower:
        return "robinhood"
    elif "td" in filename_lower or "ameritrade" in filename_lower:
        return "td_ameritrade"
    elif "merrill" in filename_lower:
        return "merrill"
    elif "betterment" in filename_lower:
        return "betterment"
    elif "wealthfront" in filename_lower:
        return "wealthfront"

    return None


def _detect_account_type_from_filename(filename: str) -> Optional[str]:
    """Try to detect account type from filename."""
    filename_lower = filename.lower()

    # Check for account types in filename
    patterns = [
        (r"\broth.*ira\b", "roth_ira"),
        (r"\btraditional.*ira\b", "traditional_ira"),
        (r"\broth.*401k?\b", "roth_401k"),
        (r"\b401k?\b", "traditional_401k"),
        (r"\bira\b", "traditional_ira"),
        (r"\bhsa\b", "hsa"),
        (r"\b529\b", "529"),
        (r"\btaxable\b", "taxable"),
        (r"\bbrokerage\b", "taxable"),
        (r"\bindividual\b", "taxable"),
    ]

    for pattern, account_type in patterns:
        if re.search(pattern, filename_lower):
            return account_type

    return None


def _suggest_account_with_ai(
    filename: str,
    accounts: list,
    brokerage: Optional[str],
    account_type: Optional[str],
) -> Optional[SuggestedAccount]:
    """Try to suggest an account using AI or simple matching."""
    # First, try simple matching
    filename_lower = filename.lower()

    # Look for exact brokerage + account type match
    for account in accounts:
        acc_name_lower = account.name.lower()
        acc_brokerage = account.brokerage.lower() if account.brokerage else ""

        # Exact match: filename contains account name
        if account.name.lower() in filename_lower:
            return SuggestedAccount(
                id=account.id,
                name=account.name,
                reason="Filename matches account name",
            )

        # Match by brokerage
        if brokerage and brokerage.lower() == acc_brokerage:
            # If account type also matches
            if account_type and account.account_type == account_type:
                return SuggestedAccount(
                    id=account.id,
                    name=account.name,
                    reason=f"Matched brokerage ({brokerage}) and account type",
                )

    # If we have a brokerage match, return first matching account
    if brokerage:
        for account in accounts:
            if account.brokerage and brokerage.lower() == account.brokerage.lower():
                return SuggestedAccount(
                    id=account.id,
                    name=account.name,
                    reason=f"Matched brokerage: {brokerage}",
                )

    # Try Claude AI if available (optional enhancement)
    try:
        from src.services.secrets import get_anthropic_api_key
        api_key = get_anthropic_api_key()
        if api_key and accounts:
            import anthropic

            # Build account list for Claude
            account_list = "\n".join([
                f"- ID: {a.id}, Name: {a.name}, Type: {a.account_type}, Brokerage: {a.brokerage}"
                for a in accounts[:20]  # Limit to first 20 accounts
            ])

            client = anthropic.Anthropic(api_key=api_key)
            message = client.messages.create(
                model="claude-3-5-haiku-20241022",
                max_tokens=200,
                messages=[{
                    "role": "user",
                    "content": f"""Given this filename: "{filename}"
And these existing accounts:
{account_list}

Which account should this file be imported to? If you find a good match, respond with ONLY:
MATCH: <account_id>
REASON: <brief reason>

If no good match exists, respond with:
NO_MATCH
SUGGESTED_NAME: <suggested new account name>
SUGGESTED_TYPE: <account type like roth_ira, traditional_401k, taxable, etc>
SUGGESTED_BROKERAGE: <brokerage name>"""
                }]
            )

            response_text = message.content[0].text.strip()

            if response_text.startswith("MATCH:"):
                lines = response_text.split("\n")
                match_id = lines[0].replace("MATCH:", "").strip()
                reason = lines[1].replace("REASON:", "").strip() if len(lines) > 1 else "AI matched"

                # Find the account
                for account in accounts:
                    if account.id == match_id:
                        return SuggestedAccount(
                            id=account.id,
                            name=account.name,
                            reason=reason,
                        )

            elif "NO_MATCH" in response_text:
                # Parse suggestions for new account
                lines = response_text.split("\n")
                suggested_name = None
                suggested_type = None
                suggested_brokerage = None

                for line in lines:
                    if "SUGGESTED_NAME:" in line:
                        suggested_name = line.replace("SUGGESTED_NAME:", "").strip()
                    elif "SUGGESTED_TYPE:" in line:
                        suggested_type = line.replace("SUGGESTED_TYPE:", "").strip()
                    elif "SUGGESTED_BROKERAGE:" in line:
                        suggested_brokerage = line.replace("SUGGESTED_BROKERAGE:", "").strip()

                if suggested_name:
                    return SuggestedAccount(
                        id=None,
                        name=suggested_name,
                        reason="AI suggests creating new account",
                        account_type=suggested_type,
                        brokerage=suggested_brokerage,
                    )

    except Exception as e:
        logger.debug(f"AI suggestion not available: {e}")

    # No suggestion
    return None


@import_router.post("/parse", response_model=ParseFileResponse)
async def parse_file(
    file: UploadFile = File(...),
    db: Database = Depends(get_db),
):
    """
    Parse a brokerage export file and return positions for review.

    Uses AI to suggest which account to import to based on filename and content.
    """
    check_demo_mode_write()  # Prevent imports in demo mode

    import pandas as pd
    import io

    if not file.filename:
        raise HTTPException(status_code=400, detail="No filename provided")

    suffix = Path(file.filename).suffix.lower()
    if suffix not in [".csv", ".xlsx", ".xls"]:
        raise HTTPException(
            status_code=400,
            detail="Invalid file type. Supported: .csv, .xlsx, .xls",
        )

    try:
        # Read file content
        content = await file.read()

        # Detect brokerage from filename
        detected_brokerage = _detect_brokerage_from_filename(file.filename)
        detected_account_type = _detect_account_type_from_filename(file.filename)

        # Parse file
        if suffix in [".xlsx", ".xls"]:
            # For Excel files, try to find the right sheet
            excel_file = pd.ExcelFile(io.BytesIO(content))
            df = None

            for sheet in excel_file.sheet_names:
                temp_df = pd.read_excel(excel_file, sheet_name=sheet)
                # Look for sheets with ticker/symbol columns
                cols_lower = [str(c).lower() for c in temp_df.columns]
                if any(col in cols_lower for col in ["symbol", "ticker", "stock"]):
                    df = temp_df
                    break

            if df is None:
                # Just use first sheet
                df = pd.read_excel(io.BytesIO(content))
        else:
            # CSV parsing with Schwab format detection
            content_str = content.decode('utf-8', errors='ignore')
            if content_str.startswith('"Positions for account'):
                # Schwab format - skip header rows
                df = pd.read_csv(io.StringIO(content_str), skiprows=2)
                detected_brokerage = "schwab"
            else:
                df = pd.read_csv(io.StringIO(content_str))

        # Auto-detect columns
        scanner = FolderScanner(db)
        detected_columns = scanner._detect_columns(df)

        if "ticker" not in detected_columns:
            raise HTTPException(
                status_code=400,
                detail=f"Could not find ticker/symbol column. Columns found: {list(df.columns)}",
            )

        # Parse positions
        positions = []
        warnings = []

        for idx, row in df.iterrows():
            try:
                result = scanner._extract_position(row, detected_columns)
                if result:
                    ticker, shares, name, price, cost_basis, is_fund = result
                    positions.append(ParsedPosition(
                        ticker=ticker,
                        name=name if name != ticker else None,
                        shares=shares,
                        price=price if price > 0 else None,
                        cost_basis=cost_basis,
                        is_fund=is_fund,
                    ))
            except Exception as e:
                warnings.append(f"Row {idx + 2}: {str(e)}")

        if not positions:
            raise HTTPException(
                status_code=400,
                detail="No valid positions found in file. Check that the file has ticker and shares columns.",
            )

        # Get existing accounts for suggestion
        accounts = db.get_all_accounts()

        # Try to suggest an account
        suggested_account = _suggest_account_with_ai(
            file.filename,
            accounts,
            detected_brokerage,
            detected_account_type,
        )

        return ParseFileResponse(
            positions=positions,
            suggested_account=suggested_account,
            detected_brokerage=detected_brokerage,
            row_count=len(positions),
            warnings=warnings[:5],  # Limit warnings
        )

    except HTTPException:
        raise
    except Exception as e:
        logger.exception(f"Error parsing file: {e}")
        raise HTTPException(status_code=500, detail=f"Error parsing file: {str(e)}")


@import_router.post("/positions", response_model=ImportPositionsResponse)
async def import_positions(
    request: ImportPositionsRequest,
    db: Database = Depends(get_db),
):
    """
    Import positions to an account.

    If replace_existing is True, all existing positions in the account will be cleared first.
    """
    check_demo_mode_write()  # Prevent imports in demo mode

    # Get account
    account = db.get_account_by_id(request.account_id)
    if not account:
        raise HTTPException(status_code=404, detail="Account not found")

    try:
        # Clear existing positions if requested
        if request.replace_existing:
            cleared = db.clear_account_positions(request.account_id)
            if cleared > 0:
                logger.info(f"Cleared {cleared} existing positions from {account.name}")

        # Import positions
        imported_count = 0
        tickers_needing_prices = []

        for pos in request.positions:
            try:
                db.add_position(
                    account_id=request.account_id,
                    ticker=pos.ticker,
                    shares=pos.shares,
                    name=pos.name or pos.ticker,
                    cost_basis=pos.cost_basis,
                    current_price=pos.price,
                    is_fund=pos.is_fund,
                )
                imported_count += 1

                if not pos.price or pos.price <= 0:
                    tickers_needing_prices.append(pos.ticker)

            except Exception as e:
                logger.warning(f"Error adding position {pos.ticker}: {e}")

        # Fetch missing prices
        if tickers_needing_prices:
            scanner = FolderScanner(db)
            scanner._fetch_and_update_prices(list(set(tickers_needing_prices)))

        return ImportPositionsResponse(
            imported_count=imported_count,
            account_name=account.name,
            message=f"Successfully imported {imported_count} positions to {account.name}",
        )

    except Exception as e:
        logger.exception(f"Error importing positions: {e}")
        raise HTTPException(status_code=500, detail=f"Error importing positions: {str(e)}")
