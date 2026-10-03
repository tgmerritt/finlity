# Finlity

[![CI](https://github.com/tgmerritt/finlity/actions/workflows/test.yml/badge.svg)](https://github.com/tgmerritt/finlity/actions/workflows/test.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Finlity is a self-hosted investment portfolio tracker with a FastAPI backend, automated CSV/Excel import, risk-adjusted analytics, allocation triggers, Monte Carlo retirement projections, and an extensible plugin system.

A hosted demo with synthetic data runs at https://app.finlity.net.

> **Privacy Note**: All data is stored locally. No financial information is transmitted to external servers (except optional Claude API for fund metadata enrichment).

## Features

### Portfolio Management
- **Automated File Import** - Drop CSV/Excel files into folders, auto-detected and imported
- **Drag-and-Drop Upload** - Import files directly in the browser with AI-powered account type detection
- **Multi-Account Support** - Track Roth IRA, Traditional 401(k), 529, HYSA, Treasury Direct, and custom account types
- **Multi-Profile System** - Financial advisors can manage separate databases for multiple clients
- **Cash Position Tracking** - Track uninvested cash with optional APY for interest-bearing accounts
- **CD Support** - Track Certificates of Deposit with APY, maturity dates, and automatic interest accrual
- **Real Estate Tracking** - Track property values including home, rental properties, and land
- **Interest Accrual** - Automatic simple interest calculation for CDs and cash with APY
- **Manual Position Entry** - Add positions directly via dashboard or API
- **Demo Mode** - Toggle between real/demo portfolios instantly without server restart

### Account Types
- **Retirement**: Traditional 401(k), Roth 401(k), Traditional IRA, Roth IRA, HSA, Pension
- **Non-Retirement**: Taxable Brokerage, 529 College Savings (with beneficiary), High-Yield Savings, Checking, Savings, Treasury Direct
- **Custom**: Create your own account types with user-defined names

### Analysis
- **Risk Metrics** - Sharpe ratio, Sortino ratio, max drawdown, VaR, CVaR, beta vs S&P 500
- **Allocation Analysis** - Sector, geography, style, and cap-size breakdowns matching xlsm format
- **User-Configurable Triggers** - Alert when allocations exceed thresholds
- **Correlation Matrix** - Interactive correlation heatmap for positions (via plugin)
- **Sector Treemap** - Visual sector allocation breakdown (via plugin)
- **Tax-Loss Harvesting** - Identify positions with unrealized losses for tax optimization
- **Dividend Tracking** - Estimate annual dividend income across holdings

### Projections
- **Monte Carlo Simulations** - 10,000 simulations with black swan/golden swan modeling
- **Year-by-Year Withdrawal Tables** - Detailed projections showing balance, withdrawals, and returns
- **FIRE Calculator** - Calculate your Financial Independence number
- **Withdrawal Rate Comparison** - Compare 3%, 4%, 5% withdrawal scenarios
- **Retirement Dashboard Metrics** - Years to retirement, projected balance, monthly income estimates

### Plugin System
- **Importer Plugins** - Add support for new brokerage file formats
- **Analysis Plugins** - Create custom metrics and insights
- **Widget Plugins** - Build custom dashboard visualizations
- **Security & Sandboxing** - Permission-based system protects your data
- **Marketplace** - Install third-party plugins from Git repositories or ZIP files

### Integration
- **Claude API Integration** - Optional fund metadata enrichment via Anthropic API
- **yfinance Integration** - Automatic price fetching and caching
- **Secure API Key Storage** - Encrypted storage in database or via environment variables

## Installation

### Option 1: Docker (Recommended)

```bash
# Clone the repository
git clone https://github.com/tgmerritt/finlity.git
cd finlity

# Build the Docker image
docker build -t portfolio-analyzer .

# Run the container with persistent data
docker run -d \
  --name portfolio \
  -p 8000:8000 \
  -v $(pwd)/data:/app/data \
  -e ANTHROPIC_API_KEY=your-key-here \
  portfolio-analyzer

# View logs
docker logs -f portfolio

# Stop the container
docker stop portfolio
```

**Using Docker Compose:**

```bash
# Start with docker-compose
docker-compose up -d

# View logs
docker-compose logs -f

# Stop
docker-compose down
```

The dashboard will be available at http://localhost:8000

### Option 2: Local Python

```bash
# Clone the repository
git clone https://github.com/tgmerritt/finlity.git
cd finlity

# Create and activate virtual environment
python3 -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt
```

## Quick Start

```bash
# Activate virtual environment
source .venv/bin/activate

# Create import folders for all account types
python -m src.main --create-folders

# Start the server (opens dashboard in browser)
python -m src.main
```

The dashboard will open at http://127.0.0.1:8000

## Usage

### Starting the Server

```bash
# Default: start server and open browser
python -m src.main

# Specify port and host
python -m src.main --port 8080 --host 0.0.0.0

# Don't open browser automatically
python -m src.main --no-browser

# Enable auto-reload for development
python -m src.main --reload
```

### Importing Positions

1. Create import folders: `python -m src.main --create-folders`
2. Drop CSV/Excel files into the appropriate folder:
   - `data/imports/roth_ira/` - Roth IRA positions
   - `data/imports/traditional_401k/` - 401(k) positions
   - `data/imports/taxable/` - Taxable brokerage
   - `data/imports/529/` - 529 college savings
   - `data/imports/hysa/` - High-yield savings
   - `data/imports/custom_<name>/` - Custom account types

3. Files are automatically imported on server startup

Supported formats:
- CSV files from Schwab, Fidelity, Vanguard (auto-detected)
- Standard CSV with columns: Symbol, Shares, Price
- Excel files (.xlsx, .xls)

### Manual Position Entry

Use the dashboard or API to add positions manually:

```bash
# Create an account
curl -X POST http://localhost:8000/api/portfolio/accounts \
  -H "Content-Type: application/json" \
  -d '{"name": "My Roth IRA", "account_type": "roth_ira", "brokerage": "schwab"}'

# Add a position
curl -X POST http://localhost:8000/api/portfolio/positions \
  -H "Content-Type: application/json" \
  -d '{"account_id": "<account-id>", "ticker": "VTI", "shares": 100, "current_price": 250}'

# Add cash
curl -X POST http://localhost:8000/api/portfolio/positions/cash \
  -H "Content-Type: application/json" \
  -d '{"account_id": "<account-id>", "amount": 5000}'

# Add a CD
curl -X POST http://localhost:8000/api/portfolio/positions/cd \
  -H "Content-Type: application/json" \
  -d '{"account_id": "<account-id>", "amount": 10000, "name": "12-month CD", "interest_rate": 0.05, "maturity_date": "2025-12-01"}'

# Add cash with APY (e.g., high-yield savings)
curl -X POST http://localhost:8000/api/portfolio/positions/cash \
  -H "Content-Type: application/json" \
  -d '{"account_id": "<account-id>", "amount": 5000, "name": "HYSA Cash", "interest_rate": 0.0485}'
```

### Demo Mode

Demo mode allows you to demonstrate the application with fake portfolio data. You can switch between real and demo data **instantly without restarting the server**.

```bash
# Generate demo portfolio data (run once)
python scripts/generate_demo.py

# Or via the dashboard
# Settings → Demo Mode → Generate Demo Data

# Or via API
curl -X POST http://localhost:8000/api/settings/demo/generate
```

**To toggle demo mode:**
- **Dashboard**: Settings → Demo Mode toggle (instant switch)
- **CLI flag**: `python -m src.main --demo`
- **Environment**: `PORTFOLIO_DEMO_MODE=true`

Demo mode creates ~50 realistic positions across 6 account types with real current prices. Your real portfolio is preserved and restored when you disable demo mode.

### Multi-Profile System (Financial Advisors)

Manage multiple client portfolios with separate databases:

```bash
# Create a new profile via API
curl -X POST http://localhost:8000/api/profiles \
  -H "Content-Type: application/json" \
  -d '{"name": "Client A", "description": "Retirement planning client"}'

# Switch active profile
curl -X PUT http://localhost:8000/api/profiles/active \
  -H "Content-Type: application/json" \
  -d '{"profile_id": "client-a"}'

# Or use the dashboard profile switcher in the header
```

Each profile has its own database in `data/databases/{profile_id}/`.

### Database Management

```bash
# Export database to JSON backup
python -m src.main --export-db backup.json

# Import database from backup
python -m src.main --import-db backup.json

# Reset database (delete all data) - requires confirmation
python -m src.main --reset-database

# Check for matured CDs
python -m src.main --check-cds
```

### Allocation Triggers

Create alerts for portfolio conditions:

```bash
# Create a trigger: Alert when AAPL exceeds $50,000
curl -X POST http://localhost:8000/api/analysis/triggers \
  -H "Content-Type: application/json" \
  -d '{"name": "AAPL too high", "condition_type": "ticker_value", "ticker": "AAPL", "operator": ">", "threshold": 50000}'

# Evaluate all triggers
curl http://localhost:8000/api/analysis/triggers/evaluate

# Get only triggered alerts
curl http://localhost:8000/api/analysis/triggers/triggered
```

Condition types:
- `ticker_value` - Position value in dollars
- `ticker_percent` - Position as % of portfolio
- `sector_percent` - Sector as % of portfolio
- `account_invested_percent` - % of account invested (vs cash)
- `total_value` - Total portfolio value
- `account_value` - Value of specific account type

### Withdrawal Projections

```bash
# Generate year-by-year withdrawal table
curl -X POST http://localhost:8000/api/projections/withdrawal-table \
  -H "Content-Type: application/json" \
  -d '{"withdrawal_rate_or_amount": 0.04, "is_percentage": true, "start_age": 65, "end_age": 100}'

# Compare withdrawal rates (3%, 3.5%, 4%, 4.5%, 5%)
curl "http://localhost:8000/api/projections/withdrawal-comparison?start_age=65&end_age=100"
```

## Configuration

### Target Allocations (`config.yaml`)

```yaml
personal:
  dob: "1990-01-01"
  retirement_age: 65

targets:
  asset_class:
    equities: 0.90
    bonds: 0.025
    alternatives: 0.05
    cash: 0.025

  sector:
    technology: 0.41
    healthcare: 0.15
    financials: 0.12
    # ...

monte_carlo:
  num_simulations: 10000
  black_swan_probability: 0.02
  black_swan_impact: -0.40
  golden_swan_probability: 0.02
  golden_swan_impact: 0.27
```

### Fund Compositions (`funds.yaml`)

```yaml
funds:
  VTI:
    name: "Vanguard Total Stock Market ETF"
    morningstar_category: "Large Blend"
    style: "blend"
    market_cap: "large"
    region: "us"
    sector_breakdown:
      Technology: 28.5
      Healthcare: 13.2
      Financials: 12.8
```

### Claude API Configuration (optional)

For AI-powered fund analysis, portfolio insights, and chat advisor:

```bash
# API Key (required for AI features)
# Option 1: Environment variable
export ANTHROPIC_API_KEY=your-key-here

# Option 2: .env file
echo "ANTHROPIC_API_KEY=your-key-here" >> .env

# Option 3: Store in database via API
curl -X POST http://localhost:8000/api/settings/api-key \
  -H "Content-Type: application/json" \
  -d '{"key": "anthropic_api_key", "value": "your-key-here"}'
```

**Model Selection** (optional - defaults to `sonnet`):

```bash
# Set via environment variable
export ANTHROPIC_MODEL=sonnet

# Or in .env file
ANTHROPIC_MODEL=sonnet
```

Available models:
| Alias | Full Model ID | Best For |
|-------|---------------|----------|
| `opus` | `claude-opus-4-5-20251101` | Complex analysis, highest quality |
| `sonnet` | `claude-sonnet-4-20250514` | Balanced performance/cost (default) |
| `haiku` | `claude-3-5-haiku-20241022` | Fast, simple tasks, lowest cost |

You can use either aliases (`opus`, `sonnet`, `haiku`) or full model IDs.

## API Endpoints

### Portfolio
- `GET /api/portfolio` - Portfolio summary with retirement metrics
- `GET /api/portfolio/accounts` - List all accounts
- `GET /api/portfolio/account-types` - Available account types
- `POST /api/portfolio/accounts` - Create account
- `DELETE /api/portfolio/accounts/{id}` - Delete account
- `GET /api/portfolio/positions` - List all positions
- `POST /api/portfolio/positions` - Add position
- `POST /api/portfolio/positions/cash` - Add cash position (with optional APY)
- `POST /api/portfolio/positions/cd` - Add CD position
- `POST /api/portfolio/positions/real-estate` - Add real estate property
- `DELETE /api/portfolio/positions/{id}` - Delete position
- `GET /api/portfolio/positions/cd/upcoming` - CDs maturing soon
- `POST /api/portfolio/positions/cd/check-maturities` - Convert matured CDs

### Analysis
- `GET /api/analysis/performance` - Performance metrics
- `GET /api/analysis/risk` - Risk metrics
- `GET /api/analysis/allocation` - Basic allocation breakdown
- `GET /api/analysis/allocation/detailed` - Detailed allocation (xlsm format)
- `GET /api/analysis/correlation` - Correlation matrix
- `GET /api/analysis/suggestions` - Rebalancing suggestions
- `GET /api/analysis/triggers` - List triggers
- `POST /api/analysis/triggers` - Create trigger
- `GET /api/analysis/triggers/evaluate` - Evaluate all triggers
- `GET /api/analysis/triggers/triggered` - Get triggered alerts
- `GET /api/analysis/widgets` - Render all widget plugins
- `GET /api/analysis/plugins` - Run all analysis plugins

### Projections
- `POST /api/projections/monte-carlo` - Run Monte Carlo simulation
- `POST /api/projections/fire` - Calculate FIRE metrics
- `POST /api/projections/sensitivity` - Sensitivity analysis
- `POST /api/projections/withdrawal-table` - Year-by-year withdrawals
- `GET /api/projections/withdrawal-comparison` - Compare withdrawal rates

### Imports
- `POST /api/imports/upload` - Drag-drop file upload with AI account detection
- `GET /api/imports/pending` - List pending imports
- `POST /api/imports/process` - Process pending imports
- `GET /api/imports/history` - Import history

### Settings & Demo
- `GET /api/settings/config` - Get configuration
- `PUT /api/settings/config` - Update configuration
- `GET /api/settings/demo-mode` - Get demo mode status
- `PUT /api/settings/demo-mode` - Toggle demo mode (no restart needed)
- `POST /api/settings/demo/generate` - Generate demo data

### Profiles
- `GET /api/profiles` - List all profiles
- `POST /api/profiles` - Create new profile
- `PUT /api/profiles/active` - Switch active profile
- `DELETE /api/profiles/{id}` - Delete profile

### Plugins
- `GET /api/plugins` - List all plugins
- `POST /api/plugins/{id}/enable` - Enable plugin
- `POST /api/plugins/{id}/disable` - Disable plugin
- `POST /api/plugins/install/git` - Install from Git repository
- `DELETE /api/plugins/installed/{id}` - Uninstall plugin

## Project Structure

```
finlity/
├── src/
│   ├── main.py               # FastAPI server & CLI
│   ├── api/                   # REST API endpoints
│   │   ├── portfolio.py       # Portfolio CRUD
│   │   ├── analysis.py        # Analysis & triggers
│   │   ├── projections.py     # Monte Carlo & withdrawals
│   │   ├── imports.py         # File imports + drag-drop
│   │   ├── settings.py        # App settings & demo mode
│   │   ├── profiles.py        # Multi-profile management
│   │   └── plugins.py         # Plugin management
│   ├── database/              # SQLite persistence
│   │   ├── models.py          # SQLAlchemy models
│   │   ├── operations.py      # Database operations
│   │   ├── database_manager.py # DB lifecycle management
│   │   ├── profile_manager.py  # Multi-profile support
│   │   └── seed_loader.py     # First-time data loading
│   ├── models/                # Type definitions
│   │   ├── position.py        # Position, Account, Portfolio
│   │   ├── account_types.py   # Predefined account types
│   │   ├── position_types.py  # Position type enum
│   │   └── targets.py         # Allocation targets
│   ├── services/              # External integrations
│   │   ├── secrets.py         # API key management
│   │   ├── fund_data.py       # Fund metadata (Claude/yfinance)
│   │   ├── triggers.py        # Trigger evaluation
│   │   └── demo_mode.py       # Dynamic demo mode switching
│   ├── importers/             # File import
│   │   └── folder_scanner.py  # Auto-detect & import
│   ├── analysis/              # Analytics engine
│   │   ├── performance.py     # Returns, CAGR
│   │   ├── risk.py            # Sharpe, Sortino, VaR
│   │   ├── allocation.py      # Allocation analysis
│   │   └── correlation.py     # Correlation matrix
│   ├── projections/           # Retirement modeling
│   │   └── engine.py          # Monte Carlo & withdrawals
│   ├── plugins/               # Plugin system
│   │   ├── base.py            # Base plugin classes
│   │   ├── registry.py        # Plugin discovery
│   │   ├── events.py          # Event bus
│   │   ├── security.py        # Permission system
│   │   ├── installer.py       # Git/ZIP installation
│   │   ├── import_pipeline.py # Importer routing
│   │   ├── analysis_pipeline.py # Analysis runner
│   │   ├── widget_pipeline.py # Widget renderer
│   │   └── builtin/           # Built-in plugins
│   │       ├── schwab-csv/
│   │       ├── fidelity-csv/
│   │       ├── generic-csv/
│   │       ├── dividend-tracker/
│   │       ├── tax-loss-harvester/
│   │       ├── correlation-heatmap/
│   │       └── sector-treemap/
│   └── web/                   # Dashboard UI
│       ├── index.html         # Single-page dashboard
│       └── style.css          # Styles
├── scripts/
│   └── generate_demo.py       # Demo data generator
├── data/
│   ├── imports/               # Import folders by account type
│   │   ├── roth_ira/
│   │   ├── traditional_401k/
│   │   ├── taxable/
│   │   └── ...
│   ├── databases/             # Profile databases
│   │   ├── default/
│   │   │   └── portfolio.db
│   │   └── {profile-id}/
│   │       └── portfolio.db
│   └── demo/                  # Demo mode database
│       └── demo.db
├── config.yaml                # Target allocations & settings
├── funds.yaml                 # Fund metadata cache
├── .claude/                   # Claude Code configuration
│   └── skills/
│       └── portfolio-analyzer.md
└── requirements.txt
```

## Security

- **No stored credentials** - API keys encrypted in database or via environment variables
- **Database reset requires confirmation** - Type "DELETE ALL DATA" to confirm
- **Local SQLite database** - All data stored locally, never transmitted
- **API keys masked** - Never displayed after entry in the UI
- **Plugin sandboxing** - Third-party plugins run with limited permissions
- **Permission system** - Plugins must declare and receive approval for sensitive operations

**Files excluded from git (see .gitignore):**
- `data/` - Databases, import files, and cache
- `exports/` - CSV exports containing account data
- `.env` - Environment variables and API keys
- `*.db`, `*.sqlite*` - Database files
- `*.csv`, `*.xlsx`, `*.xls` - Spreadsheet files with financial data
- `logs/` - Application logs

## Deployment

Finlity can optionally be deployed to Heroku as a container. See `docs/deployment/heroku.md` for details.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines and our [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). If you discover a security vulnerability, please report it privately per [SECURITY.md](SECURITY.md) rather than opening a public issue.

## Disclaimer

Finlity is not financial, tax, or investment advice. Projections and calculations (Monte Carlo simulations, tax estimates, and similar outputs) are estimates provided for informational purposes only.

## License

Finlity is released under the [MIT License](LICENSE).
