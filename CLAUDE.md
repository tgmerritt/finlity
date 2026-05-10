# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**Project rename in flight.** The codebase is being rebranded from "Investment Dashboard" / "portfolio-analyzer" to **Finlity**. Production is live at `app.finlity.net`, but the GitHub repo, Docker image names, and Heroku app retain the legacy slugs. Don't be surprised by the inconsistency — both names refer to the same project.

## Codesight

This project uses **codesight** for codebase intelligence. Always consult codesight context before writing or modifying code:

1. Read `.codesight/wiki/index.md` first (orientation map)
2. Read `.codesight/wiki/overview.md` (architecture overview)
3. Read the relevant domain wiki article, then verify by reading the actual source files listed in it

After making significant changes (new routes, models, major refactors), regenerate codesight:

```bash
npx codesight
```

The wiki articles show routes, models, and file locations extracted by AST. They do **not** show full function logic — always read source files before writing code. Routes marked `[inferred]` should be verified against source.

## Claude Code Features (v2.1+)

- `/skills` — list available skills
- `@agent-name` — invoke custom agents (e.g., `@markdown-expert`)
- `/plan`, `/context`, `/permissions`, `/rewind`
- `Alt+T` (toggle thinking), `Ctrl+R` (history), `Ctrl+B` (background long-running task)
- Skills auto-reload when modified — no restart needed

## Security

Always scan code and REMOVE any PII from files checked into git. WARN the user about other security issues during your scan. Do not log account names, balances, or personal identifiers. Never commit `.env`, `data/*.db`, CSV exports, or API keys.

## Project Identity

| Item | Value |
|------|-------|
| **Public name** | Finlity |
| **Production URL** | `https://app.finlity.net` |
| **GitHub repo** | `tgmerritt/investment_dashboard` (legacy slug) |
| **Heroku app** | `investment-dashboard-app` (legacy slug) |
| **Docker images** | `portfolio-analyzer:latest` (prod), `portfolio-analyzer-dev` (dev container) |
| **Author** | Tyler Merritt (tgmerritt@gmail.com) |

## Quick Reference

```bash
# Backend dev (hot reload via Docker bind-mount on src/)
docker compose --profile dev up portfolio-dev

# Production-style local
docker compose down && docker compose build && docker compose up -d

# Run a one-off in the dev container
docker exec -it portfolio-analyzer-dev python -m pytest tests/ -v
docker exec -it portfolio-analyzer-dev python scripts/generate_demo.py

# Frontend dev (TypeScript / Vite — runs on :5173, proxies /api → :8000)
cd src/web && npm install && npm run dev

# Logs
docker compose logs -f
```

## Important Workflows

### Pre-commit Checks (REQUIRED before pushing)

Backend:
```bash
ruff check src/                    # lint — must pass with no errors
python -m pytest tests/ -x -q      # 133 tests; must pass
mypy src/                          # type checks (config: mypy.ini, py3.11 target)
```

Frontend:
```bash
cd src/web
npm run typecheck                  # tsc --noEmit
npm test                           # vitest — 50 tests; must pass
npm run lint                       # eslint
NODE_ENV=production npm run build  # ~240ms; smoke-check chunk splitting
```

### GitHub Actions
Repo is `tgmerritt/investment_dashboard`. CI runs ruff, mypy, pip-audit, bandit, pytest, vitest, vite build, and SBOM generation.

Cancel running workflows before pushing if iterating quickly:
```bash
gh run list --repo tgmerritt/investment_dashboard --status in_progress
gh run cancel <run_id>
```

### Regenerating `requirements.txt`
`requirements.in` is the curated source of truth (pip-tools).
```bash
pip install pip-tools
pip-compile --resolver=backtracking --generate-hashes \
    --output-file requirements.txt requirements.in
```

### Heroku Deployment
- App URL: `investment-dashboard-app-e0832c614c7f.herokuapp.com`
- Heroku requires AMD64 images:
  ```bash
  docker build --platform linux/amd64 -t registry.heroku.com/investment-dashboard-app/web .
  docker push registry.heroku.com/investment-dashboard-app/web
  heroku container:release web --app investment-dashboard-app
  heroku logs -n 100 --app investment-dashboard-app
  ```
- **Provenance/SBOM**: disabled on the Heroku container push (recent commit `4502fb2`); Heroku registry rejects them.

## Project Overview

Investment portfolio tracking and analysis system:
- **Portfolio Management** — multi-account (retirement, taxable, 529, HYSA, custom)
- **Budget & Income** — paycheck calc, expenses, cash flow
- **Tax Projections** — lifetime burden, withdrawal strategies
- **Monte Carlo** — retirement probability (async on Heroku)
- **Plugin System** — extensible importers, analyzers, dashboard widgets
- **Multi-profile** — separate databases per profile/family
- **Multi-user mode** — session-based (gated by `MULTI_USER_MODE` / `DYNO`)
- **Demo Mode** — toggle real/demo data without restart
- **AI Commentary** — optional Claude-generated insights stored in DB

## Architecture

### Source Tree

```
src/
├── api/           # FastAPI routers
├── analysis/      # allocation, performance, risk, correlation
├── budget/        # tax_calculator, payroll, social security
├── dashboard/     # generator + chart helpers (server-side)
├── data/          # prices, fund_lookup
├── database/      # SQLAlchemy models, operations, profile_manager
├── history/       # snapshot tracker
├── importers/     # FolderScanner, FileImporter
├── middleware/    # rate_limit, security_headers, session
├── models/        # account_types, position_types, targets
├── plugins/       # plugin pipelines (import/analysis/widget) + builtin/
├── projections/   # Monte Carlo engine
├── services/      # background_tasks, commentary_service, fund_data, secrets, session, providers/
├── utils/         # paths.safe_join (path-traversal guard)
└── web/           # TypeScript frontend (see below)
```

### API Routers (`src/api/`)

| Module | Purpose |
|--------|---------|
| `portfolio.py` | Accounts, positions, cash/CD/real-estate |
| `analysis.py` | Performance, risk, allocation, triggers |
| `budget.py` | Income sources, expenses, paycheck |
| `projections.py` | Monte Carlo, FIRE, withdrawal tables, tax projections |
| `imports.py` | File ingestion, folder scanning |
| `entities.py` | Real-world entities (companies, funds) |
| `profiles.py` | Multi-profile management (create/switch DBs) |
| `plugins.py` | Plugin lifecycle (install, enable, configure) |
| `tasks.py` | Background task polling endpoint |
| `commentary.py` | AI-generated commentary cache |
| `inference.py` | Claude API proxy (uses `app.state.http`) |
| `session.py` | Multi-user session management |
| `settings.py` | Config, demo mode, API keys |
| `dependencies.py` | Shared FastAPI deps — use `get_db()` here, never construct `Database()` |

### Database Models (`src/database/models.py`)

`Entity`, `FileImport`, `Account`, `Position`, `PortfolioSnapshot`, `PriceCache`, `AppSettings`, `AllocationTrigger`, `PortfolioView`, `MonteCarloResult`, `BudgetIncomeSource`, `BudgetTaxConfig`, `BudgetExpenseCategory`, `BudgetExpense`, `BudgetPretaxDeduction`, `AICommentary`.

- **Profile-aware**: always use `get_database()` from `src.database`, never `Database()` directly.
- **Demo mode**: separate database at `data/demo/demo.db`.
- **Profiles**: each profile has its own DB under `data/databases/<profile>/`.

### Middleware (`src/middleware/`)

- `RateLimitMiddleware` — per-IP rate limiting
- `SecurityHeadersMiddleware` — OWASP headers, HSTS only on HTTPS
- `SessionMiddleware` — multi-user session cookies (only when `MULTI_USER_MODE` / `DYNO`)

### Background Task System (Heroku 30s timeout)

```python
# In API endpoint
task_id = str(uuid.uuid4())
background_tasks[task_id] = {"status": "running", "result": None}
thread = Thread(target=run_task, args=(task_id, params))
thread.start()
return {"task_id": task_id, "status": "running"}

# Frontend polls GET /api/tasks/{task_id} until complete
```

Age-based cleanup runs in `src/services/background_tasks.py`.

## Frontend (TypeScript + Vite)

**Stack:** TypeScript (ES2022, strict), Vite, Vitest, ESLint + Prettier. Plotly.js loaded via CDN. No React/Vue framework — direct DOM manipulation through typed UI helpers.

```
src/web/
├── src/
│   ├── api/        # client.ts, with-api-call.ts (DRY API wrapper)
│   ├── charts/     # allocation, budget, projections, plotly-utils
│   ├── database/   # client-database, local-api (browser-side storage)
│   ├── features/   # commentary, entities, import-export, onboarding, plugins, profiles, social-feed, views
│   ├── pages/      # dashboard, holdings, analysis, budget, projections, settings
│   ├── state/      # session, store, theme
│   ├── types/      # api.d.ts, external.d.ts
│   ├── ui/         # tabs, modal, table, template, toast, loading
│   └── utils/      # format, html
├── test/           # vitest specs (mirror src/ layout)
├── package.json    # scripts: dev, build, typecheck, test, test:watch, lint
├── tsconfig.json
├── vite.config.ts  # manualChunks split by page/feature/shared
└── vitest.config.ts
```

**Module aliases:** import from `@/...` which resolves to `src/web/src/`.

**Build behavior:**
- Output goes to `src/web/dist/` (entry: `app.js`, chunks under `chunks/`).
- Sourcemaps **only in dev** (production strips ~744 KB of `.map` files).
- `manualChunks` splits the bundle into `page-*`, `feature-*`, and `shared` chunks so changing one page does not bust the cache for the rest. Production `app.js` is ~8 KB (gzip ~3.25 KB).
- Dockerfile builds the frontend in a separate Node 20 stage, then copies `dist/` into the Python image.

**Design system:** GitHub Primer color palette (commit `07b1b09` redesign). All UI must have proper contrast in **both** light and dark modes — test hover states, tooltips, and chart elements in each theme. Dark mode flag: `document.documentElement.getAttribute('data-theme') === 'dark'`.

**API field gotcha:** API responses sometimes use shorter names than the frontend expects (e.g., API returns `gross`, some legacy frontend code expects `gross_pay`). Check `src/api/*.py` against `src/web/src/types/api.d.ts`.

## Plugin System

See `docs/PLUGIN_ARCHITECTURE.md` for the full design.

**Builtin plugins** (`src/plugins/builtin/`):
- Importers: `schwab-csv`, `fidelity-csv`, `generic-csv`
- Analyzers: `tax-loss-harvester`, `dividend-tracker`
- Widgets: `sector-treemap`, `correlation-heatmap`

**Plugin manifest** (`manifest.yaml` per plugin):
```yaml
name, version, description, author, license
plugin_type: importer | analyzer | widget
main: <module>.py
class: <ClassName>
permissions:
  file_read: bool
  file_write: bool
  network: bool
  database: read_only | read_write | none
```

**Pipelines** in `src/plugins/`: `import_pipeline.py`, `analysis_pipeline.py`, `widget_pipeline.py`. Plugin discovery and registration via `registry.py`; permissions enforced in `security.py`.

## Multi-Profile / Multi-User

- **Profile manager** (`src/database/profile_manager.py`): each profile gets its own SQLite DB under `data/databases/<profile>/`. Switch via `/api/profiles`.
- **Multi-user mode**: gated by `MULTI_USER_MODE=true` (auto-on with `DYNO` Heroku env). Adds `SessionMiddleware` and login-required gating; demo data is protected via `PROTECT_DEMO_DATA`.
- Always use `get_database()` so the profile-active DB is selected.

## Tooling Notes

- **Python 3.13** in the Dockerfile (slim-bookworm). `mypy.ini` still targets 3.11 — bump if you touch typing.
- **Path-traversal guard:** every file write/read against user-supplied paths must go through `safe_join()` in `src/utils/paths.py`.
- **Async HTTP:** the FastAPI lifespan creates a single shared `httpx.AsyncClient` on `app.state.http`; reuse it instead of creating per-request clients.
- **CORS:** `get_allowed_origins()` in `src/main.py` — production adds `*.finlity.net`; override with `CORS_ALLOWED_ORIGINS`.

## Budget/Paycheck System

### `PaycheckBreakdown` API fields

```python
{
    "gross": float,                     # frontend may expect "gross_pay"
    "federal_income_tax": float,
    "social_security": float,           # frontend may expect "social_security_tax"
    "medicare": float,                  # frontend may expect "medicare_tax"
    "additional_medicare": float,
    "state_income_tax": float,
    "total_pretax_deductions": float,   # frontend may expect "pretax_deductions"
    "net_pay": float,
    "total_taxes": float,
    "total_fica": float,
}
```

`PayrollTaxCalculator` in `src/budget/tax_calculator.py` supports 2024 brackets for `single`, `married_jointly`, `married_separately`, `head_of_household`.

## Common Issues & Fixes

### Docker architecture mismatch on Heroku
Heroku rejects ARM64 images. Always:
```bash
docker build --platform linux/amd64 -t registry.heroku.com/investment-dashboard-app/web .
```

### Frontend changes not appearing
- Production Docker bakes `dist/` into the image — rebuild after a frontend change.
- Dev container does **not** hot-reload TypeScript automatically. Run `npm run dev` in `src/web/` separately and let Vite proxy `/api` to the FastAPI dev container.

### API field name mismatches
Cross-check the API model in `src/api/*.py` against `src/web/src/types/api.d.ts`.

### NaN / undefined in charts
Add null guards (`value || 0`) and validate API responses before accessing nested properties.

### Stale prices blocking dashboard init
Recent fix (`55eb50c`): the stale-price refresh runs in the background — do not re-block dashboard init on it.

## Claude API Configuration

```bash
ANTHROPIC_API_KEY=your-api-key
ANTHROPIC_MODEL=sonnet  # or opus, haiku
```

| Alias | Model | Use case |
|-------|-------|----------|
| `opus` | claude-opus-4-5-20251101 | Complex analysis, deep reasoning |
| `sonnet` | claude-sonnet-4-20250514 | Default, balanced |
| `haiku` | claude-haiku-4-5-20250929 | Fast, cost-effective |

Inference goes through `src/api/inference.py` using the shared `app.state.http` client.

## Testing

Backend (133 tests):
```bash
docker exec portfolio-analyzer-dev python -m pytest tests/ -v
docker exec portfolio-analyzer-dev python -m pytest tests/test_api_budget.py -v
```

Frontend (50 tests):
```bash
cd src/web && npm test
cd src/web && npm run test:coverage
```

`tests/conftest.py` sets `PORTFOLIO_DATA_DIR` to a temp dir and forces `PORTFOLIO_DEMO_MODE=true` / `PORTFOLIO_TEST_MODE=true` for the session.

All tests must pass before committing.


# finlity — Project Context

**Stack:** fastapi | sqlalchemy | python

182 routes | 18 models | 27 env vars | 71 import links

**API areas:** /performance, /risk, /expense-drag, /allocation, /correlation, /suggestions, /allocation/detailed, /triggers/types, /triggers, /triggers/{trigger_id}

**High-impact files** (change carefully):
- /base.py (imported by 12 files)
- /operations.py (imported by 4 files)
- /registry.py (imported by 4 files)
- /models.py (imported by 3 files)
- /state_taxes.py (imported by 2 files)

**Required env vars:** ALPHA_VANTAGE_API_KEY, ANTHROPIC_API_KEY, CORS_ALLOWED_ORIGINS, DYNO, ENFORCE_REQUEST_SIGNING, FINNHUB_API_KEY, GEMINI_API_KEY, MULTI_USER_MODE, NODE_ENV, PORTFOLIO_DATA_DIR, PORTFOLIO_DEMO_MODE, PORTFOLIO_TEST_MODE, PRODUCTION, PROTECT_DEMO_DATA, RATE_LIMIT_MAX_REQUESTS, RATE_LIMIT_WINDOW_SECONDS, SECRET_KEY, SESSION_TTL_SECONDS

---

## Instructions for Claude Code

### Two-Step Rule (mandatory)
**Step 1 — Orient:** Use wiki articles to find WHERE things live.
**Step 2 — Verify:** Read the actual source files listed in the wiki article BEFORE writing any code.

Wiki articles are structural summaries extracted by AST. They show routes, models, and file locations.
They do NOT show full function logic, middleware internals, or dynamic runtime behavior.
**Never write or modify code based solely on wiki content — always read source files first.**

Read in order at session start:
1. `.codesight/wiki/index.md` — orientation map (~200 tokens)
2. `.codesight/wiki/overview.md` — architecture overview (~500 tokens)
3. Domain article (e.g. `.codesight/wiki/auth.md`) → check "Source Files" section → read those files
4. `.codesight/CODESIGHT.md` — full context map for deep exploration

Routes marked `[inferred]` in wiki articles were detected via regex — verify against source before trusting.
If any source file shows ⚠ in the wiki, re-run `npx codesight --wiki` before proceeding.

Or use the codesight MCP server for on-demand queries:
   - `codesight_get_wiki_article` — read a specific wiki article by name
   - `codesight_get_wiki_index` — get the wiki index
   - `codesight_get_summary` — quick project overview
   - `codesight_get_routes --prefix /api/users` — filtered routes
   - `codesight_get_blast_radius --file src/lib/db.ts` — impact analysis before changes
   - `codesight_get_schema --model users` — specific model details

Only open specific files after consulting codesight context. This saves ~136,300 tokens per conversation.