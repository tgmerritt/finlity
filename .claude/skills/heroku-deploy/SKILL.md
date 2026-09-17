---
name: heroku-deploy
description: Release Finlity to Heroku (container registry) and regenerate pinned requirements.txt with pip-compile. Use when deploying, cutting a release, debugging a rejected Heroku push, or adding/updating a Python dependency.
---

# Finlity: Heroku release + dependency pinning

Production is `app.finlity.net`, served by the Heroku app `investment-dashboard-app` (legacy slug; the repo is `tgmerritt/investment_dashboard`).

## Heroku deployment

App URL: `investment-dashboard-app-e0832c614c7f.herokuapp.com`

Heroku requires AMD64 images. Building on an Apple Silicon Mac without `--platform` produces an ARM64 image that Heroku rejects at release time.

```bash
docker build --platform linux/amd64 -t registry.heroku.com/investment-dashboard-app/web .
docker push registry.heroku.com/investment-dashboard-app/web
heroku container:release web --app investment-dashboard-app
heroku logs -n 100 --app investment-dashboard-app
```

**Provenance / SBOM attestations must stay disabled on this push** (commit `4502fb2`). The Heroku container registry rejects manifests that carry them, and a newer Docker Buildx default can re-enable them silently. If a push starts failing with a manifest/attestation error, that is the cause.

## Regenerating `requirements.txt`

`requirements.in` is the curated source of truth (pip-tools). Never hand-edit `requirements.txt`.

```bash
pip install pip-tools
pip-compile --resolver=backtracking --generate-hashes \
    --output-file requirements.txt requirements.in
```

Any new import must be added to `requirements.in` and recompiled before staging. "It's installed locally" is not sufficient: CI and the Heroku image both build from the hashed `requirements.txt`.

## After deploying

CI (`.github/workflows/test.yml`) runs ruff, mypy, pip-audit, bandit, pytest, vitest, vite build, and SBOM generation. Confirm it is green on the pushed commit, then check `heroku logs` for boot errors, especially around `PORTFOLIO_DATA_DIR` and `MULTI_USER_MODE` / `DYNO` gating.
