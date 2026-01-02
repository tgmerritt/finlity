"""
FastAPI server for the investment portfolio system.

Provides a REST API and serves a web dashboard for managing and analyzing
your investment portfolio.
"""

import os
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path

import yaml
import uvicorn
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from starlette.middleware.base import BaseHTTPMiddleware

from src.api import (
    portfolio_router,
    imports_router,
    import_router,
    analysis_router,
    projections_router,
    settings_router,
    profiles_router,
    plugins_router,
)
from src.api.budget import router as budget_router
from src.api.commentary import router as commentary_router
from src.api.tasks import router as tasks_router
from src.database import get_profile_manager, get_database
from src.importers import FolderScanner


def load_config():
    """Load configuration from config.yaml."""
    config_path = Path("config.yaml")
    if config_path.exists():
        with open(config_path) as f:
            return yaml.safe_load(f)
    return {}


def is_demo_mode():
    """Check if demo mode is enabled via env var, demo manager, or config."""
    # Environment variable takes precedence (set by CLI)
    env_demo = os.environ.get("PORTFOLIO_DEMO_MODE")
    if env_demo is not None:
        return env_demo.lower() == "true"

    # Check the demo mode manager (dynamic state) - this is the source of truth
    # once the user has interacted with demo mode via the UI
    try:
        from src.services.demo_mode import get_demo_manager
        demo_manager = get_demo_manager()
        # Always use the demo manager's state - don't fall back to config
        return demo_manager.is_enabled
    except Exception:
        pass

    # Fall back to config only if demo manager fails to load
    config = load_config()
    return config.get("demo", {}).get("enabled", False)


def get_db_path():
    """Get the database path based on demo mode or active profile."""
    if is_demo_mode():
        config = load_config()
        demo_db = config.get("demo", {}).get("database", "data/demo/demo.db")
        return demo_db

    # Check for active profile
    try:
        profile_manager = get_profile_manager()
        active_profile = profile_manager.get_active_profile()
        if active_profile:
            return str(profile_manager.get_profile_db_path(active_profile.id))
    except Exception:
        pass  # Fall back to default if profile system fails

    return "data/portfolio.db"


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    from src.database import (
        check_database,
        create_seed_callback,
    )

    # Store demo mode status in app state
    app.state.demo_mode = is_demo_mode()
    app.state.db_path = get_db_path()

    if app.state.demo_mode:
        print("*** DEMO MODE ENABLED ***")

    # Check database status before loading
    db_path = app.state.db_path
    db_status = check_database(db_path)

    # Log database status (no PII - just counts and status)
    print(f"Database status: {db_status.status.value}")
    if db_status.is_usable:
        print(f"  Loaded: {db_status.account_count} accounts, {db_status.position_count} positions")

    # Get database through profile manager (handles lifecycle automatically)
    # The profile manager now uses DatabaseManager internally
    db = get_database()

    # If this is a new/empty database, seed with data from CSV/YAML
    if db_status.needs_initialization:
        print("First-time setup: importing seed data...")
        seed_callback = create_seed_callback()
        seed_callback(db)

    # Scan for new imports on startup (incremental imports, not seed data)
    # Skip in demo mode to prevent real data from contaminating the demo database
    scanner = FolderScanner(db)
    if not app.state.demo_mode:
        pending = scanner.scan_for_new_files()
        if pending:
            print(f"Importing {len(pending)} new file(s)...")
            results = scanner.process_all_pending(fetch_prices=True)
            success_count = sum(1 for r in results if r.success)
            total_positions = sum(r.positions_imported for r in results if r.success)
            print(f"  Imported {total_positions} positions from {success_count} file(s)")

    # Refresh stale prices (>24 hours old) on startup
    stale_tickers = db.get_stale_tickers()
    if stale_tickers:
        print(f"Refreshing {len(stale_tickers)} stale price(s)...")
        scanner._fetch_and_update_prices(stale_tickers)

    # Take a snapshot (don't log actual portfolio value - that's sensitive)
    db.take_snapshot()

    yield

    # Cleanup (nothing needed currently)


app = FastAPI(
    title="Investment Portfolio API",
    description="API for managing and analyzing investment portfolios",
    version="1.0.0",
    lifespan=lifespan,
)

# Add CORS middleware
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Add no-cache middleware for API routes (prevents browser caching)
class NoCacheMiddleware(BaseHTTPMiddleware):
    """Add no-cache headers to API responses to prevent stale data on demo mode toggle."""

    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        # Only add no-cache to API routes, not static files
        if request.url.path.startswith("/api/"):
            response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
            response.headers["Pragma"] = "no-cache"
            response.headers["Expires"] = "0"
        return response


app.add_middleware(NoCacheMiddleware)

# Include API routers
app.include_router(portfolio_router)
app.include_router(imports_router)
app.include_router(import_router)
app.include_router(analysis_router)
app.include_router(projections_router)
app.include_router(settings_router)
app.include_router(profiles_router)
app.include_router(plugins_router)
app.include_router(budget_router)
app.include_router(commentary_router)
app.include_router(tasks_router)

# Serve static files (web dashboard)
web_dir = Path(__file__).parent / "web"
if web_dir.exists():
    app.mount("/static", StaticFiles(directory=str(web_dir)), name="static")


@app.get("/")
async def serve_dashboard():
    """Serve the main dashboard."""
    index_path = web_dir / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {
        "message": "Investment Portfolio API",
        "docs": "/docs",
        "dashboard": "Dashboard not found. Create src/web/index.html",
    }


@app.get("/health")
async def health_check():
    """Health check endpoint."""
    db = get_database()
    summary = db.get_portfolio_summary()
    return {
        "status": "healthy",
        "portfolio_value": summary["total_value"],
        "accounts": summary["account_count"],
        "positions": summary["position_count"],
        "demo_mode": is_demo_mode(),
    }


@app.get("/api/dashboard/data")
async def get_dashboard_data(view_id: str = None):
    """Get all data needed for the dashboard in a single request.

    Args:
        view_id: Optional portfolio view ID to filter by. If not provided,
                 returns data for all accounts.
    """
    db = get_database()

    # Get all accounts for reference
    all_accounts = {a.id: a for a in db.get_all_accounts()}

    # Determine which account IDs to include based on view
    filter_account_ids = None
    if view_id:
        view = db.get_view_by_id(view_id)
        if view:
            filter_account_ids = set(view.get_account_ids())

    # Get positions (filtered by view if specified)
    positions = []
    total_value = 0
    total_cost_basis = 0
    retirement_value = 0
    taxable_value = 0

    for pos in db.get_all_positions():
        # Filter by view if specified
        if filter_account_ids and pos.account_id not in filter_account_ids:
            continue

        account = all_accounts.get(pos.account_id)

        # Calculate value including accrued interest for CDs/bonds/cash with APY
        accrued_value = db.calculate_accrued_value(pos)
        if pos.interest_rate and pos.interest_rate > 0:
            market_value = accrued_value
        else:
            market_value = (pos.shares * pos.current_price) if pos.current_price else 0

        positions.append({
            "id": pos.id,
            "ticker": pos.ticker,
            "name": pos.name,
            "shares": pos.shares,
            "price": pos.current_price,
            "value": market_value,
            "accrued_value": accrued_value if pos.interest_rate else None,
            "cost_basis": pos.cost_basis,
            "account": account.name if account else "Unknown",
            "account_type": account.account_type if account else "unknown",
            "is_fund": pos.is_fund,
            "position_type": pos.position_type or "equity",
            "interest_rate": pos.interest_rate,
            "purchase_date": pos.purchase_date.isoformat() if pos.purchase_date else None,
            "maturity_date": pos.maturity_date.isoformat() if pos.maturity_date else None,
        })

        # Accumulate totals
        total_value += market_value
        if pos.cost_basis:
            total_cost_basis += pos.cost_basis
        if account:
            if account.is_retirement:
                retirement_value += market_value
            else:
                taxable_value += market_value

    # Build filtered summary
    filtered_accounts = []
    for acc_id, account in all_accounts.items():
        if filter_account_ids and acc_id not in filter_account_ids:
            continue
        acc_positions = [p for p in positions if p["account"] == account.name]
        acc_value = sum(p["value"] for p in acc_positions)
        acc_cost = sum(p["cost_basis"] for p in acc_positions if p["cost_basis"])
        filtered_accounts.append({
            "id": acc_id,
            "name": account.name,
            "account_type": account.account_type,
            "display_type": account.display_type,
            "brokerage": account.brokerage,
            "value": acc_value,
            "cost_basis": acc_cost,
            "position_count": len(acc_positions),
            "is_retirement": account.is_retirement,
        })

    summary = {
        "total_value": total_value,
        "total_cost_basis": total_cost_basis if total_cost_basis else None,
        "total_gain_loss": (total_value - total_cost_basis) if total_cost_basis else None,
        "retirement_value": retirement_value,
        "taxable_value": taxable_value,
        "account_count": len(filtered_accounts),
        "position_count": len(positions),
        "accounts": filtered_accounts,
    }

    # Get recent snapshots for charts (these are not filtered by view)
    snapshots = db.get_snapshots(limit=90)
    history = [
        {
            "date": s.snapshot_date.isoformat() if s.snapshot_date else "",
            "total": s.total_value,
            "retirement": s.retirement_value,
            "taxable": s.taxable_value,
        }
        for s in reversed(snapshots)
    ]

    # Import history
    imports = db.get_import_history(limit=10)
    import_history = [
        {
            "file": h.file_name,
            "date": h.import_date.isoformat() if h.import_date else "",
            "account_type": h.account_type,
            "status": h.status,
        }
        for h in imports
    ]

    return {
        "summary": summary,
        "positions": positions,
        "history": history,
        "imports": import_history,
        "view_id": view_id,
        "demo_mode": is_demo_mode(),
    }


def reset_database_command():
    """Reset the database (delete all data)."""
    print("\n" + "=" * 50)
    print("DATABASE RESET")
    print("=" * 50)
    print("\nWARNING: This will DELETE ALL DATA in the database!")
    print("This includes:")
    print("  - All accounts")
    print("  - All positions")
    print("  - All import history")
    print("  - All snapshots")
    print("  - All triggers")
    print("  - All settings")
    print("\nThis action CANNOT be undone.")
    print()

    confirm = input("Type 'DELETE ALL DATA' to confirm: ")
    if confirm != "DELETE ALL DATA":
        print("\nAborted. Database was NOT reset.")
        return

    print("\nResetting database...")
    db = get_database()
    db.reset_database()
    print("Database has been reset. All data has been deleted.")
    print("The database schema has been recreated.\n")


def export_database_command(path: str):
    """Export database to JSON file."""
    print(f"\nExporting database to: {path}")
    db = get_database()
    data = db.export_database(path)
    print(f"Exported {len(data.get('accounts', []))} accounts")
    print(f"Exported {len(data.get('positions', []))} positions")
    print(f"Exported {len(data.get('triggers', []))} triggers")
    print(f"\nExport complete: {path}\n")


def import_database_command(path: str):
    """Import database from JSON file."""
    print(f"\nImporting database from: {path}")
    print("\nWARNING: This will REPLACE all existing data!")

    confirm = input("Type 'IMPORT' to confirm: ")
    if confirm != "IMPORT":
        print("\nAborted. Database was NOT modified.")
        return

    db = get_database()
    result = db.import_database(path)
    print(f"Imported {result.get('accounts', 0)} accounts")
    print(f"Imported {result.get('positions', 0)} positions")
    print("\nImport complete.\n")


def check_cd_maturities_command():
    """Check for matured CDs and convert them to cash."""
    print("\nChecking for matured CDs...")
    db = get_database()

    # Check and convert matured CDs
    matured = db.check_cd_maturities()
    if matured:
        print(f"\nConverted {len(matured)} matured CD(s) to cash:")
        for cd in matured:
            print(f"  - {cd.name}: ${cd.current_price:,.2f}")
    else:
        print("No CDs have matured.")

    # Show upcoming maturities
    upcoming = db.get_upcoming_cd_maturities(days=90)
    if upcoming:
        print("\nUpcoming maturities in the next 90 days:")
        for cd in upcoming:
            print(f"  - {cd.name}: ${cd.current_price:,.2f} (matures {cd.maturity_date.date() if cd.maturity_date else 'Unknown'})")
    print()


def create_folders_command():
    """Create import folders for all account types."""
    print("\nCreating import folders for all account types...")
    created = FolderScanner.ensure_all_default_folders()
    if created:
        print(f"Created {len(created)} new folders:")
        for folder in created:
            print(f"  - {folder}")
    else:
        print("All folders already exist.")
    print()


def main():
    """Run the server or execute management commands."""
    import argparse

    parser = argparse.ArgumentParser(
        description="Investment Portfolio Server",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Management Commands:
  --reset-database    Delete all data and recreate database
  --export-db PATH    Export database to JSON file
  --import-db PATH    Import database from JSON file
  --check-cds         Check for matured CDs
  --create-folders    Create import folders for all account types

Examples:
  python -m src.main                      # Start the server
  python -m src.main --reset-database     # Reset the database
  python -m src.main --export-db backup.json  # Export database
        """
    )
    parser.add_argument("--port", type=int, default=8000, help="Port to run on")
    parser.add_argument("--host", type=str, default="127.0.0.1", help="Host to bind to")
    parser.add_argument("--no-browser", action="store_true", help="Don't open browser")
    parser.add_argument("--reload", action="store_true", help="Enable auto-reload")
    parser.add_argument("--demo", action="store_true",
                        help="Run in demo mode with fake portfolio data")

    # Management commands
    parser.add_argument("--reset-database", action="store_true",
                        help="Delete all data and recreate database schema")
    parser.add_argument("--export-db", type=str, metavar="PATH",
                        help="Export database to JSON file")
    parser.add_argument("--import-db", type=str, metavar="PATH",
                        help="Import database from JSON file")
    parser.add_argument("--check-cds", action="store_true",
                        help="Check for matured CDs and convert to cash")
    parser.add_argument("--create-folders", action="store_true",
                        help="Create import folders for all account types")

    args = parser.parse_args()

    # Handle management commands
    if args.reset_database:
        reset_database_command()
        return

    if args.export_db:
        export_database_command(args.export_db)
        return

    if args.import_db:
        import_database_command(args.import_db)
        return

    if args.check_cds:
        check_cd_maturities_command()
        return

    if args.create_folders:
        create_folders_command()
        return

    # Set demo mode environment variable if CLI flag is set
    if args.demo:
        os.environ["PORTFOLIO_DEMO_MODE"] = "true"

    # Check actual demo mode status
    demo_mode = is_demo_mode()

    # Default: run server
    url = f"http://{args.host}:{args.port}"
    print(f"\n{'='*50}")
    if demo_mode:
        print("Investment Portfolio Dashboard [DEMO MODE]")
    else:
        print("Investment Portfolio Dashboard")
    print(f"{'='*50}")
    print(f"\nStarting server at: {url}")
    print(f"API documentation: {url}/docs")
    if demo_mode:
        print("\n*** DEMO MODE: Using fake portfolio data ***")
        print(f"    Database: {get_db_path()}")
    print("\nPress Ctrl+C to stop")
    print(f"{'='*50}\n")

    # Open browser
    if not args.no_browser:
        webbrowser.open(url)

    uvicorn.run(
        "src.main:app",
        host=args.host,
        port=args.port,
        reload=args.reload,
    )


if __name__ == "__main__":
    main()
