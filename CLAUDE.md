# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Security

Always scan code and REMOVE any PII from files checked in to git - WARN the user about any other security issues during your scan.

## Project Identity

| Item | Value |
|------|-------|
| **GitHub Repo** | `tgmerritt/investment_dashboard` |
| **Docker Container (dev)** | `portfolio-analyzer-dev` |
| **Heroku App** | `investment-dashboard-app` |
| **Author** | Tyler Merritt (tgmerritt@gmail.com) |

## Quick Reference

```bash
# Development (hot reload - use this for active development)
docker compose --profile dev up portfolio-dev

# Production (rebuild required for changes)
docker compose down && docker compose build && docker compose up -d

# Run commands in container (use portfolio-analyzer-dev for dev mode)
docker exec -it portfolio-analyzer-dev python -m pytest tests/ -v
docker exec -it portfolio-analyzer-dev python scripts/generate_demo.py

# View logs
docker compose logs -f
```

## Important Workflows

### GitHub Actions
- **Repo**: `tgmerritt/investment_dashboard`
- **Cancel running workflows before pushing** if making frequent changes
- Use: `gh run list --repo tgmerritt/investment_dashboard --status in_progress` then `gh run cancel <run_id>`

### Pre-commit Checks (REQUIRED before pushing)
```bash
# ALWAYS run these before git push:
ruff check src/                    # Linter - must pass with no errors
python -m pytest tests/ -x -q      # Tests - must pass
```

### Heroku Deployment
- App URL: `investment-dashboard-app-e0832c614c7f.herokuapp.com`
- Build for AMD64: `docker build --platform linux/amd64 -t registry.heroku.com/investment-dashboard-app/web .`
- Push: `docker push registry.heroku.com/investment-dashboard-app/web`
- Release: `heroku container:release web --app investment-dashboard-app`
- Logs: `heroku logs -n 100 --app investment-dashboard-app`

### Development vs Production Docker
- **Dev mode**: `docker compose --profile dev up portfolio-dev` - mounts `src/` for hot reload
- **Prod mode**: `docker compose up -d` - files baked into image, requires rebuild

## Project Overview

Investment portfolio tracking and analysis system with:
- **Portfolio Management** - Multi-account support (retirement, taxable, 529, HYSA, custom types)
- **Budget & Income** - Paycheck calculations, expense tracking, cash flow analysis
- **Tax Projections** - Lifetime tax burden analysis with withdrawal strategies
- **Monte Carlo Simulations** - Retirement probability analysis (async on Heroku)
- **Plugin System** - Extensible importers, analyzers, and dashboard widgets
- **Demo Mode** - Toggle between real/demo data without restart

## Architecture

### Key Directories
```
src/
├── api/           # FastAPI endpoints (portfolio, analysis, budget, projections, etc.)
├── budget/        # Tax calculator, Social Security estimator
├── database/      # SQLAlchemy models, operations, profile manager
├── plugins/       # Plugin system (importers, analyzers, widgets)
├── projections/   # Monte Carlo engine
├── services/      # AI config, secrets, fund data, triggers
└── web/           # Frontend (index.html, app.js, style.css)
```

### API Structure
| Module | Purpose |
|--------|---------|
| `portfolio.py` | Accounts, positions, cash/CD/real-estate |
| `analysis.py` | Performance, risk, allocation, triggers |
| `budget.py` | Income sources, expenses, paycheck calculations |
| `projections.py` | Monte Carlo, FIRE, withdrawal tables, tax projections |
| `settings.py` | Config, demo mode, API keys |

### Background Task System (Heroku)
Heroku has a 30-second request timeout. Long-running operations use async tasks:

```python
# In API endpoint
task_id = str(uuid.uuid4())
background_tasks[task_id] = {"status": "running", "result": None}
thread = Thread(target=run_task, args=(task_id, params))
thread.start()
return {"task_id": task_id, "status": "running"}

# Frontend polls GET /api/tasks/{task_id} until complete
```

### Database
- **Profile-aware**: Always use `get_database()` from `src.database`, never `Database()` directly
- **Source of truth**: Database is authoritative once it exists
- **Demo mode**: Separate database at `data/demo/demo.db`

### Frontend Patterns
- **Vanilla JS + Plotly.js** - No framework, direct DOM manipulation
- **Dark mode**: Check `document.documentElement.getAttribute('data-theme') === 'dark'`
- **CSS CONTRAST RULE**: All UI elements MUST have proper contrast in both light and dark modes. Test hover states, tooltips, and chart elements in both themes.
- **API field mapping**: Some API responses use different field names than frontend expects (e.g., `gross` vs `gross_pay`)

## Budget/Paycheck System

### API Response Fields (PaycheckBreakdown)
```python
{
    "gross": float,              # Frontend may expect "gross_pay"
    "federal_income_tax": float,
    "social_security": float,    # Frontend may expect "social_security_tax"
    "medicare": float,           # Frontend may expect "medicare_tax"
    "additional_medicare": float,
    "state_income_tax": float,
    "total_pretax_deductions": float,  # Frontend may expect "pretax_deductions"
    "net_pay": float,
    "total_taxes": float,
    "total_fica": float
}
```

### Tax Calculator (`src/budget/tax_calculator.py`)
- `PayrollTaxCalculator`: Federal/state/FICA tax calculations
- `PaycheckBreakdown`: Dataclass with all paycheck details
- Supports 2024 tax brackets for single/married_jointly/married_separately/head_of_household

## Common Issues & Fixes

### Docker Architecture Mismatch
Heroku requires AMD64 images. If app crashes on Heroku:
```bash
docker build --platform linux/amd64 -t registry.heroku.com/investment-dashboard-app/web .
```

### CSS Not Updating
In production Docker mode, files are baked in. Use dev mode or rebuild:
```bash
docker compose --profile dev up portfolio-dev  # For development
```

### API Field Name Mismatches
Frontend code may expect different field names than API returns. Check both:
- API: `src/api/*.py` and related models
- Frontend: `src/web/app.js`

### NaN/Undefined Errors
Add null checks: `value || 0` and validate API responses before accessing nested properties.

## Security

- **Never commit**: API keys, database files, CSV exports
- **Never log**: Account names, balances, personal identifiers
- **Local storage**: All data stays local except optional Claude API calls
- **API keys**: Use `ANTHROPIC_API_KEY` env var or encrypted database storage

## Claude API Configuration

```bash
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_MODEL=sonnet  # or opus, haiku
```

| Alias | Model | Use Case |
|-------|-------|----------|
| `opus` | claude-opus-4-5-20251101 | Complex analysis |
| `sonnet` | claude-sonnet-4-20250514 | Default, balanced |
| `haiku` | claude-3-5-haiku-20241022 | Fast, simple tasks |

## Testing

```bash
# Run all tests
docker exec portfolio-analyzer python -m pytest tests/ -v

# Run specific test file
docker exec portfolio-analyzer python -m pytest tests/test_api_budget.py -v
```

All tests should pass before committing
