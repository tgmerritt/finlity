# AGENTS.md

This file provides guidance to AI coding assistants (Claude Code, Gemini, and others) when working with code in this repository.

## Status

Docker image/container names still use the legacy `portfolio-analyzer` slug.

## Security

Always scan code and REMOVE any PII from files checked into git. WARN the user about other security issues during your scan. Do not log account names, balances, or personal identifiers. Never commit `.env`, `data/*.db`, CSV exports, or API keys.

## Codesight (optional)

Contributors may optionally run `npx codesight --wiki` to generate a local `.codesight/` codebase map (gitignored, not checked in). If present, it's useful for orientation, but it is an AST-extracted structural summary: it shows routes, models, and file locations, not full function logic, middleware internals, or dynamic runtime behavior. Always read the actual source files before writing code; never rely on the wiki alone.

## Project Identity

| Item | Value |
|------|-------|
| **Public name** | Finlity |
| **Hosted demo** | `https://app.finlity.net` (synthetic data only) |
| **GitHub repo** | `tgmerritt/finlity` |
| **Docker images** | `portfolio-analyzer:latest` (prod), `portfolio-analyzer-dev` (dev container) |
| **Heroku deployment** | see `docs/deployment/heroku.md` |

## Quick Reference

```bash
# Backend dev (hot reload via Docker bind-mount on src/)
docker compose --profile dev up portfolio-dev

# Production-style local
docker compose down && docker compose build && docker compose up -d

# Run a one-off in the dev container
docker exec -it portfolio-analyzer-dev python -m pytest tests/ -v
docker exec -it portfolio-analyzer-dev python scripts/generate_demo.py

# Frontend dev (TypeScript / Vite, runs on :5173, proxies /api to :8000)
cd src/web && npm install && npm run dev

# Logs
docker compose logs -f
```

## Important Workflows

### Pre-commit Checks (REQUIRED before pushing)

```bash
ruff check src/                    # lint: must pass with no errors
python -m pytest tests/ -x -q      # must pass
mypy src/                          # type checks (config: mypy.ini, py3.11 target)
```

Frontend equivalents are the `typecheck`, `test`, `lint`, and `build` scripts in `src/web/package.json`; the authoritative full gate is `.github/workflows/test.yml`.

`tests/conftest.py` sets `PORTFOLIO_DATA_DIR` to a temp dir and forces `PORTFOLIO_DEMO_MODE=true` / `PORTFOLIO_TEST_MODE=true` for the session.

### GitHub Actions

Repo is `tgmerritt/finlity`. CI runs ruff, mypy, pip-audit, bandit, pytest, vitest, vite build, and SBOM generation.

Cancel running workflows before pushing if iterating quickly:
```bash
gh run list --repo tgmerritt/finlity --status in_progress
gh run cancel <run_id>
```

### Deployment and dependency pinning

Heroku container release and the `pip-compile` / `requirements.in` workflow live in `docs/deployment/heroku.md`. Two things that bite regardless:

- **Heroku requires AMD64 images.** Always build with `--platform linux/amd64`; ARM64 images are rejected.
- **Provenance/SBOM must stay disabled on the Heroku container push**: the Heroku registry rejects them.

## Architecture

### Database access

- **Profile-aware**: always use `get_database()` from `src.database`, never `Database()` directly.
- In FastAPI routes use `get_db()` from `src/api/dependencies.py`, never construct `Database()`.
- **Demo mode**: separate database at `data/demo/demo.db`.
- **Profiles**: each profile has its own DB under `data/databases/<profile>/`.

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

## Frontend

The TypeScript/Vite frontend lives in `src/web/`; see `src/web/CLAUDE.md` for build behavior, chunking, and design-system rules.

## Plugin System

See `docs/PLUGIN_ARCHITECTURE.md` for the full design. Pipelines live in `src/plugins/` (`import_pipeline.py`, `analysis_pipeline.py`, `widget_pipeline.py`); discovery and registration via `registry.py`; permissions enforced in `security.py`. Builtin plugins are under `src/plugins/builtin/`, each with a `manifest.yaml`.

## Multi-Profile / Multi-User

- **Profile manager** (`src/database/profile_manager.py`): each profile gets its own SQLite DB under `data/databases/<profile>/`. Switch via `/api/profiles`.
- **Multi-user mode**: gated by `MULTI_USER_MODE=true` (auto-on with `DYNO` Heroku env). Adds `SessionMiddleware` and login-required gating; demo data is protected via `PROTECT_DEMO_DATA`.
- Always use `get_database()` so the profile-active DB is selected.

## Tooling Notes

- **Python 3.13** in the Dockerfile (slim-bookworm). `mypy.ini` still targets 3.11, bump it if you touch typing.
- **Path-traversal guard:** every file write/read against user-supplied paths must go through `safe_join()` in `src/utils/paths.py`.
- **Async HTTP:** the FastAPI lifespan creates a single shared `httpx.AsyncClient` on `app.state.http`; reuse it instead of creating per-request clients.
- **CORS:** `get_allowed_origins()` in `src/main.py`: production adds `*.finlity.net`; override with `CORS_ALLOWED_ORIGINS`.

## Budget/Paycheck System

`PayrollTaxCalculator` in `src/budget/tax_calculator.py` supports 2024 brackets for `single`, `married_jointly`, `married_separately`, `head_of_household`. `PaycheckBreakdown` field names are defined there; see the API field mismatch note below before wiring them to the frontend.

## Common Issues & Fixes

### Docker architecture mismatch on Heroku
Heroku rejects ARM64 images. Always:
```bash
docker build --platform linux/amd64 -t registry.heroku.com/<your-app>/web .
```

### Frontend changes not appearing
- Production Docker bakes `dist/` into the image, rebuild after a frontend change.
- Dev container does **not** hot-reload TypeScript automatically. Run `npm run dev` in `src/web/` separately and let Vite proxy `/api` to the FastAPI dev container.

### API field name mismatches
API responses sometimes use shorter names than the frontend expects (e.g. API returns `gross`, some legacy frontend code expects `gross_pay`). Cross-check the API model in `src/api/*.py` against `src/web/src/types/api.d.ts`.

### Stale prices blocking dashboard init
The stale-price refresh runs in the background, do not re-block dashboard init on it.

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

## Environment Variables

`ALPHA_VANTAGE_API_KEY`, `ANTHROPIC_API_KEY`, `CORS_ALLOWED_ORIGINS`, `DYNO`, `ENFORCE_REQUEST_SIGNING`, `FINNHUB_API_KEY`, `GEMINI_API_KEY`, `MULTI_USER_MODE`, `NODE_ENV`, `PORTFOLIO_DATA_DIR`, `PORTFOLIO_DEMO_MODE`, `PORTFOLIO_TEST_MODE`, `PRODUCTION`, `PROTECT_DEMO_DATA`, `RATE_LIMIT_ENABLED`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_SECRET_KEY`, `RATE_LIMIT_WINDOW_SECONDS`, `SECRET_KEY`, `SESSION_TTL_SECONDS`, `SMART_IMPORT_AI_ENABLED`, `SMART_IMPORT_AI_FAKE`, `SMART_IMPORT_PDF_AI_ENABLED`

Smart import AI on Heroku (`DYNO` set) needs `ANTHROPIC_API_KEY`, `SMART_IMPORT_AI_ENABLED` (and `SMART_IMPORT_PDF_AI_ENABLED` for PDF extract) and an active rate limiter (`RATE_LIMIT_ENABLED=true` plus a 32+ character `RATE_LIMIT_SECRET_KEY`); otherwise it reports unavailable. See `docs/deployment/heroku.md`.
