"""
FastAPI server for the investment portfolio system.

Provides a REST API and serves a web dashboard for managing and analyzing
your investment portfolio.
"""

import asyncio
import logging
import os
import time
import webbrowser
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import yaml
import uvicorn
from fastapi import Depends, FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse, JSONResponse, PlainTextResponse, Response
from starlette.middleware.base import BaseHTTPMiddleware

from src.middleware import RateLimitMiddleware, SecurityHeadersMiddleware
from src.api import (
    portfolio_router,
    imports_router,
    import_router,
    analysis_router,
    projections_router,
    settings_router,
    profiles_router,
    plugins_router,
    connections_router,
)
from src.api.budget import router as budget_router
from src.api.bank_statements import router as bank_statements_router
from src.api.commentary import router as commentary_router
from src.api.inference import router as inference_router
from src.api.tasks import router as tasks_router
from src.api.session import router as session_router
from src.api.entities import router as entities_router
from src.api.liabilities import router as liabilities_router
from src.api.smart_import import budget_router as smart_import_budget_router
from src.api.smart_import import router as smart_import_router
from src.api.dependencies import get_db
from src.liabilities.service import dashboard_block
from src.api.v2 import v2_router
from src.database import Database, get_profile_manager, get_database
from src.importers import FolderScanner
from src.services.price_refresh_gate import (
    catch_up_tickers,
    evaluate_refresh_gate,
    record_refresh_pass,
)
from src.services.session import is_multi_user_mode

logger = logging.getLogger(__name__)


def get_allowed_origins() -> list[str]:
    """
    Get allowed CORS origins based on environment.

    - In production (Heroku): finlity.net domains + localhost
    - In development: localhost only
    - Can be overridden via CORS_ALLOWED_ORIGINS env var
    """
    # Check for explicit configuration
    explicit_origins = os.environ.get("CORS_ALLOWED_ORIGINS")
    if explicit_origins:
        return [o.strip() for o in explicit_origins.split(",")]

    # Always allow localhost for development ease
    origins = [
        "http://localhost:8000",
        "http://localhost:8080",
        "http://127.0.0.1:8000",
        "http://127.0.0.1:8080",
        "http://localhost:3000",
    ]

    # Add production origins if hosted (Heroku or PRODUCTION env var)
    if os.environ.get("DYNO") or os.environ.get("PRODUCTION"):
        origins.extend([
            "https://app.finlity.net",
            "https://finlity.net",
            "https://www.finlity.net",
        ])

    return origins


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
        try:
            from src.services.demo_mode import get_demo_manager
            return str(get_demo_manager().demo_db_path)
        except Exception:
            # Fallback (should normally be handled by demo manager)
            config = load_config()
            return config.get("demo", {}).get("database", "data/demo/demo.db")

    # Check for active profile
    try:
        profile_manager = get_profile_manager()
        active_profile = profile_manager.get_active_profile()
        if active_profile:
            return str(profile_manager.get_profile_db_path(active_profile.id))
    except Exception:
        pass  # Fall back to default if profile system fails

    return "data/portfolio.db"


async def _background_bootstrap(demo_mode: bool) -> None:
    """Run heavy startup work off the hot path.

    Scanning imports, refreshing stale prices, and snapshotting portfolio
    value are expensive and network-bound. Running them inline in the
    FastAPI lifespan serialises them before the dyno becomes ready, which
    risks H20 timeouts on Heroku. Instead we kick them off after yield.
    """
    try:
        db = get_database()
        scanner = FolderScanner(db)

        if not demo_mode:
            pending = scanner.scan_for_new_files()
            if pending:
                logger.info("Importing %d new file(s)...", len(pending))
                results = await asyncio.to_thread(
                    scanner.process_all_pending, True
                )
                success_count = sum(1 for r in results if r.success)
                total_positions = sum(
                    r.positions_imported for r in results if r.success
                )
                logger.info(
                    "  Imported %d positions from %d file(s)",
                    total_positions,
                    success_count,
                )

        decision = evaluate_refresh_gate(db)
        if decision.allowed:
            stale_tickers = (
                catch_up_tickers(db, decision)
                if decision.catch_up_cutoff is not None
                else db.get_stale_tickers(max_age_hours=1)
            )
            if stale_tickers:
                logger.info("Refreshing %d stale price(s)...", len(stale_tickers))
                # Catch-up passes must bypass PriceService's file cache, or a
                # cached intraday quote gets stamped as the close.
                await asyncio.to_thread(
                    scanner._fetch_and_update_prices,
                    stale_tickers,
                    force=decision.catch_up_cutoff is not None,
                )
                record_refresh_pass(db)

        await asyncio.to_thread(db.take_snapshot)
    except Exception:  # noqa: BLE001 - background bootstrap must not crash app
        logger.exception("Background bootstrap failed")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events.

    Keeps the critical startup path minimal (under 1s on warm caches) so
    the dyno is ready to serve requests before Heroku's 30s H20 timeout.
    Non-critical work (import scanning, price refresh, snapshot) is
    dispatched as a background task.
    """
    from src.database import (
        check_database,
        create_seed_callback,
    )

    app.state.demo_mode = is_demo_mode()
    app.state.db_path = get_db_path()

    if app.state.demo_mode:
        print("*** DEMO MODE ENABLED ***")

    db_path = app.state.db_path
    db_status = check_database(db_path)

    print(f"Database status: {db_status.status.value}")
    if db_status.is_usable:
        print(
            f"  Loaded: {db_status.account_count} accounts, "
            f"{db_status.position_count} positions"
        )

    db = get_database()

    if db_status.needs_initialization:
        print("First-time setup: importing seed data...")
        seed_callback = create_seed_callback()
        seed_callback(db)

    if app.state.demo_mode:
        from src.services.demo_history import ensure_recent_demo_history
        from src.services.demo_mode import get_demo_manager
        if get_demo_manager().is_enabled:
            # Cosmetic demo data must never block startup.
            try:
                written = ensure_recent_demo_history(db)
                if written:
                    print(f"Demo history refreshed: {written} daily snapshots")
            except Exception:
                logger.exception("Demo history refresh failed; continuing startup")

    # Shared async HTTP client for any async code paths (e.g. streaming
    # LLM providers). Sync endpoints continue to use `requests` in the
    # threadpool FastAPI assigns to them.
    import httpx
    app.state.http = httpx.AsyncClient(
        timeout=httpx.Timeout(10.0, connect=5.0),
        follow_redirects=True,
    )

    bootstrap_task = asyncio.create_task(
        _background_bootstrap(app.state.demo_mode)
    )
    app.state.bootstrap_task = bootstrap_task

    yield

    bootstrap_task.cancel()
    try:
        await bootstrap_task
    except (asyncio.CancelledError, Exception):  # noqa: BLE001
        pass

    await app.state.http.aclose()


app = FastAPI(
    title="Investment Portfolio API",
    description="API for managing and analyzing investment portfolios",
    version="1.0.0",
    lifespan=lifespan,
)

# Add CORS middleware with environment-based origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=get_allowed_origins(),
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
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

# Attach OWASP-recommended security headers (HSTS only on HTTPS).
app.add_middleware(SecurityHeadersMiddleware)

# Add rate limiting middleware for AI endpoints
# Only active when RATE_LIMIT_ENABLED=true and valid RATE_LIMIT_SECRET_KEY is set
app.add_middleware(RateLimitMiddleware)


# Global exception handlers: keep stack traces in logs, out of client responses.
@app.exception_handler(ValueError)
async def _value_error_handler(_request: Request, exc: ValueError):
    return JSONResponse(status_code=400, content={"detail": str(exc)})


@app.exception_handler(PermissionError)
async def _permission_error_handler(_request: Request, exc: PermissionError):
    return JSONResponse(status_code=403, content={"detail": "Forbidden"})


@app.exception_handler(FileNotFoundError)
async def _not_found_handler(_request: Request, exc: FileNotFoundError):
    return JSONResponse(status_code=404, content={"detail": "Not found"})


@app.exception_handler(Exception)
async def _unhandled_exception_handler(request: Request, exc: Exception):
    logger.exception(
        "Unhandled exception on %s %s", request.method, request.url.path
    )
    return JSONResponse(status_code=500, content={"detail": "Internal server error"})

# Add session middleware for multi-user deployments
# Only active when running on Heroku (DYNO), MULTI_USER_MODE=true, or PROTECT_DEMO_DATA=true
if is_multi_user_mode():
    from src.middleware.session import SessionMiddleware
    app.add_middleware(SessionMiddleware)
    print("*** MULTI-USER MODE: Session isolation and request signing enabled ***")

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
app.include_router(bank_statements_router)
app.include_router(commentary_router)
app.include_router(inference_router)
app.include_router(tasks_router)
app.include_router(session_router)
app.include_router(entities_router)
app.include_router(liabilities_router)
app.include_router(smart_import_router)
app.include_router(smart_import_budget_router)
app.include_router(connections_router)
app.include_router(v2_router)

# Serve static files (web dashboard)
web_dir = Path(__file__).parent / "web"
if web_dir.exists():
    app.mount("/static", StaticFiles(directory=str(web_dir)), name="static")


# Cache the build version at startup for cache busting
_build_version = str(int(time.time()))


@app.get("/")
async def serve_dashboard():
    """Serve the main dashboard with cache-busted JS reference."""
    index_path = web_dir / "index.html"
    if index_path.exists():
        try:
            # Read HTML and inject cache-busting version
            html_content = index_path.read_text(encoding="utf-8")
            original_content = html_content
            html_content = html_content.replace(
                'src="/static/dist/app.js"',
                f'src="/static/dist/app.js?v={_build_version}"',
            )
            html_content = html_content.replace(
                'href="/static/style.css"',
                f'href="/static/style.css?v={_build_version}"',
            )
            # Warn if cache-busting replacement didn't match
            if html_content == original_content:
                logger.warning(
                    "Cache-busting replacement failed - pattern not found in index.html"
                )
            return HTMLResponse(content=html_content)
        except (OSError, UnicodeDecodeError) as e:
            logger.error(f"Error reading index.html: {e}")
            return HTMLResponse(
                content="<h1>Error loading dashboard</h1>",
                status_code=500,
            )
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


# ---------------------------------------------------------------------------
# Bot-friendly endpoints: robots.txt, sitemap.xml, security.txt
# These must be registered BEFORE any catch-all route (there is none today,
# but keeping them explicit makes the contract visible). They return plain
# text/XML with the correct content types so crawlers get real directives
# instead of the SPA fallback HTML.
# ---------------------------------------------------------------------------

_ROBOTS_TXT = """User-agent: *
Allow: /
Disallow: /api/
Disallow: /static/
Disallow: /docs
Disallow: /redoc
Disallow: /openapi.json

# API endpoints are for the app itself, not for indexing.
# The dashboard is a private tool; allow bots to see the lander page only.

Sitemap: https://app.finlity.net/sitemap.xml
"""

_SITEMAP_XML = """<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://app.finlity.net/</loc>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <url>
    <loc>https://www.finlity.net/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.9</priority>
  </url>
</urlset>
"""

_SECURITY_TXT = """Contact: mailto:feedback@finlity.net
Expires: 2027-08-05T00:00:00.000Z
Preferred-Languages: en
Canonical: https://app.finlity.net/.well-known/security.txt
"""


@app.get("/robots.txt", include_in_schema=False)
async def robots_txt() -> Response:
    """Serve robots.txt for search engine crawlers."""
    return PlainTextResponse(_ROBOTS_TXT, media_type="text/plain")


@app.get("/sitemap.xml", include_in_schema=False)
async def sitemap_xml() -> Response:
    """Serve sitemap.xml for search engine crawlers."""
    return Response(content=_SITEMAP_XML, media_type="application/xml")


@app.get("/.well-known/security.txt", include_in_schema=False)
@app.get("/security.txt", include_in_schema=False)
async def security_txt() -> Response:
    """Serve security.txt per RFC 9116 (security contact)."""
    return PlainTextResponse(_SECURITY_TXT, media_type="text/plain")


@app.get("/api/dashboard/data")
async def get_dashboard_data(view_id: str = None, db: Database = Depends(get_db)):
    """Get all data needed for the dashboard in a single request.

    Args:
        view_id: Optional portfolio view ID to filter by. If not provided,
                 returns data for all accounts.
    """
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

    previous_closes = db.get_previous_closes()

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
            market_value = pos.market_value

        pos_type = pos.position_type or "equity"
        is_opt = pos_type == "option"
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
            "position_type": pos_type,
            "interest_rate": pos.interest_rate,
            "purchase_date": pos.purchase_date.isoformat() if pos.purchase_date else None,
            "maturity_date": pos.maturity_date.isoformat() if pos.maturity_date else None,
            "option_underlying": pos.option_underlying if is_opt else None,
            "option_expiration": pos.option_expiration.isoformat() if is_opt and pos.option_expiration else None,
            "option_strike": pos.option_strike if is_opt else None,
            "option_type": pos.option_type if is_opt else None,
            "contract_multiplier": pos.contract_multiplier if is_opt else None,
            "contracts": pos.shares if is_opt else None,
            "premium": pos.current_price if is_opt else None,
            "previous_close": previous_closes.get(pos.ticker),
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

    summary: dict[str, Any] = {
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
    # Fetch 365 days to support full year time range selector
    snapshots = db.get_snapshots(limit=365)
    history = [
        {
            "date": s.snapshot_date.isoformat() if s.snapshot_date else "",
            "total": s.total_value,
            "retirement": s.retirement_value,
            "taxable": s.taxable_value,
        }
        for s in reversed(snapshots)
    ]

    # Liabilities are household-wide, so they join only the unfiltered response. A failure
    # here must not take the dashboard down: fall back to the pre-liabilities payload.
    # Log the exception type only (a traceback can carry SQL parameters, i.e. money).
    try:
        block = dashboard_block(
            db, filtered=bool(filter_account_ids), history_dates=[str(h["date"]) for h in history if h["date"]]
        )
        block_summary = block["summary"]
        extra: dict[str, Any] = {"liabilities_included": block_summary["liabilities_included"]}
        history_extra: list[dict[str, Any]] = []
        if block_summary["liabilities_included"]:
            owed_total = float(block_summary["liabilities_total"])
            extra["liabilities_total"] = block_summary["liabilities_total"]
            extra["net_worth"] = round(total_value - owed_total, 2)
            extra["liabilities"] = block_summary["liabilities"]
            for item in history:
                owed = block["history"].get(item["date"], 0.0)
                history_extra.append({"liabilities": owed, "net_worth": round((item["total"] or 0) - owed, 2)})
    except Exception as exc:
        logger.error("dashboard liabilities block failed: %s", type(exc).__name__)
        extra = {"liabilities_included": False}
        history_extra = []
    summary.update(extra)
    for item, more in zip(history, history_extra):
        item.update(more)

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

    uvicorn_kwargs: dict = {
        "host": args.host,
        "port": args.port,
        "reload": args.reload,
    }

    # Production-tuned config when running on a Heroku dyno. These options are
    # incompatible with --reload so they only apply to non-reload runs.
    if os.environ.get("DYNO") and not args.reload:
        uvicorn_kwargs.update({
            "loop": "uvloop",
            "http": "httptools",
            "timeout_keep_alive": 65,
            "timeout_graceful_shutdown": 30,
            "server_header": False,
            "date_header": False,
            "proxy_headers": True,
            "forwarded_allow_ips": "*",
        })

    uvicorn.run("src.main:app", **uvicorn_kwargs)


if __name__ == "__main__":
    main()