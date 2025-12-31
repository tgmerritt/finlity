"""Import management API endpoints."""

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from typing import Optional
from pathlib import Path
import shutil
import tempfile

from src.database import Database
from src.importers import FolderScanner

router = APIRouter(prefix="/api/imports", tags=["imports"])


def get_db() -> Database:
    """Dependency to get database instance."""
    return Database()


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
