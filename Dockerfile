# Investment Portfolio Analyzer
# Multi-stage build for optimized image size.
#
# Python 3.13-slim-bookworm: EOL Oct 2029, smaller cold-start footprint than
# 3.11, and ships with the perf improvements that benefit FastAPI/uvloop.

# Stage 1: Build frontend with Node.js
FROM node:20-alpine AS frontend-builder

WORKDIR /app/src/web

COPY src/web/package*.json ./
RUN npm ci

COPY src/web/ ./
ENV NODE_ENV=production
RUN npm run build

# Stage 2: Python builder
FROM python:3.13-slim-bookworm AS builder

WORKDIR /app

# Build toolchain stays in this stage only.
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
    && rm -rf /var/lib/apt/lists/*

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

RUN pip install --upgrade pip

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Precompile bytecode so cold starts don't pay the .py→.pyc cost.
RUN python -m compileall -q -b /opt/venv \
    && find /opt/venv -type d -name __pycache__ -prune -exec rm -rf {} +

# Stage 3: Runtime
FROM python:3.13-slim-bookworm AS runtime

WORKDIR /app

# Real-time log output, no on-disk bytecode writes at runtime (builder already
# precompiled everything in /opt/venv).
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PATH="/opt/venv/bin:$PATH"

# git is required for plugin installation from git repositories.
# ca-certificates keeps outbound TLS (Anthropic, yfinance, Finnhub) working.
RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
    && update-ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /opt/venv /opt/venv

# /bin/sh is sufficient - no bash dependency needed in runtime image.
RUN useradd --create-home --shell /bin/sh appuser

COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY config.yaml .
COPY funds.yaml .
COPY pytest.ini .

COPY --from=frontend-builder /app/src/web/dist/ ./src/web/dist/

RUN mkdir -p data/imports data/demo data/cache data/logs \
    && chown -R appuser:appuser /app

COPY --chown=appuser:appuser data/demo/demo.db ./data/demo/

USER appuser

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# PORT is injected by Heroku at runtime; default to 8000 for local docker run.
CMD ["sh", "-c", "python -m src.main --host 0.0.0.0 --port ${PORT:-8000} --no-browser"]
