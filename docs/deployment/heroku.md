# Deploying to Heroku (optional)

This is one way to run Finlity in production. It's not required: any host that can run the Docker image works. The public demo happens to run this way, deployed from the Heroku container registry.

## Heroku deployment

Heroku requires AMD64 images. Building on an Apple Silicon Mac without `--platform` produces an ARM64 image that Heroku rejects at release time.

```bash
docker build --platform linux/amd64 -t registry.heroku.com/<your-app>/web .
docker push registry.heroku.com/<your-app>/web
heroku container:release web --app <your-app>
heroku logs -n 100 --app <your-app>
```

**Provenance / SBOM attestations must stay disabled on this push.** The Heroku container registry rejects manifests that carry them, and a newer Docker Buildx default can re-enable them silently. If a push starts failing with a manifest/attestation error, that is the cause.

## Smart import AI on a public deployment

Smart import can send merchant names (categorize) and PDF lines (extract) to Anthropic with the operator's `ANTHROPIC_API_KEY`. On Heroku (any dyno, where `DYNO` is set) this stays off unless every one of these is set:

| Variable | Value |
|---|---|
| `ANTHROPIC_API_KEY` | The operator's key. |
| `SMART_IMPORT_AI_ENABLED` | `true` to allow AI categories. |
| `SMART_IMPORT_PDF_AI_ENABLED` | `true` to also allow AI reading of unknown PDF layouts. |
| `RATE_LIMIT_ENABLED` | `true`. Required: without an active rate limiter, AI reports unavailable on Heroku. |
| `RATE_LIMIT_SECRET_KEY` | A random string of at least 32 characters. |

The same gate applies to the server-mode routes (`/api/smart-import/categorize`, `/extract`, `/ai-status`) whenever `DYNO` or `MULTI_USER_MODE` is set, on top of each profile's consent setting, because a profile's provider can fall back to the env key there.

With the limiter active, the AI routes share the `RATE_LIMIT_MAX_REQUESTS` per `RATE_LIMIT_WINDOW_SECONDS` window per client IP, and `/api/v2/smart-import/analyze` and `/recurring` each allow 30 requests a minute per client IP in windows of their own. Limits are kept in memory, so they apply per dyno. `SMART_IMPORT_AI_FAKE` (the offline placeholder provider for local check servers) is ignored on Heroku.

## Regenerating `requirements.txt`

`requirements.in` is the curated source of truth (pip-tools). Never hand-edit `requirements.txt`.

```bash
pip install pip-tools
pip-compile --resolver=backtracking --generate-hashes \
    --output-file requirements.txt requirements.in
```

Any new import must be added to `requirements.in` and recompiled before staging. "It's installed locally" is not sufficient: CI and the Heroku image both build from the hashed `requirements.txt`.

## Deploying from GitHub Actions

The `deploy` job in `.github/workflows/test.yml` is off by default so forks don't try to deploy. To enable it in your own repository:

1. Add repository secrets `HEROKU_API_KEY` (a long-lived authorization from `heroku authorizations:create`) and `HEROKU_APP_NAME`.
2. Add a repository variable `HEROKU_DEPLOY` with the value `true` (Settings > Secrets and variables > Actions > Variables).

Pushes to `main` then build and release the container automatically.

## After deploying

CI (`.github/workflows/test.yml`) runs ruff, mypy, pip-audit, bandit, pytest, vitest, vite build, and SBOM generation. Confirm it is green on the pushed commit, then check `heroku logs` for boot errors, especially around `PORTFOLIO_DATA_DIR` and `MULTI_USER_MODE` / `DYNO` gating.
