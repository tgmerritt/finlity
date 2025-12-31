# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Security Considerations

**IMPORTANT**: This project handles sensitive financial data. When making changes:
- Never commit API keys, database files, or CSV exports
- Never log or print account names, balances, or personal identifiers
- All user data must remain local - no external transmission except optional Claude API
- Check `.gitignore` before committing new file types
- Test with sample data, not real financial information

## Project Overview

Investment portfolio tracking and analysis system with:
- **File-based imports** - CSV/Excel from brokerage exports auto-detected and imported
- **SQLite persistence** - Accounts, positions, triggers, settings stored locally
- **Multi-account support** - Retirement, taxable, 529, HYSA, custom account types
- **Cash & CD tracking** - Track uninvested cash and CDs with maturity dates
- **Allocation triggers** - User-configurable alerts for portfolio conditions
- **Claude API integration** - Optional fund metadata enrichment
- **Year-by-year withdrawal projections** - Detailed retirement planning tables
- **REST API + Web Dashboard** - FastAPI backend with interactive dashboard

## Common Commands

```bash
# Setup
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

# Start the server (opens browser automatically)
python -m src.main

# Server options
python -m src.main --port 8000        # Custom port
python -m src.main --no-browser       # Don't open browser
python -m src.main --reload           # Development mode with auto-reload

# Database management
python -m src.main --reset-database   # Delete all data (requires confirmation)
python -m src.main --export-db backup.json  # Backup to JSON
python -m src.main --import-db backup.json  # Restore from backup
python -m src.main --check-cds        # Check for matured CDs
python -m src.main --create-folders   # Create all import folders
```

## Importing Data

1. Create folders: `python -m src.main --create-folders`
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

**Importers** (`src/importers/`):
- `folder_scanner.py`: Auto-detect columns, dynamic folder creation, custom account types

**API** (`src/api/`):
- `portfolio.py`: Portfolio CRUD + cash/CD endpoints + account types
- `analysis.py`: Performance, risk, allocation, triggers evaluation
- `projections.py`: Monte Carlo + year-by-year withdrawal tables

**Services** (`src/services/`):
- `secrets.py`: Encrypted API key storage (env var / .env / database)
- `fund_data.py`: Fund metadata via yfinance + Claude API fallback
- `triggers.py`: Trigger evaluation engine

**Models** (`src/models/`):
- `account_types.py`: PREDEFINED_ACCOUNT_TYPES dict + helpers
- `position_types.py`: PositionType enum (equity, fund, cash, cd, bond, treasury)

**Projections** (`src/projections/`):
- `engine.py`: MonteCarloEngine + WithdrawalProjection

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
    EQUITY = "equity"      # Individual stocks
    FUND = "fund"          # ETFs, mutual funds
    CASH = "cash"          # Uninvested cash
    CD = "cd"              # Certificate of Deposit
    BOND = "bond"          # Individual bonds
    TREASURY = "treasury"  # T-bills, I-bonds
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

## API Endpoints

### Portfolio
- `GET /api/portfolio` - Summary
- `GET /api/portfolio/accounts` - List accounts
- `GET /api/portfolio/account-types` - Available types
- `POST /api/portfolio/accounts` - Create account
- `GET /api/portfolio/positions` - List positions
- `POST /api/portfolio/positions` - Add position
- `POST /api/portfolio/positions/cash` - Add cash
- `POST /api/portfolio/positions/cd` - Add CD
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

### Projections
- `POST /api/projections/monte-carlo` - Retirement simulation
- `POST /api/projections/fire` - FIRE calculation
- `POST /api/projections/withdrawal-table` - Year-by-year table
- `GET /api/projections/withdrawal-comparison` - Compare rates

## Security

- **No credentials stored** - API keys encrypted or via environment
- **Database reset requires confirmation** - Type "DELETE ALL DATA"
- **Local SQLite** - All data stored locally
- **Localhost binding** - Server binds to 127.0.0.1 by default

## Configuration Files

- `config.yaml`: Target allocations, Monte Carlo parameters
- `funds.yaml`: Fund metadata cache (populated by Claude API)
- `.env`: Optional API keys (ANTHROPIC_API_KEY)
