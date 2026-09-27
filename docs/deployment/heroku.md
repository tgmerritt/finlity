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
