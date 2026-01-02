# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Important: Prefer Docker Commands

**When executing commands, prefer running them inside the Docker container** rather than on the host machine. The application runs in Docker and all Python/pip commands should use `docker exec`:

```bash
# PREFERRED: Run commands inside container
docker exec -it portfolio-analyzer python -m src.main --check-cds
docker exec -it portfolio-analyzer pip install <package>
docker exec -it portfolio-analyzer python scripts/generate_demo.py

# NOT PREFERRED: Running directly on host (unless Docker is unavailable)
python -m src.main --check-cds
```

## Docker Deployment

The application runs in Docker for easy deployment:

```bash
# Build and run with docker compose (recommended)
docker compose up -d

# Development mode with hot reload (source code mounted)
docker compose --profile dev up portfolio-dev

# Or build and run manually
docker build -t portfolio-analyzer .
docker run -d -p 8000:8000 -v $(pwd)/data:/app/data portfolio-analyzer

# Generate demo data (via UI button in Settings, or CLI)
docker exec -it portfolio-analyzer python scripts/generate_demo.py

# Run in demo mode
docker run -d -p 8000:8000 -e PORTFOLIO_DEMO_MODE=true portfolio-analyzer

# Demo data can also be generated via API:
# POST http://localhost:8000/api/settings/demo/generate

# Rebuild after code changes (production mode)
docker compose down && docker compose build && docker compose up -d

# View logs
docker compose logs -f

# Shell into container
docker exec -it portfolio-analyzer /bin/bash
```

**Development Mode:** Use `docker compose --profile dev up portfolio-dev` to mount the `src/` directory. Changes to Python files will auto-reload, and changes to HTML/CSS/JS files take effect on browser refresh.

## Security Considerations

**IMPORTANT**: This project handles sensitive financial data. When making changes:
- Never commit API keys, database files, or CSV exports
- Never log or print account names, balances, or personal identifiers
- All user data must remain local - no external transmission except optional Claude API
- Check `.gitignore` before committing new file types
- Test with sample data, not real financial information

## Project Overview

Investment portfolio tracking and analysis system with:
- **File-based imports** - CSV/Excel from brokerage exports auto-detected and imported (plus drag-drop with AI account detection)
- **SQLite persistence** - Accounts, positions, triggers, settings stored locally
- **Multi-account support** - Retirement, taxable, 529, HYSA, custom account types
- **Multi-profile system** - Separate databases for financial advisors managing multiple clients
- **Cash & CD tracking** - Track uninvested cash and CDs with maturity dates and APY
- **Real estate tracking** - Track property values (home, rental, land)
- **Allocation triggers** - User-configurable alerts for portfolio conditions
- **Claude API integration** - Optional fund metadata enrichment
- **Year-by-year withdrawal projections** - Detailed retirement planning tables
- **Plugin system** - Extensible importers, analyzers, and dashboard widgets
- **Dynamic demo mode** - Toggle between real/demo data without server restart
- **REST API + Web Dashboard** - FastAPI backend with interactive dashboard

## Common Commands

**Prefer running commands inside Docker** (see "Important: Prefer Docker Commands" above).

```bash
# Docker commands (PREFERRED)
docker exec -it portfolio-analyzer python -m src.main --check-cds
docker exec -it portfolio-analyzer python -m src.main --export-db /app/data/backup.json
docker exec -it portfolio-analyzer python -m src.main --import-db /app/data/backup.json
docker exec -it portfolio-analyzer python -m src.main --create-folders
docker exec -it portfolio-analyzer python scripts/generate_demo.py

# Local setup (only if not using Docker)
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Start the server locally (opens browser automatically)
python -m src.main

# Server options (local)
python -m src.main --port 8000        # Custom port
python -m src.main --no-browser       # Don't open browser
python -m src.main --reload           # Development mode with auto-reload

# Database management (local)
python -m src.main --reset-database   # Delete all data (requires confirmation)
python -m src.main --export-db backup.json  # Backup to JSON
python -m src.main --import-db backup.json  # Restore from backup
python -m src.main --check-cds        # Check for matured CDs
python -m src.main --create-folders   # Create all import folders
```

## Importing Data

1. Create folders: `docker exec -it portfolio-analyzer python -m src.main --create-folders`
2. Drop brokerage export files into `data/imports/{account_type}/`:
   - `roth_ira/`, `traditional_ira/`, `traditional_401k/`, `roth_401k/`
   - `taxable/`, `hsa/`, `pension/`
   - `529/`, `hysa/`, `treasury_direct/`, `checking/`, `savings/`
   - `custom_*/` - For custom account types
3. Start or refresh dashboard - files auto-imported on startup

SHA256 hashing prevents duplicate imports.

## Architecture

### Data Flow
1. **Import** → CSV/Excel dropped in `data/imports/` subfolders
2. **Database** → SQLite (`data/portfolio.db`) stores all data
3. **API** → FastAPI provides REST endpoints
4. **Dashboard** → Vanilla JS + Plotly.js served by FastAPI
5. **Analysis** → Risk metrics, allocation, triggers, Monte Carlo

### Database Lifecycle (DatabaseManager)

The database is the **SOURCE OF TRUTH** once it exists and is valid. CSV/YAML files are only used for first-time initialization (seed data).

**Startup Flow:**
```
App Start → Does DB exist? → Yes → Is DB valid? → Yes → USE AS SOURCE OF TRUTH
                                                → No  → Backup corrupt + re-initialize
                          → No  → FIRST-TIME INIT from CSV/YAML seed data
```

**Key Classes:**
- `DatabaseManager`: Handles lifecycle (existence, integrity, initialization, recovery)
- `SeedLoader`: Loads initial data from CSV/YAML for first-time setup
- `check_database(path)`: Quick status check for any database file

**Usage:**
```python
from src.database import check_database, DatabaseManager

# Check status
result = check_database("data/databases/default/portfolio.db")
if result.is_usable:
    db = DatabaseManager(path).get_database()  # Use as source of truth
elif result.needs_initialization:
    db = DatabaseManager(path).initialize()     # First-time setup
elif result.needs_recovery:
    db = DatabaseManager(path).recover()        # Backup + re-initialize
```

### Profile-Aware Database
- **IMPORTANT**: All API endpoints MUST use `get_database()` from `src.database` to get a profile-aware database instance
- Never use `Database()` directly - this creates a connection to the wrong database file
- Each profile has its own SQLite database in `data/databases/{profile_id}/portfolio.db`
- The active profile is determined by the `get_profile_manager().get_active_profile()` method
- ProfileManager now uses DatabaseManager internally for proper lifecycle handling

### Data Loading Pattern
- **Current pattern**: Vanilla JS loads fresh data on each tab switch (no client-side caching)
- **Rationale**: This is a single-user local app, so performance gains from caching don't justify complexity
- **NOTE FOR FUTURE**: If this app is hosted for multiple users, consider implementing:
  - Client-side state management (Vue/Svelte reactivity or simple JS cache)
  - API response caching with cache invalidation
  - WebSocket updates for real-time sync

### Database Schema

**Account**: id, name, account_type, brokerage, beneficiary, custom_type_name, is_retirement_account

**Position**: id, account_id, ticker, name, shares, cost_basis, current_price, sector, is_fund, asset_class, position_type (equity/fund/cash/cd/bond/treasury), maturity_date, interest_rate, purchase_date

**AllocationTrigger**: id, name, condition_type, ticker, account_type, sector, operator, threshold, is_active

**AppSettings**: key, value, encrypted (for API keys)

**FileImport**: id, file_name, content_hash, account_type, status

**PortfolioSnapshot**: id, snapshot_date, total_value, positions_json

**PriceCache**: ticker, current_price, last_updated

### Key Modules

**Database** (`src/database/`):
- `models.py`: SQLAlchemy models (Account, Position, AllocationTrigger, AppSettings, etc.)
- `operations.py`: CRUD + CD maturity checks + database export/import
- `database_manager.py`: Database lifecycle (existence, integrity, initialization, recovery)
- `profile_manager.py`: Multi-database profile support for financial advisors
- `seed_loader.py`: First-time data initialization from CSV/YAML

**Importers** (`src/importers/`):
- `folder_scanner.py`: Auto-detect columns, dynamic folder creation, custom account types

**API** (`src/api/`):
- `portfolio.py`: Portfolio CRUD + cash/CD/real-estate endpoints + account types
- `analysis.py`: Performance, risk, allocation, triggers evaluation, widgets
- `projections.py`: Monte Carlo + year-by-year withdrawal tables
- `settings.py`: App settings, demo mode, personal config
- `imports.py`: File imports + drag-drop upload with AI account detection
- `plugins.py`: Plugin management, marketplace, security
- `profiles.py`: Multi-profile management

**Services** (`src/services/`):
- `ai_config.py`: Centralized Claude model configuration (ANTHROPIC_MODEL env var)
- `secrets.py`: Encrypted API key storage (env var / .env / database)
- `fund_data.py`: Fund metadata via yfinance + Claude API fallback
- `advisor_analysis.py`: AI-powered portfolio analysis and chat advisor
- `commentary_service.py`: AI commentary generation with caching
- `commentary_registry.py`: Dashboard element definitions for AI commentary
- `commentary_prompts.py`: Prompt templates for commentary generation
- `triggers.py`: Trigger evaluation engine
- `demo_mode.py`: Dynamic demo mode switching

**Models** (`src/models/`):
- `account_types.py`: PREDEFINED_ACCOUNT_TYPES dict + helpers
- `position_types.py`: PositionType enum (equity, fund, cash, cd, bond, treasury, real_estate)
- `targets.py`: Allocation targets model

**Projections** (`src/projections/`):
- `engine.py`: MonteCarloEngine + WithdrawalProjection

**Plugins** (`src/plugins/`):
- `base.py`: Base classes for all plugin types
- `registry.py`: Plugin discovery, enabling/disabling
- `events.py`: Event bus for plugin communication
- `import_pipeline.py`: Routes files to importer plugins
- `analysis_pipeline.py`: Runs analysis plugins
- `widget_pipeline.py`: Renders widget plugins
- `security.py`: Permission system and sandboxing
- `installer.py`: Install plugins from Git/ZIP

### Account Types

Predefined types in `src/models/account_types.py`:
```python
PREDEFINED_ACCOUNT_TYPES = {
    "traditional_401k", "roth_401k", "traditional_ira", "roth_ira",
    "hsa", "pension",  # Retirement
    "taxable", "529", "hysa", "checking", "savings", "treasury_direct"  # Non-retirement
}
```

Custom types: `custom:{user_name}` (e.g., "custom:Kids College Fund")

### Position Types

```python
class PositionType(str, Enum):
    EQUITY = "equity"           # Individual stocks
    FUND = "fund"               # ETFs, mutual funds
    CASH = "cash"               # Uninvested cash
    CD = "cd"                   # Certificate of Deposit
    BOND = "bond"               # Individual bonds
    TREASURY = "treasury"       # T-bills, I-bonds
    REAL_ESTATE = "real_estate" # Property (home, rental, land)
```

### Trigger Condition Types

```python
CONDITION_TYPES = {
    "ticker_value": "Position value (dollars)",
    "ticker_percent": "Position as % of portfolio",
    "sector_percent": "Sector as % of portfolio",
    "account_invested_percent": "% of account invested vs cash",
    "total_value": "Total portfolio value",
    "account_value": "Value of account type",
}
```

## Plugin System

The app supports a plugin architecture for extending functionality. See `src/plugins/README.md` for full documentation.

### Plugin Types
- **Importer plugins** - Parse brokerage-specific file formats (Schwab, Fidelity, generic CSV)
- **Analysis plugins** - Custom metrics (dividend tracker, tax-loss harvester)
- **Widget plugins** - Dashboard visualizations (correlation heatmap, sector treemap)

### Built-in Plugins
- `schwab-csv`, `fidelity-csv`, `generic-csv` - File importers
- `dividend-tracker` - Estimated annual dividend income
- `tax-loss-harvester` - Unrealized losses and tax savings opportunities
- `correlation-heatmap` - Position correlation matrix visualization
- `sector-treemap` - Interactive sector allocation treemap

### Plugin Security
- Plugins declare required permissions (file_read, file_write, network, database)
- Third-party plugins with sensitive permissions require user approval
- Sandboxed execution with 30-second timeout

## Demo Mode

Demo mode uses a separate database with fake portfolio data for testing/demonstrations.

### Dynamic Switching
- Toggle via Settings UI (no server restart required)
- State persisted in `data/demo_state.json`
- Remembers last active profile for seamless restore

### Generate Demo Data
```bash
# CLI (Docker - preferred)
docker exec -it portfolio-analyzer python scripts/generate_demo.py

# CLI (local)
python scripts/generate_demo.py

# API
POST /api/settings/demo/generate

# Dashboard
Settings → Demo Mode → Generate Demo Data
```

## Multi-Profile System

For financial advisors managing multiple client portfolios, each profile has its own database.

### Profile Structure
```
data/databases/
├── default/           # Default profile
│   └── portfolio.db
├── client-a/          # Custom profile
│   └── portfolio.db
└── client-b/
    └── portfolio.db
```

### Profile API
- `GET /api/profiles` - List all profiles
- `POST /api/profiles` - Create new profile
- `PUT /api/profiles/active` - Switch active profile
- `DELETE /api/profiles/{id}` - Delete profile

## API Endpoints

### Portfolio
- `GET /api/portfolio` - Summary with retirement metrics
- `GET /api/portfolio/accounts` - List accounts
- `GET /api/portfolio/account-types` - Available types
- `POST /api/portfolio/accounts` - Create account
- `DELETE /api/portfolio/accounts/{id}` - Delete account
- `GET /api/portfolio/positions` - List positions
- `POST /api/portfolio/positions` - Add position
- `PUT /api/portfolio/positions/{id}` - Update position
- `DELETE /api/portfolio/positions/{id}` - Delete position
- `POST /api/portfolio/positions/cash` - Add cash (with optional APY)
- `POST /api/portfolio/positions/cd` - Add CD with maturity date
- `POST /api/portfolio/positions/real-estate` - Add real estate property
- `GET /api/portfolio/positions/cd/upcoming` - Upcoming maturities
- `POST /api/portfolio/positions/cd/check-maturities` - Convert matured CDs

### Analysis
- `GET /api/analysis/performance` - Returns, alpha
- `GET /api/analysis/risk` - Sharpe, VaR, beta
- `GET /api/analysis/allocation` - Basic breakdown
- `GET /api/analysis/allocation/detailed` - xlsm-style detailed
- `GET /api/analysis/triggers` - List triggers
- `POST /api/analysis/triggers` - Create trigger
- `GET /api/analysis/triggers/evaluate` - Evaluate all
- `GET /api/analysis/triggers/triggered` - Active alerts
- `GET /api/analysis/widgets` - Render all widget plugins
- `GET /api/analysis/widgets/{id}` - Render specific widget
- `GET /api/analysis/plugins` - Run all analysis plugins
- `GET /api/analysis/plugins/{id}` - Run specific analysis plugin

### Projections
- `POST /api/projections/monte-carlo` - Retirement simulation
- `POST /api/projections/fire` - FIRE calculation
- `POST /api/projections/withdrawal-table` - Year-by-year table
- `GET /api/projections/withdrawal-comparison` - Compare rates

### Settings & Demo
- `GET /api/settings/config` - Get full configuration
- `PUT /api/settings/config` - Update configuration
- `GET /api/settings/demo-mode` - Get demo mode status
- `PUT /api/settings/demo-mode` - Enable/disable demo mode (dynamic)
- `POST /api/settings/demo/generate` - Generate demo portfolio data
- `POST /api/settings/demo/reset` - Reset demo database
- `GET /api/settings/api-keys/status` - Check API key configuration status

### Imports
- `POST /api/imports/upload` - Drag-drop file upload with AI account detection
- `GET /api/imports/pending` - List pending imports
- `POST /api/imports/process` - Process pending imports
- `GET /api/imports/history` - Import history

### Plugins
- `GET /api/plugins` - List all plugins
- `GET /api/plugins/{id}` - Get plugin details
- `POST /api/plugins/{id}/enable` - Enable plugin
- `POST /api/plugins/{id}/disable` - Disable plugin
- `GET /api/plugins/installed` - List installed third-party plugins
- `POST /api/plugins/install/git` - Install from Git repository
- `POST /api/plugins/install/upload` - Install from ZIP upload
- `DELETE /api/plugins/installed/{id}` - Uninstall plugin
- `GET /api/plugins/security/pending` - Plugins awaiting permission approval

## Security

- **No credentials stored** - API keys encrypted or via environment
- **Database reset requires confirmation** - Type "DELETE ALL DATA"
- **Local SQLite** - All data stored locally
- **Localhost binding** - Server binds to 127.0.0.1 by default

## Configuration Files

- `config.yaml`: Target allocations, Monte Carlo parameters
- `funds.yaml`: Fund metadata cache (populated by Claude API)
- `.env`: Optional API keys and settings

## Claude API Configuration

AI features (fund analysis, portfolio insights, chat advisor, AI commentary) use the Anthropic Claude API.

**Environment Variables:**
```bash
# Required for AI features
ANTHROPIC_API_KEY=your-api-key

# Optional: Select Claude model (default: sonnet)
ANTHROPIC_MODEL=sonnet
```

**Available Models:**
| Alias | Model ID | Use Case |
|-------|----------|----------|
| `opus` | `claude-opus-4-5-20251101` | Complex analysis, highest quality |
| `sonnet` | `claude-sonnet-4-20250514` | Balanced performance/cost (default) |
| `haiku` | `claude-3-5-haiku-20241022` | Fast, simple tasks, lowest cost |

**Model Configuration in Code:**
```python
from src.services.ai_config import get_claude_model, CLAUDE_MODEL_HAIKU

# Get configured model (from ANTHROPIC_MODEL env var or default)
model = get_claude_model()

# Use specific model for lightweight tasks
model = CLAUDE_MODEL_HAIKU
```

The centralized config is in `src/services/ai_config.py`.
