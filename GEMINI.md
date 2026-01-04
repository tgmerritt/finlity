# Investment Portfolio Analyzer - Gemini Context

## Project Overview
This project is a **Python-based investment portfolio tracking and analysis system**. It features a **FastAPI** backend, a **Vanilla JavaScript** frontend (using Plotly.js), and a local **SQLite** database. It is designed for privacy (local data storage) and extensibility (plugin system).

**Key Features:**
*   Multi-account portfolio management (Retirement, Taxable, Custom).
*   Automated CSV/Excel imports.
*   Risk analysis, allocation tracking, and Monte Carlo retirement projections.
*   Plugin system for importers, analyzers, and widgets.
*   Optional AI integration (Anthropic Claude) for fund metadata.

## Architecture

*   **Backend:** Python 3.10+ with FastAPI.
*   **Frontend:** Vanilla JavaScript, HTML, CSS, Plotly.js (no heavy frameworks).
*   **Database:** SQLAlchemy with SQLite (file-based).
*   **Deployment:** Docker (Dev & Prod profiles) and Heroku support.

### Directory Structure
*   `src/` - Main source code.
    *   `api/` - FastAPI route handlers.
    *   `web/` - Static frontend assets (index.html, app.js).
    *   `database/` - Database models and operations.
    *   `plugins/` - Plugin system architecture.
    *   `analysis/` - Financial math and analysis logic.
    *   `projections/` - Monte Carlo and retirement calculators.
*   `data/` - **Git-ignored** directory for user data (DBs, imports).
*   `tests/` - Pytest suite.
*   `scripts/` - Utility scripts (e.g., demo data generation).

## Development Workflow

### 1. Environment Setup
**Option A: Docker (Recommended)**
*   **Dev Mode (Hot Reload):** `docker compose --profile dev up portfolio-dev`
*   **Prod Mode:** `docker compose up -d`

**Option B: Local Python**
*   Create venv: `python3 -m venv .venv` && `source .venv/bin/activate`
*   Install deps: `pip install -r requirements.txt`
*   Run: `python -m src.main`

### 2. Testing & Quality
*   **Tests:** `python -m pytest tests/ -v` (Must pass before commit)
*   **Linting:** `ruff check src/` (Must pass before commit)

### 3. Demo Mode
The application has a built-in demo mode to generate fake data.
*   **Toggle:** `python -m src.main --demo` or via UI settings.
*   **Generate Data:** `python scripts/generate_demo.py`

## Key Commands

| Action | Command |
| :--- | :--- |
| **Start Server** | `python -m src.main` |
| **Run Tests** | `python -m pytest tests/` |
| **Lint Code** | `ruff check src/` |
| **Generate Demo Data** | `python scripts/generate_demo.py` |
| **Create Import Folders** | `python -m src.main --create-folders` |

## Conventions & Standards

*   **Privacy:** All financial data must remain local. No external calls with user data except explicitly configured optional AI features.
*   **Database:** Use `src.database.database_manager.get_database()` to ensure profile awareness. Do not instantiate `Database` directly.
*   **Frontend:** Keep it simple. Vanilla JS. Direct DOM manipulation. Dark mode support via `data-theme` attribute.
*   **Async:** Heavy operations (e.g., Monte Carlo) use a background task system to avoid timeouts (especially on Heroku).
*   **Security:**
    *   Never commit `.env` or data files.
    *   API keys (Anthropic) are stored in the DB or env vars, never code.

## Configuration

*   `config.yaml`: Target allocations and simulation parameters.
*   `funds.yaml`: Cached fund metadata.
*   `.env`: Environment variables (API keys).
