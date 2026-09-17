# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**Project rename in flight.** The codebase is being rebranded from "Investment Dashboard" / "portfolio-analyzer" to **Finlity**. Production is live at `app.finlity.net`, but the GitHub repo, Docker image names, and Heroku app retain the legacy slugs. Don't be surprised by the inconsistency: both names refer to the same project.

## Security

Always scan code and REMOVE any PII from files checked into git. WARN the user about other security issues during your scan. Do not log account names, balances, or personal identifiers. Never commit `.env`, `data/*.db`, CSV exports, or API keys.

## Codesight (mandatory two-step rule)

This project uses **codesight** for codebase intelligence. **Never write or modify code based solely on wiki content.**

**Step 1, orient.** Use the wiki to find WHERE things live. Read in this order at session start:

1. `.codesight/wiki/index.md` (orientation map, ~200 tokens)
2. `.codesight/wiki/overview.md` (architecture overview, ~500 tokens)
3. The relevant domain article, e.g. `.codesight/wiki/auth.md`, and check its "Source Files" section
4. `.codesight/CODESIGHT.md` for the full context map when exploring deeply

**Step 2, verify.** Read the actual source files listed in the article BEFORE writing any code. Wiki articles are AST-extracted structural summaries: they show routes, models, and file locations, but not full function logic, middleware internals, or dynamic runtime behavior.

Routes marked `[inferred]` were detected via regex; verify them against source before trusting them. If any source file shows ⚠ in the wiki, re-run `npx codesight --wiki` before proceeding. Regenerate with `npx codesight` after significant changes (new routes, models, major refactors).

The codesight MCP server also answers on-demand queries: `codesight_get_wiki_article`, `codesight_get_wiki_index`, `codesight_get_summary`, `codesight_get_routes --prefix /api/users`, `codesight_get_blast_radius --file src/lib/db.ts`, `codesight_get_schema --model users`.

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

```bash
ruff check src/                    # lint — must pass with no errors
python -m pytest tests/ -x -q      # must pass
mypy src/                          # type checks (config: mypy.ini, py3.11 target)
```

Frontend equivalents are the `typecheck`, `test`, `lint`, and `build` scripts in `src/web/package.json`; the authoritative full gate is `.github/workflows/test.yml`.

`tests/conftest.py` sets `PORTFOLIO_DATA_DIR` to a temp dir and forces `PORTFOLIO_DEMO_MODE=true` / `PORTFOLIO_TEST_MODE=true` for the session.

### GitHub Actions

Repo is `tgmerritt/investment_dashboard`. CI runs ruff, mypy, pip-audit, bandit, pytest, vitest, vite build, and SBOM generation.

Cancel running workflows before pushing if iterating quickly:
```bash
gh run list --repo tgmerritt/investment_dashboard --status in_progress
gh run cancel <run_id>
```

### Deployment and dependency pinning

Heroku container release and the `pip-compile` / `requirements.in` workflow live in `.claude/skills/heroku-deploy/SKILL.md`. Two things that bite regardless:

- **Heroku requires AMD64 images.** Always build with `--platform linux/amd64`; ARM64 images are rejected.
- **Provenance/SBOM must stay disabled on the Heroku container push** (commit `4502fb2`): the Heroku registry rejects them.

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

- **Python 3.13** in the Dockerfile (slim-bookworm). `mypy.ini` still targets 3.11 — bump if you touch typing.
- **Path-traversal guard:** every file write/read against user-supplied paths must go through `safe_join()` in `src/utils/paths.py`.
- **Async HTTP:** the FastAPI lifespan creates a single shared `httpx.AsyncClient` on `app.state.http`; reuse it instead of creating per-request clients.
- **CORS:** `get_allowed_origins()` in `src/main.py` — production adds `*.finlity.net`; override with `CORS_ALLOWED_ORIGINS`.

## Budget/Paycheck System

`PayrollTaxCalculator` in `src/budget/tax_calculator.py` supports 2024 brackets for `single`, `married_jointly`, `married_separately`, `head_of_household`. `PaycheckBreakdown` field names are defined there; see the API field mismatch note below before wiring them to the frontend.

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
API responses sometimes use shorter names than the frontend expects (e.g. API returns `gross`, some legacy frontend code expects `gross_pay`). Cross-check the API model in `src/api/*.py` against `src/web/src/types/api.d.ts`.

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

## Environment Variables

`ALPHA_VANTAGE_API_KEY`, `ANTHROPIC_API_KEY`, `CORS_ALLOWED_ORIGINS`, `DYNO`, `ENFORCE_REQUEST_SIGNING`, `FINNHUB_API_KEY`, `GEMINI_API_KEY`, `MULTI_USER_MODE`, `NODE_ENV`, `PORTFOLIO_DATA_DIR`, `PORTFOLIO_DEMO_MODE`, `PORTFOLIO_TEST_MODE`, `PRODUCTION`, `PROTECT_DEMO_DATA`, `RATE_LIMIT_MAX_REQUESTS`, `RATE_LIMIT_WINDOW_SECONDS`, `SECRET_KEY`, `SESSION_TTL_SECONDS`
