"""Import management API endpoints."""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Any, Optional, cast
from pathlib import Path
import re
import logging
import difflib

from src.database import Database
from src.importers import FolderScanner
from src.models.position_types import is_updatable_position
from src.services.ai_config import CLAUDE_MODEL_HAIKU
from src.services.market_hours import is_market_open
from src.services.price_refresh_gate import (
    MARKET_CLOSED,
    evaluate_refresh_gate,
    record_refresh_pass,
)
from src.utils.paths import UnsafePathError, safe_join

router = APIRouter(prefix="/api/imports", tags=["imports"])
import_router = APIRouter(prefix="/api/import", tags=["import"])

logger = logging.getLogger(__name__)


def _find_similar_existing_file(directory: Path, filename: str) -> Optional[Path]:
    """Find a file with a similar name in the directory.

    Similarity is defined as:
    - Same prefix before date/random numbers
    - Example: 'Alex IRA-Positions-2026...' matches 'Alex IRA-Positions-2025...'
    """
    if not directory.exists():
        return None

    # Remove extension
    stem = Path(filename).stem

    # Regex to strip trailing date/timestamp/random digits
    # Matches -202X or -YYMMDD or just digits at end
    match = re.search(r'[-_ ]\d{4}[-_]?\d{2}[-_]?\d{2}', stem)
    if match:
        prefix = stem[:match.start()]
    else:
        # Fallback: try to strip just any trailing digits/dashes if no full date found
        # e.g. "MyAccount-123" -> "MyAccount"
        match_digits = re.search(r'[-_ ]\d+$', stem)
        if match_digits:
            prefix = stem[:match_digits.start()]
        else:
            prefix = stem

    # Too short to be safe (e.g. "A.csv")
    if len(prefix) < 3:
        prefix = stem

    best_match = None
    best_ratio = 0.0

    for file in directory.iterdir():
        if file.name == filename:
            continue
        if file.suffix.lower() not in ['.csv', '.xlsx', '.xls']:
            continue

        # Check if starts with prefix
        if file.stem.startswith(prefix):
            return file

        # Fallback: similarity ratio for cases where prefix logic fails
        ratio = difflib.SequenceMatcher(None, stem, file.stem).ratio()
        if ratio > 0.8: # High similarity threshold
             if ratio > best_ratio:
                 best_ratio = ratio
                 best_match = file

    return best_match


from src.api.dependencies import get_db  # noqa: E402  (public router dep)


def check_demo_mode_write() -> None:
    """Raise error if demo mode is enabled (prevents data pollution).

    Demo mode should be read-only with pre-generated data.
    Importing real data would pollute the demo database.
    Test mode bypasses this check to allow testing write operations.
    """
    import os
    from src.services.demo_mode import is_demo_mode

    # Allow writes in test mode even if demo mode is enabled
    if os.environ.get("PORTFOLIO_TEST_MODE", "").lower() == "true":
        return

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
            id=cast(str, h.id),
            file_name=cast(str, h.file_name),
            file_path=cast(str, h.file_path),
            account_type=cast(str, h.account_type),
            import_date=h.import_date.isoformat() if h.import_date else "",
            row_count=int(h.row_count) if h.row_count else None,
            status=cast(str, h.status or "unknown"),
            error_message=cast(str, h.error_message),
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
) -> dict[str, Any]:
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

    # Save to import folder. safe_join() rejects path-traversal payloads
    # (``../``, absolute paths, null bytes) so the resolved path is always a
    # direct descendant of ``data/imports/<account_type>/``.
    import_dir = Path("data/imports") / account_type
    import_dir.mkdir(parents=True, exist_ok=True)

    try:
        file_path = safe_join(import_dir, Path(file.filename).name)
    except UnsafePathError as exc:
        logger.warning("Rejected unsafe upload filename: %s", exc)
        raise HTTPException(status_code=400, detail="Invalid filename") from exc

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

    # Check for similar file and linked account
    similar_file = _find_similar_existing_file(import_dir, file.filename)
    target_account = None

    if similar_file:
        logger.info(f"Found similar file for {file.filename}: {similar_file.name}")
        # Try to find the account associated with this file
        target_account = db.get_account_from_active_import(similar_file.name)
        if target_account:
            logger.info(f"Found linked account for upload: {target_account.name} (ID: {target_account.id})")
            # Use the account's brokerage setting if available
            if target_account.brokerage and target_account.brokerage != "other":
                brokerage = cast(str, target_account.brokerage)

    pending = scanner.scan_for_new_files()

    # Find and process our file
    for p in pending:
        if p.path == file_path:
            # Pass target_account_id if we found one
            target_id: Optional[str] = cast(Optional[str], target_account.id) if target_account else None

            result = scanner.import_file(
                p,
                brokerage=brokerage,
                fetch_prices=fetch_prices,
                target_account_id=target_id,
            )
            return {
                "message": "File imported successfully" if result.success else "Import failed",
                "status": "success" if result.success else "error",
                "positions_imported": result.positions_imported,
                "error": result.error_message,
                "linked_account": target_account.name if target_account else None,
            }

    return {
        "message": "File saved but could not be processed (check column format)",
        "status": "error",
        "file_path": str(file_path),
    }


@router.get("/price-status")
def get_price_status(timezone: str = "UTC", db: Database = Depends(get_db)) -> dict[str, Any]:
    """Get status of price cache under market-aware freshness rules.

    When the market is open, a ticker is stale once its cache is older
    than 1 hour. When the market is closed nothing is due: the last
    fetched close is authoritative and stale_tickers reports 0.

    Tickers that have NEVER been cached are reported separately as
    ``missing_price_tickers`` — they have no last close, so they are
    excluded from ``stale_tickers`` but keep ``all_fresh`` honest (False).
    """
    market_open = is_market_open()
    if market_open:
        status = db.get_price_cache_status(max_age_hours=1)
    else:
        status = db.get_price_cache_status(max_age_hours=24)
        status["stale_tickers"] = 0
        status["all_fresh"] = True

    missing = db.get_never_fetched_tickers()
    status["missing_price_tickers"] = len(missing)
    if missing:
        status["all_fresh"] = False
        status["missing_tickers"] = missing

    decision = evaluate_refresh_gate(db)
    status["user_timezone"] = timezone
    status["market_open"] = market_open
    status["next_refresh_at"] = decision.next_refresh_at.isoformat() if decision.next_refresh_at else None
    return status


@router.post("/refresh-prices")
def refresh_prices(force: bool = False, db: Database = Depends(get_db)) -> dict[str, Any]:
    """Refresh prices for all positions with stale data.

    Market-gated: no upstream fetch when the market is closed, and at most
    one refresh pass per hour during the trading day (see
    src/services/price_refresh_gate.py). ``force`` bypasses the hourly cap
    and, while the market is closed, still fetches tickers that have no
    cached price at all (a just-imported ticker has no last close to show).

    Returns honest success / failure counts so the UI can decrement the
    "X stale" badge to the *actually-fresh* count, not the *attempted* count.

    Args:
        force: If True, refresh all prices regardless of staleness.
    """
    decision = evaluate_refresh_gate(db, force=force)

    if not decision.allowed:
        # An explicit force still fetches tickers that have NEVER been priced:
        # the market-closed rule assumes a last close exists to fall back on,
        # and for a just-imported ticker that is false. Stale-but-cached
        # tickers remain gated (their last close is honest data).
        missing = db.get_never_fetched_tickers() if (
            force and decision.reason == MARKET_CLOSED
        ) else []
        if missing:
            scanner = FolderScanner(db)
            result = scanner._fetch_and_update_prices(missing, force=True)
            record_refresh_pass(db)
            success = result.get("success", [])
            failed = result.get("failed", [])
            return {
                "message": (
                    f"Markets closed: fetched {len(success)} ticker(s) with no "
                    "cached price; others current as of last close"
                ),
                "updated": len(success),
                "attempted": len(missing),
                "failed": len(failed),
                "failed_tickers": failed,
                "tickers": success,
                "all_fresh": not failed,
                "newest_update": None,
                "market_open": False,
                "next_refresh_at": decision.next_refresh_at.isoformat() if decision.next_refresh_at else None,
            }
        if decision.reason == MARKET_CLOSED:
            message = "Markets closed: prices current as of last close"
        else:
            message = "Prices refreshed within the last hour"
            if decision.next_refresh_at:
                message += f"; next refresh at {decision.next_refresh_at.isoformat()}"
        status = db.get_price_cache_status()
        return {
            "message": message,
            "updated": 0,
            "attempted": 0,
            "failed": 0,
            "failed_tickers": [],
            "tickers": [],
            "all_fresh": True,
            "newest_update": status.get("newest_update"),
            "market_open": decision.reason != MARKET_CLOSED,
            "next_refresh_at": decision.next_refresh_at.isoformat() if decision.next_refresh_at else None,
        }

    stale_tickers: list[str]
    if force:
        positions = db.get_all_positions()
        stale_tickers = list({
            cast(str, p.ticker) for p in positions
            if is_updatable_position(cast(Optional[str], p.position_type), cast(Optional[str], p.ticker))
        })
    else:
        stale_tickers = db.get_stale_tickers(max_age_hours=1)

    if not stale_tickers:
        status = db.get_price_cache_status()
        return {
            "message": "All prices are up to date",
            "updated": 0,
            "attempted": 0,
            "failed": 0,
            "failed_tickers": [],
            "all_fresh": True,
            "newest_update": status.get("newest_update"),
            "market_open": True,
            "next_refresh_at": decision.next_refresh_at.isoformat() if decision.next_refresh_at else None,
        }

    scanner = FolderScanner(db)
    # On an explicit force refresh, bypass the PriceService file cache so we
    # fetch live quotes — otherwise the cached (up to 4h old) value is returned
    # and the DB timestamp is re-stamped fresh over a stale price.
    result = scanner._fetch_and_update_prices(stale_tickers, force=force)
    record_refresh_pass(db)
    success = result.get("success", [])
    skipped = result.get("skipped", [])
    failed = result.get("failed", [])

    fresh_now = len(success) + len(skipped)
    status = db.get_price_cache_status()

    if failed:
        message = (
            f"Updated {fresh_now} of {len(stale_tickers)} tickers; "
            f"{len(failed)} failed (rate limit, delisted, or unknown)."
        )
    else:
        message = f"Updated prices for {fresh_now} tickers"

    return {
        "message": message,
        "updated": fresh_now,
        "attempted": len(stale_tickers),
        "failed": len(failed),
        "failed_tickers": failed,
        "tickers": success,
        "all_fresh": status.get("all_fresh", False),
        "newest_update": status.get("newest_update"),
        "market_open": True,
        "next_refresh_at": decision.next_refresh_at.isoformat() if decision.next_refresh_at else None,
    }


@router.get("/price-sources")
def get_price_source_status() -> dict[str, Any]:
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
    position_type: str = "equity"
    contract_multiplier: Optional[float] = None
    option_underlying: Optional[str] = None
    option_expiration: Optional[str] = None  # ISO date string
    option_strike: Optional[float] = None
    option_type: Optional[str] = None         # "C" or "P"


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
    position_type: str = "equity"
    contract_multiplier: Optional[float] = None
    option_underlying: Optional[str] = None
    option_expiration: Optional[str] = None  # ISO date string
    option_strike: Optional[float] = None
    option_type: Optional[str] = None         # "C" or "P"


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
    api_key: Optional[str] = None,
) -> Optional[SuggestedAccount]:
    """Try to suggest an account using AI or simple matching.

    Args:
        api_key: Optional explicit Claude API key. When provided, this is
            used directly for the AI suggestion step instead of the
            (nonexistent) `get_anthropic_api_key` DB-backed lookup below —
            this is the injection point for the stateless v2 API (see
            src/api/v2/imports.py), which resolves its key from the
            environment only.
    """
    # First, try simple matching
    filename_lower = filename.lower()

    # Look for exact brokerage + account type match
    for account in accounts:
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

    # NOTE: Removed brokerage-only matching as it caused false positives
    # (e.g., "John Doe Roth" file matching "Acme HYSA" just because both use same brokerage)
    # Let the AI handle ambiguous cases where only brokerage matches

    # Try Claude AI if available (optional enhancement)
    try:
        if api_key is None:
            from src.services.secrets import get_anthropic_api_key  # type: ignore[attr-defined]
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
                model=CLAUDE_MODEL_HAIKU,  # Use fast model for simple parsing tasks
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
) -> ParseFileResponse:
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
) -> ImportPositionsResponse:
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
                from datetime import datetime as _dt
                opt_exp = None
                if pos.option_expiration:
                    try:
                        opt_exp = _dt.fromisoformat(pos.option_expiration)
                    except ValueError:
                        pass
                db.upsert_position(
                    account_id=request.account_id,
                    ticker=pos.ticker,
                    shares=pos.shares,
                    name=pos.name or pos.ticker,
                    cost_basis=pos.cost_basis,
                    current_price=pos.price,
                    is_fund=pos.is_fund,
                    position_type=pos.position_type,
                    contract_multiplier=pos.contract_multiplier,
                    option_underlying=pos.option_underlying,
                    option_expiration=opt_exp,
                    option_strike=pos.option_strike,
                    option_type=pos.option_type,
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
            account_name=cast(str, account.name),
            message=f"Successfully imported {imported_count} positions to {account.name}",
        )

    except Exception as e:
        logger.exception(f"Error importing positions: {e}")
        raise HTTPException(status_code=500, detail=f"Error importing positions: {str(e)}")
