# Contributing to Finlity

Thanks for your interest in Finlity. This is a self-hosted investment portfolio tracker, and contributions from the community are welcome, whether that's a bug fix, a new plugin, a documentation improvement, or a feature idea.

## Ways to Contribute

- **Bug reports**: file an issue using the bug report template.
- **Feature requests**: file an issue using the feature request template.
- **Code**: fix a bug, add a feature, improve test coverage, or clean up a rough edge.
- **Plugins**: Finlity ships with a plugin system for widgets and analysis modules. See `docs/PLUGIN_ARCHITECTURE.md` before building one, it explains the extension points and how plugins are packaged.
- **Documentation**: README clarifications, setup instructions, or docs for anything that's confusing.

## Never Commit Real Financial Data

This is the single most important rule in this repo. Finlity is designed to store sensitive financial data locally, and none of it should ever end up in the public GitHub history.

- **Never commit real `.db` files.** Every SQLite database in this repo must be demo data or a fresh, empty schema.
- **Never commit brokerage CSV or Excel exports**, even as test fixtures, unless they have been fully synthesized. Real export files often contain account numbers, balances, and holdings that identify a real person.
- **Never commit screenshots of real portfolios.** For screenshots in issues, PRs, or documentation, use demo mode.
- **Use demo mode for fixtures and screenshots.** Run `scripts/generate_demo.py` to produce synthetic portfolio data. Use that output for any example, fixture, or screenshot you need.
- **Never commit `.env` files or API keys.** Copy `.env.example` to `.env` locally and keep it out of git (it already is, but double check before force-adding anything).

If you're not sure whether something you're about to commit contains real data, ask first in the issue or PR rather than pushing it.

## Development Setup

You can develop with Docker or with a local Python/Node environment.

### Docker (recommended for backend work)

```bash
docker compose --profile dev up portfolio-dev
```

This runs the backend with hot reload, mounting `src/`, `scripts/`, `config.yaml`, and `funds.yaml` so edits take effect without a rebuild.

### Local Python

```bash
python -m venv venv
source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
python -m src.main
```

API keys in `.env` are optional. Without them, price fetching falls back to `yfinance` and AI-powered features show as unavailable rather than failing.

### Frontend

```bash
cd src/web
npm install
npm run dev
```

Vite serves the frontend on `:5173` and proxies `/api` requests to the backend on `:8000`, so run both at once when working on frontend changes that hit real endpoints.

## Running Checks

Run these before opening a PR. CI (`.github/workflows/test.yml`) runs the same checks, so it's faster to catch problems locally.

**Backend:**

```bash
ruff check src/
python -m pytest tests/ -x -q
mypy src/
```

**Frontend** (from `src/web/`):

```bash
npm run typecheck
npm run test
npm run lint
npm run build
```

## Dependency Changes

Python dependencies are pinned with `pip-compile`. Don't hand-edit `requirements.txt` directly:

1. Edit `requirements.in`.
2. Regenerate: `pip-compile requirements.in -o requirements.txt`.
3. Commit both files.

## Branch Naming

Use a prefix that describes the kind of change:

- `feat/` for new features
- `fix/` for bug fixes
- `docs/` for documentation-only changes
- `chore/` for maintenance, tooling, or dependency updates

## Commit Messages

Write commit messages that explain *why* a change was made, not just what changed. "Fix off-by-one in Monte Carlo year loop" is more useful than "Update montecarlo.py".

## Pull Request Process

1. Keep PRs small and focused on one thing. Large, sprawling PRs are hard to review and hard to revert if something goes wrong.
2. Add or update tests for the behavior you're changing.
3. Make sure CI is green before requesting review.
4. Fill out the PR template, including the checklist. Don't skip the "no real financial data" checkbox, it matters.
5. Be responsive to review feedback; this is a volunteer-maintained project, so review turnaround may take a few days.

## Licensing

Finlity is licensed under the MIT License. By submitting a contribution, you agree that it is licensed under the same terms (inbound = outbound). There is no separate contributor license agreement to sign.
