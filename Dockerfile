# Investment Portfolio Analyzer
# Multi-stage build for optimized image size

FROM python:3.11-slim AS builder

WORKDIR /app

# Install build dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    && rm -rf /var/lib/apt/lists/*

# Create virtual environment
RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Upgrade pip to latest version
RUN pip install --upgrade pip

# Install Python dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt


FROM python:3.11-slim AS runtime

WORKDIR /app

# Install runtime dependencies (git needed for plugin installation from repositories)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# Copy virtual environment from builder
COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:$PATH"

# Create non-root user for security
RUN useradd --create-home --shell /bin/bash appuser

# Copy application code
COPY src/ ./src/
COPY scripts/ ./scripts/
COPY tests/ ./tests/
COPY config.yaml .
COPY funds.yaml .
COPY pytest.ini .

# Create data directories with proper permissions
RUN mkdir -p data/imports data/demo data/cache data/logs \
    && chown -R appuser:appuser /app

# Copy pre-built demo database for out-of-box demo mode
COPY --chown=appuser:appuser data/demo/demo.db ./data/demo/

# Switch to non-root user
USER appuser

# Expose port
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Default command - bind to 0.0.0.0 for container networking
# Use PORT env var for Heroku compatibility, default to 8000
CMD ["sh", "-c", "python -m src.main --host 0.0.0.0 --port ${PORT:-8000} --no-browser"]
